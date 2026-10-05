import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { faceThreadCandidates, selectFaceThreads } from './face-performance.ts'

export interface DetectedFace {
  id: string; x: number; y: number; width: number; height: number; score: number; embedding: number[]; reviewRequired?: boolean
}
interface FaceBounds { x: number; y: number; width: number; height: number }
interface Detection extends FaceBounds { score: number; landmarks: number[] }
const detectorSize = 640
const alignmentPoints = [[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],[41.5493,92.3655],[70.7299,92.2041]]

/** 以五官位置拟合相似变换，避免不同角度裁剪改变人物特征。 */
export function similarityTransform(points: number[]): { a: number; b: number; tx: number; ty: number } {
  if (points.length !== 10 || points.some(value => !Number.isFinite(value))) throw new Error('人脸关键点无效。')
  const sx = points.filter((_value,index) => index % 2 === 0).reduce((sum,value) => sum+value,0)/5
  const sy = points.filter((_value,index) => index % 2 === 1).reduce((sum,value) => sum+value,0)/5
  const dx = alignmentPoints.reduce((sum,point) => sum+point[0],0)/5
  const dy = alignmentPoints.reduce((sum,point) => sum+point[1],0)/5
  let denominator=0, real=0, imaginary=0
  for(let i=0;i<5;i++) {
    const x=points[i*2]-sx, y=points[i*2+1]-sy, u=alignmentPoints[i][0]-dx, v=alignmentPoints[i][1]-dy
    denominator+=x*x+y*y; real+=x*u+y*v; imaginary+=x*v-y*u
  }
  if (denominator<1e-6) throw new Error('人脸关键点过近。')
  const a=real/denominator, b=imaginary/denominator
  if(a*a+b*b<1e-8) throw new Error('人脸对齐失败。')
  return {a,b,tx:dx-a*sx+b*sy,ty:dy-b*sx-a*sy}
}

/** 将顺时针旋转后的归一化人脸框还原到原图方向。 */
export function restoreFaceBounds(face:FaceBounds,rotation:90|180|270):FaceBounds {
  const restored=rotation===90?{x:face.y,y:1-face.x-face.width,width:face.height,height:face.width}
    :rotation===180?{x:1-face.x-face.width,y:1-face.y-face.height,width:face.width,height:face.height}
    :{x:1-face.y-face.height,y:face.x,width:face.height,height:face.width}
  const x=Math.max(0,Math.min(1,restored.x)),y=Math.max(0,Math.min(1,restored.y))
  return {x,y,width:Math.max(0,Math.min(1-x,restored.width)),height:Math.max(0,Math.min(1-y,restored.height))}
}

function intersectionOverUnion(left:FaceBounds,right:FaceBounds):number {
  const width=Math.max(0,Math.min(left.x+left.width,right.x+right.width)-Math.max(left.x,right.x))
  const height=Math.max(0,Math.min(left.y+left.height,right.y+right.height)-Math.max(left.y,right.y))
  const overlap=width*height
  return overlap/(left.width*left.height+right.width*right.height-overlap)
}

/** YuNet 输入采用 BGR，SFace 按官方实现采用 RGB，两者均保留 0—255。 */
function channelsFirst(rgb:Buffer,width:number,height:number,bgr:boolean):Float32Array {
  const area=width*height, result=new Float32Array(area*3)
  for(let i=0;i<area;i++) {
    result[i]=rgb[i*3+(bgr?2:0)]; result[area+i]=rgb[i*3+1]; result[area*2+i]=rgb[i*3+(bgr?0:2)]
  }
  return result
}

function align(rgb:Buffer,width:number,height:number,points:number[]):Float32Array {
  const {a,b,tx,ty}=similarityTransform(points), determinant=a*a+b*b
  const result=new Float32Array(3*112*112)
  const pixel=(x:number,y:number,c:number):number => x<0||y<0||x>=width||y>=height?0:rgb[(y*width+x)*3+c]
  for(let y=0;y<112;y++) for(let x=0;x<112;x++) {
    const u=x-tx,v=y-ty,sx=(a*u+b*v)/determinant,sy=(-b*u+a*v)/determinant
    const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy
    for(let c=0;c<3;c++) result[c*112*112+y*112+x]=
      pixel(ix,iy,c)*(1-fx)*(1-fy)+pixel(ix+1,iy,c)*fx*(1-fy)+pixel(ix,iy+1,c)*(1-fx)*fy+pixel(ix+1,iy+1,c)*fx*fy
  }
  return result
}

