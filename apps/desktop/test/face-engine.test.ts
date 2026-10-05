import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { FaceEngine, restoreFaceBounds } from '../src/service/face-engine.ts'
import type { DetectedFace } from '../src/service/face-engine.ts'

test('离线模型能从示例照片提取归一化人物特征，空白图无命中',async()=>{
  const engine=new FaceEngine(join(process.cwd(),'models'))
  try {
    assert.equal((await engine.ready()).ready,true)
    const sample=join(process.cwd(),'design','layout-preview','assets','family-demo.png')
    const first=await engine.detect(sample),second=await engine.detect(sample)
    assert.ok(first.length>0)
    assert.equal(first.length,second.length)
    for(let i=0;i<first.length;i++) {
      assert.equal(first[i].id,`face-${i}`)
      assert.equal(first[i].reviewRequired,undefined)
      assert.equal(first[i].embedding.length,128)
      assert.ok(Math.abs(first[i].embedding.reduce((sum,value)=>sum+value*value,0)-1)<1e-5)
      assert.ok(first[i].x>=0&&first[i].x+first[i].width<=1)
      assert.ok(first[i].y>=0&&first[i].y+first[i].height<=1)
      assert.ok(first[i].embedding.reduce((sum,value,n)=>sum+value*second[i].embedding[n],0)>0.999)
    }
    const directory=join(process.cwd(),'.cache','tests',randomUUID());await mkdir(directory,{recursive:true})
    const blank=join(directory,'blank.png')
    await writeFile(blank,await sharp({create:{width:320,height:240,channels:3,background:'#eeeeee'}}).png().toBuffer())
    assert.equal((await engine.detect(blank)).length,0)
  } finally {await engine.close()}
})

test('四分之一圈旋转的人脸框还原到原图，边缘坐标保持合法',()=>{
  const expected={x:0.1,y:0.2,width:0.3,height:0.4}
  const cases=[
    {rotation:90 as const,face:{x:0.4,y:0.1,width:0.4,height:0.3}},
    {rotation:180 as const,face:{x:0.6,y:0.4,width:0.3,height:0.4}},
    {rotation:270 as const,face:{x:0.2,y:0.6,width:0.4,height:0.3}}
  ]
  for(const {rotation,face} of cases) {
    const actual=restoreFaceBounds(face,rotation)
    for(const key of ['x','y','width','height'] as const) assert.ok(Math.abs(actual[key]-expected[key])<1e-10,`${rotation} 度的 ${key} 应还原`)
    const edge=restoreFaceBounds({x:0.2,y:0.1,width:0.8,height:0.9},rotation)
    assert.ok(edge.x>=0&&edge.y>=0&&edge.x+edge.width<=1&&edge.y+edge.height<=1)
  }
})

/** 按变换后的位置一一对应人脸，不依赖检测置信度改变后的数组顺序。 */
function matchByGeometry(original:DetectedFace[],transformed:DetectedFace[],position:(face:DetectedFace)=>{x:number;y:number}) {
  const pairs=original.flatMap((face,i)=>{
    const expected=position(face)
    return transformed.map((candidate,j)=>({i,j,distance:Math.hypot(expected.x-candidate.x-candidate.width/2,expected.y-candidate.y-candidate.height/2)}))
  }).sort((left,right)=>left.distance-right.distance)
  const usedOriginal=new Set<number>(),usedTransformed=new Set<number>()
  return pairs.filter(pair=>{
    if(usedOriginal.has(pair.i)||usedTransformed.has(pair.j))return false
    usedOriginal.add(pair.i);usedTransformed.add(pair.j)
    return true
  })
}

test('离线模型在同图亮度、缩放与轻微旋转变体中保留对应人脸特征',async context=>{
  const engine=new FaceEngine(join(process.cwd(),'models'))
  const sample=join(process.cwd(),'design','layout-preview','assets','family-demo.png')
  const directory=join(process.cwd(),'.cache','tests',randomUUID());await mkdir(directory,{recursive:true})
  try {
    const metadata=await sharp(sample).metadata(),original=await engine.detect(sample)
    assert.ok(metadata.width&&metadata.height&&original.length>0)
    const variants=[
      {name:'brightness-0.8',brightness:0.8,rotation:0,scale:1,minimumSimilarity:0.8},
      {name:'brightness-1.2',brightness:1.2,rotation:0,scale:1,minimumSimilarity:0.8},
      {name:'resize-half',brightness:1,rotation:0,scale:0.5,minimumSimilarity:0.9},
      {name:'rotate-5',brightness:1,rotation:5,scale:1,minimumSimilarity:0.5},
      {name:'rotate-minus-5',brightness:1,rotation:-5,scale:1,minimumSimilarity:0.5}
    ]
    for(const variant of variants) {
      let image=sharp(sample)
      if(variant.brightness!==1)image=image.modulate({brightness:variant.brightness})
      if(variant.scale!==1)image=image.resize({width:Math.round(metadata.width*variant.scale)})
      if(variant.rotation)image=image.rotate(variant.rotation,{background:'#eeeeee'})
      const path=join(directory,`${variant.name}.png`);await image.png().toFile(path)
      const transformedMetadata=await sharp(path).metadata(),transformed=await engine.detect(path)
      assert.ok(transformedMetadata.width&&transformedMetadata.height)
      assert.equal(transformed.length,original.length,`${variant.name} 应检出全部示例人脸`)
      const angle=variant.rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle)
      const matches=matchByGeometry(original,transformed,face=>{
        if(!variant.rotation)return {x:face.x+face.width/2,y:face.y+face.height/2}
        const x=(face.x+face.width/2)*metadata.width!-metadata.width!/2
        const y=(face.y+face.height/2)*metadata.height!-metadata.height!/2
        return {x:(x*cos-y*sin+transformedMetadata.width!/2)/transformedMetadata.width!,y:(x*sin+y*cos+transformedMetadata.height!/2)/transformedMetadata.height!}
      })
      assert.equal(matches.length,original.length)
      const similarities=matches.map(match=>{
        assert.ok(match.distance<0.04,`${variant.name} 的几何对应应足够接近`)
        const left=original[match.i].embedding,right=transformed[match.j].embedding
        return left.reduce((sum,value,i)=>sum+value*right[i],0)
      })
      context.diagnostic(`${variant.name}：${matches.length} 张对应人脸，最低余弦相似度 ${Math.min(...similarities).toFixed(4)}`)
      assert.ok(similarities.every(score=>score>=variant.minimumSimilarity),`${variant.name} 的同图变体相似度应保持稳定`)
    }
  } finally {await engine.close()}
})