/** CPU 模型只读取本地文件；特征向量仅存于本机，不传给界面或联网服务。 */
export class FaceEngine {
  private detector?: ort.InferenceSession
  private recognizer?: ort.InferenceSession
  private initialization?: Promise<void>
  private modelError=''
  constructor(private modelDirectory:string,private performanceCachePath?:string) {}

  /** 每个测速配置独立创建和释放会话，避免闲置线程干扰下一组测速。 */
  private async createSessions(threads:number):Promise<{detector:ort.InferenceSession;recognizer:ort.InferenceSession}> {
    const options:ort.InferenceSession.SessionOptions={executionProviders:['cpu'],intraOpNumThreads:threads,interOpNumThreads:1,logSeverityLevel:3}
    const detector=await ort.InferenceSession.create(join(this.modelDirectory,'face_detection_yunet_2023mar.onnx'),options)
    try {
      const recognizer=await ort.InferenceSession.create(join(this.modelDirectory,'face_recognition_sface_2021dec.onnx'),options)
      return {detector,recognizer}
    } catch(error) {await detector.release();throw error}
  }

  /** 只用内存合成输入短测两个模型，不读取照片、不生成相册或人脸记录。 */
  private async measureThreads(threads:number):Promise<number[]> {
    const sessions=await this.createSessions(threads)
    try {
      const detectorInput=new ort.Tensor('float32',new Float32Array(3*detectorSize*detectorSize).fill(127),[1,3,detectorSize,detectorSize])
      const recognizerInput=new ort.Tensor('float32',new Float32Array(3*112*112).fill(127),[1,3,112,112])
      const samples:number[]=[]
      for(let index=0;index<5;index++) {
        const started=performance.now()
        await sessions.detector.run({[sessions.detector.inputNames[0]]:detectorInput})
        await sessions.recognizer.run({[sessions.recognizer.inputNames[0]]:recognizerInput})
        if(index>=2) samples.push(performance.now()-started)
      }
      return samples
    } finally {await sessions.detector.release();await sessions.recognizer.release()}
  }

  private async initialize():Promise<void> {
    if(!this.initialization) this.initialization=(async()=>{
      const manifest=JSON.parse(await readFile(join(this.modelDirectory,'manifest.json'),'utf8')) as {filename:string;sha256:string;size:number}[]
      for(const filename of ['face_detection_yunet_2023mar.onnx','face_recognition_sface_2021dec.onnx']) {
        const entry=manifest.find(item=>item.filename===filename)
        if(!entry) throw new Error('本地模型清单不完整。')
        const bytes=await readFile(join(this.modelDirectory,filename))
        if(bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256) throw new Error('本地模型校验失败，请重新安装程序。')
      }
      // 最多使用四个计算线程，少核设备预留界面和传输资源，避免过多线程互相争抢。
      const parallelism=availableParallelism()
      const key=createHash('sha256').update(JSON.stringify({policy:1,cpu:cpus().map(cpu=>cpu.model),parallelism,memory:totalmem(),platform:process.platform,arch:process.arch,runtime:ort.env.versions.node,models:manifest.map(entry=>[entry.filename,entry.sha256])})).digest('hex')
      const threads=await selectFaceThreads(key,faceThreadCandidates(parallelism),value=>this.measureThreads(value),this.performanceCachePath)
      const sessions=await this.createSessions(threads)
      this.detector=sessions.detector;this.recognizer=sessions.recognizer
    })().catch((error:unknown)=>{this.modelError=error instanceof Error?error.message:'本地模型不可用。';throw error})
    await this.initialization
  }

  async ready():Promise<{ready:boolean;error:string}> {
    try {await this.initialize();return {ready:true,error:''}} catch {return {ready:false,error:this.modelError}}
  }