test('离线模型补查横躺和倒置人脸，框映回照片方向且补查结果需确认',async context=>{
  const engine=new FaceEngine(join(process.cwd(),'models'))
  const sample=join(process.cwd(),'design','layout-preview','assets','family-demo.png')
  const directory=join(process.cwd(),'.cache','tests',randomUUID());await mkdir(directory,{recursive:true})
  try {
    const sampleMetadata=await sharp(sample).metadata(),sampleFaces=await engine.detect(sample)
    assert.ok(sampleMetadata.width&&sampleMetadata.height&&sampleFaces.length>=3)
    // 既有示例中的三个局部在对应方向上无标准命中，可真实覆盖三个补查入口。
    for(const {rotation,index} of [{rotation:90 as const,index:0},{rotation:180 as const,index:1},{rotation:270 as const,index:2}]) {
      const seed=sampleFaces[index]
      const left=Math.max(0,Math.floor((seed.x-seed.width*0.75)*sampleMetadata.width))
      const top=Math.max(0,Math.floor((seed.y-seed.height*0.75)*sampleMetadata.height))
      const width=Math.min(sampleMetadata.width-left,Math.ceil(seed.width*2.5*sampleMetadata.width))
      const height=Math.min(sampleMetadata.height-top,Math.ceil(seed.height*2.5*sampleMetadata.height))
      const portrait=join(directory,`portrait-${index}.png`)
      await sharp(sample).extract({left,top,width,height}).png().toFile(portrait)
      const original=await engine.detect(portrait)
      assert.ok(original.length>0&&original.every(face=>face.reviewRequired===undefined))
      const path=join(directory,`rotate-${rotation}.png`)
      await sharp(portrait).rotate(rotation).png().toFile(path)
      const transformed=await engine.detect(path)
      assert.equal(transformed.length,original.length,`${rotation} 度应找回示例中的全部人脸并去重`)
      assert.ok(transformed.every(face=>face.reviewRequired===true),`${rotation} 度补查结果应要求确认`)
      const matches=matchByGeometry(original,transformed,face=>{
        const x=face.x+face.width/2,y=face.y+face.height/2
        return rotation===90?{x:1-y,y:x}:rotation===180?{x:1-x,y:1-y}:{x:y,y:1-x}
      })
      assert.equal(matches.length,original.length)
      for(const match of matches) {
        const face=transformed[match.j]
        assert.ok(match.distance<0.04,`${rotation} 度补查框应映回原照片方向`)
        assert.ok(face.x>=0&&face.y>=0&&face.x+face.width<=1&&face.y+face.height<=1)
        assert.ok(face.score>=0.75)
        assert.ok(original[match.i].embedding.reduce((sum,value,i)=>sum+value*face.embedding[i],0)>0.9,`${rotation} 度应保留对应人物特征`)
      }
      context.diagnostic(`${rotation} 度补查：${transformed.length} 张去重人脸，坐标和特征有效`)
      if(rotation===90) {
        const oriented=join(directory,'portrait-exif.jpg')
        await sharp(portrait).rotate(90).withMetadata({orientation:8}).jpeg({quality:100}).toFile(oriented)
        const corrected=await engine.detect(oriented)
        assert.equal(corrected.length,original.length,'先按 EXIF 恢复的正向照片应保留原检测数量')
        assert.ok(corrected.every(face=>face.reviewRequired===undefined),'EXIF 矫正后的标准命中无需旋转补查确认')
        const correctedMatches=matchByGeometry(original,corrected,face=>({x:face.x+face.width/2,y:face.y+face.height/2}))
        assert.ok(correctedMatches.every(match=>match.distance<0.04),'EXIF 矫正后的坐标应按实际预览方向保存')
      }
    }
  } finally {await engine.close()}
})