  /** 先查照片原方向，未发现人脸时在内存补查其余直角方向。 */
  async detect(path:string):Promise<DetectedFace[]> {
    await this.initialize()
    const image=await sharp(path,{limitInputPixels:100_000_000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).removeAlpha().toColourspace('srgb').raw().toBuffer({resolveWithObject:true})
    const {width,height}=image.info
    const standard=await this.detectImage(image.data,width,height)
    if(standard.length) return standard
    // 无脸时复用已解码像素补查横躺或倒置人脸，补查结果必须人工确认。
    const candidates:DetectedFace[]=[]
    for(const rotation of [90,180,270] as const) {
      const rotated=await sharp(image.data,{raw:{width,height,channels:3}}).rotate(rotation).raw().toBuffer({resolveWithObject:true})
      const faces=await this.detectImage(rotated.data,rotated.info.width,rotated.info.height)
      for(const face of faces) {
        const bounds=restoreFaceBounds(face,rotation)
        if(bounds.width>0&&bounds.height>0) candidates.push({...face,...bounds,reviewRequired:true})
      }
    }
    candidates.sort((left,right)=>right.score-left.score)
    const selected:DetectedFace[]=[]
    for(const candidate of candidates) {
      if(selected.every(existing=>intersectionOverUnion(existing,candidate)<0.3)) selected.push({...candidate,id:`face-${selected.length}`})
      if(selected.length>=30) break
    }
    return selected
  }

  /** 在给定方向上检测并提取特征，旋转补查复用同一套阈值和模型。 */
  private async detectImage(rgb:Buffer,width:number,height:number):Promise<DetectedFace[]> {
    const scaled=await sharp(rgb,{raw:{width,height,channels:3}}).resize(detectorSize,detectorSize,{fit:'contain',position:'left top',background:{r:0,g:0,b:0}}).raw().toBuffer()
    const input=new ort.Tensor('float32',channelsFirst(scaled,detectorSize,detectorSize,true),[1,3,detectorSize,detectorSize])
    const output=await this.detector!.run({[this.detector!.inputNames[0]]:input})
    const detections:Detection[]=[]
    for(const stride of [8,16,32]) {
      const cls=output[`cls_${stride}`].data as Float32Array,obj=output[`obj_${stride}`].data as Float32Array
      const boxes=output[`bbox_${stride}`].data as Float32Array,points=output[`kps_${stride}`].data as Float32Array
      const columns=detectorSize/stride
      for(let i=0;i<cls.length;i++) {
        const score=Math.sqrt(Math.max(0,Math.min(1,cls[i]))*Math.max(0,Math.min(1,obj[i])))
        if(score<0.75) continue
        const row=Math.floor(i/columns),column=i%columns,w=Math.exp(boxes[i*4+2])*stride,h=Math.exp(boxes[i*4+3])*stride
        if(!Number.isFinite(w+h)||w<12||h<12) continue
        const landmarks=Array.from({length:10},(_value,n)=>(points[i*10+n]+(n%2?row:column))*stride)
        detections.push({x:(column+boxes[i*4])*stride-w/2,y:(row+boxes[i*4+1])*stride-h/2,width:w,height:h,score,landmarks})
      }
    }
    detections.sort((a,b)=>b.score-a.score)
    const selected:Detection[]=[]
    for(const candidate of detections) {
      if(selected.every(existing=>intersectionOverUnion(existing,candidate)<0.3)) selected.push(candidate)
      if(selected.length>=30) break
    }
    const scale=Math.min(detectorSize/width,detectorSize/height),results:DetectedFace[]=[]
    for(const face of selected) {
      const landmarks=face.landmarks.map(value=>value/scale)
      const values=align(rgb,width,height,landmarks)
      const features=await this.recognizer!.run({[this.recognizer!.inputNames[0]]:new ort.Tensor('float32',values,[1,3,112,112])})
      const vector=Array.from(features[this.recognizer!.outputNames[0]].data as Float32Array)
      const magnitude=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0))
      if(!Number.isFinite(magnitude)||magnitude===0) continue
      const x=Math.max(0,Math.min(1,face.x/scale/width)),y=Math.max(0,Math.min(1,face.y/scale/height))
      results.push({id:`face-${results.length}`,x,y,width:Math.min(1-x,face.width/scale/width),height:Math.min(1-y,face.height/scale/height),score:face.score,embedding:vector.map(value=>value/magnitude)})
    }
    return results
  }

  async close():Promise<void> {await this.detector?.release();await this.recognizer?.release()}
}
