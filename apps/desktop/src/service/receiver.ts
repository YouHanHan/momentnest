import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto'
import { constants, createReadStream, realpathSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Socket } from 'node:net'
import { copyFile, link, lstat, mkdir, open, readFile, readdir, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative } from 'node:path'
import { hostname } from 'node:os'
import { generate } from 'selfsigned'
import { Store } from './store.ts'
import { LanAccess } from './lan.ts'
import { archiveName, canonicalDirectory, contentIdentity, hashFile, mediaExtensions, mediaKind, localDate, RequestError, requireValue, safePath, textValue, validDate } from './files.ts'
import { MediaCatalog } from './media-catalog.ts'
import type { FamilySyncRequest } from '../shared/family.ts'
import type { Batch, Device, Library, Location, Receipt, ScanRoot, UploadSession } from './types.ts'

const now=()=>new Date().toISOString()
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex')
const chunkLimit=4*1024**2

/** 独立工作线程中的接收服务，所有成功状态以校验后的持久化回执为准。 */
export class Receiver {
  readonly store: Store
  readonly family: MediaCatalog
  readonly receiverId: string
  server?: Server
  port=0
  accepting=true
  fingerprint=''
  private pairing?: {secret:string;expiresAt:number}
  private pairAttempts=new Map<string,{count:number;since:number}>()
  private locks=new Map<string,Promise<unknown>>()
  private scanning=false
  private closing=false
  private scans:Promise<void>[]=[]
  private activeRequests=0
  private requestsDrained?:()=>void
  private lan=new LanAccess()
  constructor(readonly dataDirectory:string, modelDirectory?:string) {
    this.store=new Store(join(dataDirectory,'receiver.sqlite'))
    const config=this.store.get<{id:string;receiverId:string;accepting:boolean}>('config','main')
    this.receiverId=config?.receiverId ?? randomUUID()
    this.family=new MediaCatalog(this.store,dataDirectory,this.receiverId,modelDirectory,undefined,(key,action)=>this.serial(key,action))
    this.accepting=config?.accepting ?? true
    this.saveConfig()
    if (!this.store.get('workspace','current-library')) {
      const library=this.store.list<Library>('library').find(item=>item.enabled)
      this.store.put('workspace',{id:'current-library',libraryId:library?.id??null})
    }
    for (const root of this.store.list<ScanRoot>('root')) {
      if (root.state==='scanning') this.store.put('root',{...root,state:'interrupted',error:'上次扫描被中断，请重新扫描。'})
    }
  }
  private saveConfig():void { this.store.put('config',{id:'main',receiverId:this.receiverId,accepting:this.accepting} as {id:string}) }
  /** 当前库只影响新操作；已有批次与导入计划继续使用各自冻结的目标。 */
  get currentLibraryId():string|null {
    return this.store.get<{id:string;libraryId:string|null}>('workspace','current-library')?.libraryId??null
  }
  setCurrentLibrary(id:string):void {
    const library=this.library(id)
    this.store.put('workspace',{id:'current-library',libraryId:library.id})
    this.family.requestAutomaticFaces(library.id)
  }
  /** 离线或停用仍保留所选库，不将新任务静默切换到其他目录。 */
  private currentLibraryAvailable():boolean {
    const library=this.currentLibraryId?this.store.get<Library>('library',this.currentLibraryId):undefined
    if(!library?.enabled) return false
    try { return statSync(library.path).isDirectory() && realpathSync(library.path).toLowerCase()===library.path.toLowerCase() } catch { return false }
  }
  /** 按会话和内容串行提交，防止重试与并发重复写入。 */
  private async serial<T>(key:string, action:()=>Promise<T>):Promise<T> {
    const previous=this.locks.get(key) ?? Promise.resolve()
    const next=previous.catch(()=>{}).then(action)
    this.locks.set(key,next)
    try { return await next } finally { if(this.locks.get(key)===next) this.locks.delete(key) }
  }
  async start(port=45831, host='0.0.0.0'):Promise<void> {
    requireValue(host==='0.0.0.0'||host==='127.0.0.1','接收端只允许局域网监听或本机测试监听。')
    await this.lan.start(host==='127.0.0.1')
    const identityPath=join(this.dataDirectory,'tls-identity.json')
    let identity:{private:string;cert:string}
    try { identity=JSON.parse(await readFile(identityPath,'utf8')) }
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error
      identity=await generate([{name:'commonName',value:'Jinchuan local receiver'}],{keySize:2048,notAfterDate:new Date(Date.now()+10*365*86400000)})
      await writeFile(identityPath,JSON.stringify(identity),{flag:'wx',mode:0o600})
    }
    this.fingerprint=new X509Certificate(identity.cert).fingerprint256.replaceAll(':','').toLowerCase()
    await this.recover()
    this.server=createServer({key:identity.private,cert:identity.cert,minVersion:'TLSv1.2'},(req,res)=>{
      if(!this.lan.allows(req.socket.remoteAddress,req.socket.localAddress)) {req.socket.destroy();return}
      if(this.activeRequests>=16) { this.reply(res,429,{error:'接收端忙，请稍后重试。'}); req.resume(); return }
      this.activeRequests++
      void this.route(req,res).catch(error=>{
        if(!(error instanceof RequestError)) console.error('接收请求失败：',error)
        const code=(error as NodeJS.ErrnoException).code
        const message=error instanceof RequestError ? error.message : code==='ENOSPC'?'磁盘空间不足。':code==='EACCES'?'接收目录不可写。':'接收失败，请检查目录与网络后重试。'
        if(!res.headersSent) this.reply(res,error instanceof RequestError?error.status:500,{error:message})
        else res.destroy()
        req.resume()
      }).finally(()=>{this.activeRequests--;if(this.activeRequests===0)this.requestsDrained?.()})
    })
    this.server.requestTimeout=120000
    this.server.headersTimeout=15000
    this.server.maxHeadersCount=40
    this.server.on('connection',socket=>{if(!(socket instanceof Socket)||!this.lan.allows(socket.remoteAddress,socket.localAddress)) socket.destroy()})
    await new Promise<void>((resolve,reject)=>{
      this.server!.once('error',reject)
      this.server!.listen(port,host,()=>{this.server!.off('error',reject);resolve()})
    })
    this.port=(this.server.address() as {port:number}).port
    this.family.requestAutomaticFaces(this.currentLibraryId??undefined)
  }
  private reply(res:ServerResponse,status:number,data:unknown):void {
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
    res.end(JSON.stringify(data))
  }
  private async body(req:IncomingMessage,limit=128*1024):Promise<Record<string,unknown>> {
    const chunks:Buffer[]=[]; let size=0
    for await(const chunk of req) {size+=chunk.length;requireValue(size<=limit,'请求过大。',413);chunks.push(chunk)}
    try {
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requireValue(value && typeof value==='object' && !Array.isArray(value),'请求格式无效。')
      return value
    } catch { throw new RequestError('请求 JSON 格式无效。') }
  }
  private authenticated(req:IncomingMessage):Device {
    const authorization=req.headers.authorization ?? ''
    requireValue(/^Bearer [a-f0-9]{64}$/.test(authorization),'请先与电脑配对。',401)
    const digest=tokenHash(authorization.slice(7))
    const device=this.store.list<Device>('device').find(item=>!item.revoked && item.tokenHash===digest)
    requireValue(device,'设备凭据无效或已撤销，请重新配对。',401)
    return device
  }
  private library(id:unknown):Library {
    const library=this.store.get<Library>('library',textValue(id))
    requireValue(library?.enabled,'目标目录不存在或已停用。',404)
    return library
  }
  private session(id:string,deviceId:string):UploadSession {
    const session=this.store.get<UploadSession>('session',id)
    requireValue(session && session.deviceId===deviceId,'上传任务不存在。',404)
    this.library(session.libraryId)
    return session
  }
  private async route(req:IncomingMessage,res:ServerResponse):Promise<void> {
    requireValue(!req.headers.origin,'不接受网页发起的传输请求。',403)
    const url=new URL(req.url ?? '/', 'https://localhost')
    if(req.method==='POST' && url.pathname==='/v1/pair') {
      const address=req.socket.remoteAddress ?? 'unknown'
      const attempt=this.pairAttempts.get(address) ?? {count:0,since:Date.now()}
      if(Date.now()-attempt.since>60000) {attempt.count=0;attempt.since=Date.now()}
      requireValue(++attempt.count<=10,'配对尝试过多，请一分钟后再试。',429)
      if(this.pairAttempts.size>256) this.pairAttempts.clear()
      this.pairAttempts.set(address,attempt)
      const data=await this.body(req)
      const secret=textValue(data.secret,64)
      const name=textValue(data.name,80)
      requireValue(this.pairing && this.pairing.expiresAt>Date.now(),'配对信息已过期，请在电脑端重新生成。',401)
      const expected=Buffer.from(this.pairing.secret), actual=Buffer.from(secret)
      requireValue(actual.length===expected.length && timingSafeEqual(actual,expected),'配对信息不正确。',401)
      requireValue(this.store.list<Device>('device').filter(d=>!d.revoked).length<32,'配对设备已达上限，请撤销不用的设备。')
      const token=randomBytes(32).toString('hex')
      const device:Device={id:randomUUID(),name,tokenHash:tokenHash(token),createdAt:now(),revoked:false}
      this.store.put('device',device)
      this.pairing=undefined
      this.reply(res,200,{receiverId:this.receiverId,name:hostname(),deviceId:device.id,token})
      return
    }
    const device=this.authenticated(req)
    if(req.method==='POST' && url.pathname==='/v1/family/sync') {
      const data=await this.body(req)
      this.reply(res,200,this.family.sync(data as unknown as FamilySyncRequest));return
    }
    const familyAsset=/^\/v1\/family\/assets\/([a-f0-9]{64}-\d+)\/(thumb|content)$/.exec(url.pathname)
    if(req.method==='GET' && familyAsset) {
      if(familyAsset[2]==='thumb') {this.reply(res,200,{dataUrl:await this.family.thumbnailData(familyAsset[1])});return}
      const path=await this.family.mediaPath(familyAsset[1]),info=await stat(path)
      let start=0,end=info.size-1,status=200
      if(req.headers.range) {
        const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
        requireValue(range,'媒体读取范围无效。',416)
        start=Number(range[1]);end=range[2]?Number(range[2]):end;status=206
        requireValue(Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>=start&&end<info.size,'媒体读取范围无效。',416)
      }
      const mime:Record<string,string>={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'}
      res.writeHead(status,{'content-type':mime[extname(path).toLowerCase()]??'application/octet-stream','content-length':end-start+1,'cache-control':'no-store','accept-ranges':'bytes',...(status===206?{'content-range':`bytes ${start}-${end}/${info.size}`}:{})})
      await pipeline(createReadStream(path,{start,end}),res);return
    }
    if(req.method==='GET' && url.pathname==='/v1/receiver') {
      this.reply(res,200,{receiverId:this.receiverId,name:hostname(),accepting:this.accepting,currentLibraryId:this.currentLibraryId,currentLibraryAvailable:this.currentLibraryAvailable(),libraries:this.store.list<Library>('library').filter(l=>l.enabled),chunkSize:chunkLimit})
      return
    }
    if(req.method==='POST' && url.pathname==='/v1/assets/check') {
      const data=await this.body(req)
      const library=this.library(data.libraryId)
      requireValue(Array.isArray(data.assets) && data.assets.length<=50,'每次最多核对 50 张照片。')
      const roots=this.store.list<ScanRoot>('root').filter(r=>r.enabled)
      let complete=true
      let targetAvailable=true
      // 已扫描的外接盘可能随后离线，每次核对均确认目录仍可访问。
      for(const directory of [...roots,...this.store.list<Library>('library').filter(item=>item.enabled)]) {
        try {requireValue(await canonicalDirectory(directory.path)===directory.path,'目录身份已变化。')}
        catch {complete=false;if(directory.id===library.id) targetAvailable=false;if('state' in directory) directory.state='unavailable'}
      }
      complete=complete && roots.every(r=>r.state==='ready')
      const results=[]
      for(const raw of data.assets) {
        requireValue(raw && typeof raw==='object','照片信息无效。')
        const identity=contentIdentity(raw)
        const saved=await this.checkSavedReceipt(library,identity.hash,identity.size,targetAvailable)
        const receipt=saved.receipt
        const matches=receipt?[]:await this.findHistory(identity.hash,identity.size)
        results.push({...identity,...saved,matches,complete:complete&&saved.receiptState!=='unavailable'})
      }
      this.reply(res,200,{results,roots})
      return
    }
    if(req.method==='POST' && url.pathname==='/v1/batches') {
      requireValue(this.accepting,'电脑已暂停接收。',503)
      const data=await this.body(req)
      const libraryId=textValue(data.libraryId)
      requireValue(['capture','upload','manual'].includes(String(data.mode)),'日期规则无效。')
      requireValue(data.mode!=='manual' || validDate(data.manualDate),'请选择有效的归档日期。')
      const clientKey=textValue(data.clientKey,80)
      const batchId=tokenHash(`${device.id}:${clientKey}`)
      let batch=this.store.get<Batch>('batch',batchId)
      if(batch) {
        this.library(libraryId)
        requireValue(batch.libraryId===libraryId && batch.mode===data.mode && batch.manualDate===(data.mode==='manual'?data.manualDate:null),'批次参数发生变化，请创建新批次。',409)
      }
      else {
        requireValue(this.currentLibraryAvailable(),'当前照片库不可用，请在电脑上检查或切换照片库。',409)
        requireValue(libraryId===this.currentLibraryId,'电脑当前照片库已改变，请刷新目标后创建新批次。',409)
        const library=this.library(libraryId)
        batch={id:batchId,deviceId:device.id,libraryId:library.id,mode:data.mode as Batch['mode'],uploadDate:localDate(),manualDate:data.mode==='manual'?String(data.manualDate):null,createdAt:now()}
        this.store.put('batch',batch)
      }
      this.reply(res,200,batch)
      return
    }
    if(req.method==='POST' && url.pathname==='/v1/uploads') {
      requireValue(this.accepting,'电脑已暂停接收。',503)
      const data=await this.body(req)
      const result=await this.serial(`create:${device.id}`,()=>this.createUpload(device,data))
      this.reply(res,200,result)
      return
    }
    const match=/^\/v1\/uploads\/([a-f0-9-]{36})(\/content|\/complete|\/cancel)?$/.exec(url.pathname)
    requireValue(match,'接口不存在。',404)
    const id=match[1]
    if(req.method==='POST' && match[2]==='/cancel') {
      const result=await this.serial(id,async()=>{
        const session=this.session(id,device.id)
        if(session.state!=='complete') {session.state='cancelled';session.error='任务已取消。';session.updatedAt=now();this.store.put('session',session);await this.cleanupTemp(session)}
        return session
      })
      this.reply(res,200,result);return
    }
    if(req.method==='GET' && !match[2]) {
      const session=await this.serial(id,async()=>this.reconcile(this.session(id,device.id)))
      this.reply(res,200,session); return
    }
    requireValue(this.accepting,'电脑已暂停接收。',503)
    if(req.method==='PUT' && match[2]==='/content') {
      await this.serial(id,()=>this.receiveChunk(this.session(id,device.id),req,url))
      this.reply(res,200,this.session(id,device.id)); return
    }
    if(req.method==='POST' && match[2]==='/complete') {
      const session=await this.serial(id,()=>this.complete(this.session(id,device.id)))
      this.reply(res,200,session); return
    }
    throw new RequestError('接口不存在。',404)
  }
  /** 登记用户授权的目录并返回身份，供目录选择流程设置当前库。 */
  async addDirectory(path:string,kind:'library'|'root'):Promise<string> {
    const canonical=await canonicalDirectory(path)
    const existing=this.store.list<Library|ScanRoot>(kind).find(item=>item.path.toLowerCase()===canonical.toLowerCase())
    if(existing) {this.store.put(kind,{...existing,enabled:true});if(kind==='library'&&!this.currentLibraryId)this.setCurrentLibrary(existing.id);return existing.id}
    if(kind==='library') {
      const library:Library={id:randomUUID(),name:basename(canonical)||canonical,path:canonical,enabled:true}
      this.store.put(kind,library)
      if(!this.currentLibraryId)this.setCurrentLibrary(library.id)
      return library.id
    }
    const root:ScanRoot={id:randomUUID(),path:canonical,state:'pending',count:0,error:'',scannedAt:null,enabled:true}
    this.store.put(kind,root)
    return root.id
  }
  async toggleDirectory(kind:string,id:string,enabled:boolean):Promise<void> {
    requireValue(kind==='library'||kind==='root','目录类型无效。')
    const value=this.store.get<Library|ScanRoot>(kind,id)
    requireValue(value,'目录不存在。')
    this.store.put(kind,{...value,enabled})
    if(kind==='library'&&enabled)this.family.requestAutomaticFaces(id)
  }
  async scan():Promise<void> {
    requireValue(!this.scanning,'已有扫描正在进行。',409)
    this.scanning=true
    const task=this.scanAll().finally(()=>{this.scanning=false})
    this.scans=[task]
  }
  private async scanAll():Promise<void> {
    for(const original of this.store.list<ScanRoot>('root').filter(r=>r.enabled)) {
      if(this.closing) break
      const root={...original,state:'scanning',error:'',count:0}
      this.store.put('root',root)
      const seen=new Set<string>()
      let errors=0
      const walk=async(directory:string):Promise<void>=>{
        for(const entry of await readdir(directory,{withFileTypes:true})) {
          if(this.closing) throw new Error('扫描已中断。')
          if(entry.isSymbolicLink() || entry.name==='.jinchuan-incoming') continue
          const path=join(directory,entry.name)
          if(entry.isDirectory()) { try {await safePath(root.path,relative(root.path,path));await walk(path)} catch {errors++} }
          else if(entry.isFile() && mediaExtensions.has(extname(entry.name).toLowerCase())) {
            try {
              await safePath(root.path,relative(root.path,path))
              const identity=await hashFile(path)
              this.store.db.prepare('INSERT INTO locations VALUES(?,?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,mtime=excluded.mtime').run(root.id,path,identity.hash,identity.size,identity.mtime)
              seen.add(path);root.count++
              if(root.count%25===0) this.store.put('root',root)
            } catch {errors++}
          }
        }
      }
      try {
        requireValue(await canonicalDirectory(root.path)===root.path,'历史目录身份已变化。')
        await walk(root.path)
        if(!errors) {
          for(const location of this.store.db.prepare('SELECT path FROM locations WHERE root=?').all(root.id)) {
            if(!seen.has(String(location.path))) this.store.db.prepare('DELETE FROM locations WHERE root=? AND path=?').run(root.id,location.path)
          }
        }
        root.state=errors?'partial':'ready';root.error=errors?`${errors} 项未能读取，不能视为完整扫描。`:'';root.scannedAt=now()
      } catch {root.state='unavailable';root.error='目录不可访问或扫描中断，请检查后重试。'}
      const latest=this.store.get<ScanRoot>('root',root.id)
      this.store.put('root',{...root,enabled:latest?.enabled ?? false})
    }
  }
  private async findHistory(hash:string,size:number):Promise<{rootId?:string;libraryId?:string;path:string;checkedAt:string}[]> {
    const locations=this.store.db.prepare('SELECT * FROM locations WHERE hash=? AND size=? LIMIT 100').all(hash,size) as unknown as Location[]
    const matches:{rootId?:string;libraryId?:string;path:string;checkedAt:string}[]=[]
    // 其他接收目录的有效回执也可证明电脑已有，不冒充本次目录的回执。
    for(const library of this.store.list<Library>('library').filter(item=>item.enabled)) {
      const receipt=await this.findReceipt(library,hash,size)
      if(receipt) matches.push({libraryId:library.id,path:await safePath(library.path,receipt.relativePath),checkedAt:now()})
    }
    for(const location of locations) {
      const root=this.store.get<ScanRoot>('root',location.root)
      if(!root?.enabled) continue
      try {
        const path=await safePath(root.path,relative(root.path,location.path))
        const actual=await hashFile(path)
        if(actual.hash===hash && actual.size===size) matches.push({rootId:root.id,path,checkedAt:now()})
      } catch { /* 无法重新核实的旧索引不作为跳过依据。 */ }
    }
    return matches
  }
  private async findReceipt(library:Library,hash:string,size:number):Promise<Receipt|null> {
    const file=this.store.content<Receipt>(library.id,hash,size)
    if(!file) return null
    try {
      const actual=await hashFile(await safePath(library.path,file.relativePath))
      if(actual.hash===hash && actual.size===size) return file
    } catch { /* 保留旧回执作为历史，不把缺失或损坏的文件判为当前可用。 */ }
    return null
  }
  /** 保留历史回执，并区分文件缺失、内容损坏与暂时无法核实。 */
  private async checkSavedReceipt(library:Library,hash:string,size:number,available:boolean):Promise<{receipt:Receipt|null;previousReceipt:Receipt|null;receiptState:'present'|'none'|'missing'|'corrupt'|'unavailable'}> {
    const previousReceipt=this.store.content<Receipt>(library.id,hash,size)??null
    if(!available) return {receipt:null,previousReceipt,receiptState:'unavailable'}
    if(!previousReceipt) return {receipt:null,previousReceipt:null,receiptState:'none'}
    try {
      const actual=await hashFile(await safePath(library.path,previousReceipt.relativePath))
      if(actual.hash===hash&&actual.size===size) return {receipt:previousReceipt,previousReceipt,receiptState:'present'}
      return {receipt:null,previousReceipt,receiptState:'corrupt'}
    } catch(error) {
      // 再次检查根目录，避免核对期间断开的硬盘被误判为文件丢失。
      try {requireValue(await canonicalDirectory(library.path)===library.path,'目录身份已变化。')}
      catch {return {receipt:null,previousReceipt,receiptState:'unavailable'}}
      const code=(error as NodeJS.ErrnoException).code
      return {receipt:null,previousReceipt,receiptState:code==='ENOENT'?'missing':'unavailable'}
    }
  }
  private async createUpload(device:Device,data:Record<string,unknown>):Promise<UploadSession> {
    const identity=contentIdentity(data), clientKey=textValue(data.clientKey,80)
    const batch=this.store.get<Batch>('batch',textValue(data.batchId))
    requireValue(batch && batch.deviceId===device.id,'上传批次不存在。',404)
    const library=this.library(batch.libraryId)
    const existingRow=this.store.db.prepare("SELECT value FROM records WHERE kind='session' AND json_extract(value,'$.deviceId')=? AND json_extract(value,'$.clientKey')=?").get(device.id,clientKey)
    const existing=existingRow?JSON.parse(String(existingRow.value)) as UploadSession:undefined
    if(existing) {
      requireValue(existing.hash===identity.hash && existing.size===identity.size && existing.batchId===batch.id,'重试任务的内容发生变化。',409)
      return this.reconcile(existing)
    }
    const pendingCount=this.store.db.prepare("SELECT count(*) AS count FROM records WHERE kind='session' AND json_extract(value,'$.state') NOT IN ('complete','cancelled')").get()!
    requireValue(Number(pendingCount.count)<20000,'未完成任务过多，请先恢复已有任务。',429)
    const id=randomUUID(), filename=textValue(data.filename,250)
    const captureDate=validDate(data.captureDate)?data.captureDate:null,creationDate=validDate(data.creationDate)?data.creationDate:null
    const archiveDate=batch.mode==='manual'?batch.manualDate!:batch.mode==='capture'?(captureDate??creationDate??batch.uploadDate):batch.uploadDate
    const receipt=await this.findReceipt(library,identity.hash,identity.size)
    const session:UploadSession={id,deviceId:device.id,clientKey,batchId:batch.id,libraryId:library.id,...identity,filename,archiveDate,captureDate,creationDate,kind:mediaKind(filename),dateSource:batch.mode==='capture'&&!captureDate?(creationDate?'creation':'upload-fallback'):batch.mode,relativePath:`${archiveDate}/${archiveName(filename,identity.hash,id)}`,offset:receipt?identity.size:0,state:receipt?'complete':'receiving',error:'',updatedAt:now(),...(receipt?{receipt}:{})}
    if(!receipt) {
      const incoming=await safePath(library.path,'.jinchuan-incoming')
      await mkdir(incoming,{recursive:true})
      await safePath(library.path,`.jinchuan-incoming/${id}.part`)
      const handle=await open(join(incoming,`${id}.part`),'wx');await handle.close()
    }
    this.store.put('session',session)
    return session
  }
  private tempPath(session:UploadSession):Promise<string> {return safePath(this.library(session.libraryId).path,`.jinchuan-incoming/${session.id}.part`)}
  /** 以已确认偏移截断未提交尾部；回执丢失可直接查回，文件丢失则重新传输。 */
  private async reconcile(session:UploadSession):Promise<UploadSession> {
    if(session.state==='cancelled') return session
    if(session.state==='committing') return this.complete(session)
    if(session.state==='complete') {
      const current=await this.findReceipt(this.library(session.libraryId),session.hash,session.size)
      if(current) {session.receipt=current;session.relativePath=current.relativePath;this.store.put('session',session);return session}
      session={...session,offset:0,state:'receiving',error:'已保存文件缺失或损坏，需要重新上传。',receipt:undefined}
      session.relativePath=`${session.archiveDate}/${archiveName(session.filename,session.hash,randomUUID())}`
    }
    const path=await this.tempPath(session)
    await mkdir(join(path,'..'),{recursive:true})
    const handle=await open(path,'r+').catch(async error=>{if(error.code!=='ENOENT')throw error;return open(path,'wx+')})
    try {
      const info=await handle.stat()
      if(info.size<session.offset) session.offset=0
      if(info.size!==session.offset) {await handle.truncate(session.offset);await handle.sync()}
    } finally {await handle.close()}
    if(session.state==='failed') {session.state='receiving';session.error=''}
    this.store.put('session',session)
    return session
  }
  private async receiveChunk(session:UploadSession,req:IncomingMessage,url:URL):Promise<void> {
    session=await this.reconcile(session)
    requireValue(session.state==='receiving','此任务已完成。',409)
    const offset=Number(url.searchParams.get('offset'))
    requireValue(url.searchParams.has('offset') && Number.isSafeInteger(offset) && offset===session.offset,'偏移已变化，请查询任务后继续。',409)
    const length=Number(req.headers['content-length'])
    requireValue(Number.isSafeInteger(length)&&length>0&&length<=chunkLimit&&offset+length<=session.size,'分块大小无效。',413)
    const library=this.library(session.libraryId)
    const disk=await statfs(library.path)
    requireValue(disk.bavail*disk.bsize>length+16*1024**2,'磁盘空间不足。',507)
    const path=await this.tempPath(session), handle=await open(path,'r+')
    let received=0
    try {
      for await(const raw of req) {
        requireValue(this.lan.allows(req.socket.remoteAddress,req.socket.localAddress),'局域网连接已变化，请重新连接。',403)
        const chunk=raw as Buffer
        requireValue(received+chunk.length<=length,'请求数据超出声明长度。',413)
        let written=0
        while(written<chunk.length) { const result=await handle.write(chunk,written,chunk.length-written,offset+received+written);requireValue(result.bytesWritten>0,'文件写入失败。',500);written+=result.bytesWritten }
        received+=chunk.length
      }
      requireValue(received===length,'分块未接收完整。',409)
      await handle.sync()
      session.offset+=received;session.updatedAt=now();session.error=''
      this.store.put('session',session)
    } catch(error) {await handle.truncate(offset);await handle.sync();throw error}
    finally {await handle.close()}
  }
  private async complete(session:UploadSession):Promise<UploadSession> {
    requireValue(session.state!=='cancelled','任务已取消。',409)
    return this.serial(`content:${session.libraryId}:${session.hash}`,async()=>{
      const library=this.library(session.libraryId)
      const already=await this.findReceipt(library,session.hash,session.size)
      if(already) {session.state='complete';session.offset=session.size;session.receipt=already;session.relativePath=already.relativePath;this.store.put('session',session);await this.cleanupTemp(session);return session}
      requireValue(session.offset===session.size,'媒体尚未接收完整。',409)
      const temp=await this.tempPath(session)
      let destination=await safePath(library.path,session.relativePath)
      let finalValid=false
      if(session.state==='committing') {
        try { const existing=await hashFile(destination);finalValid=existing.hash===session.hash&&existing.size===session.size } catch { /* 未提交文件继续从临时文件恢复。 */ }
      }
      if(!finalValid) {
        const actual=await hashFile(temp)
        if(actual.hash!==session.hash || actual.size!==session.size) {
          session.state='failed';session.offset=0;session.error='内容校验失败，请重新读取手机原图。';this.store.put('session',session)
          throw new RequestError(session.error,422)
        }
        try {
          await lstat(destination)
          session.relativePath=`${session.archiveDate}/${archiveName(session.filename,session.hash,randomUUID())}`
          destination=await safePath(library.path,session.relativePath)
        } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error}
        session.state='committing';this.store.put('session',session)
        await mkdir(join(destination,'..'),{recursive:true})
        await safePath(library.path,session.relativePath)
        try {await link(temp,destination)}
        catch(error) {
          if(!['EPERM','ENOTSUP','EOPNOTSUPP','EXDEV'].includes((error as NodeJS.ErrnoException).code??'')) throw error
          await copyFile(temp,destination,constants.COPYFILE_EXCL)
        }
        const handle=await open(destination,'r+');await handle.sync();await handle.close()
        const verified=await hashFile(destination)
        requireValue(verified.hash===session.hash&&verified.size===session.size,'落盘校验失败。',500)
      }
      const previous=this.store.content<Receipt>(session.libraryId,session.hash,session.size)
      const receipt:Receipt={id:previous?.id??randomUUID(),receiverId:this.receiverId,libraryId:library.id,batchId:session.batchId,hash:session.hash,size:session.size,relativePath:session.relativePath,filename:session.filename,savedAt:now(),captureDate:session.captureDate,creationDate:session.creationDate,kind:session.kind??mediaKind(session.filename),source:'phone'}
      session.state='complete';session.receipt=receipt;session.error='';session.updatedAt=now()
      this.store.transaction(()=>{this.store.put('file',receipt);this.store.put('session',session)})
      this.family.recordReceipt(receipt)
      await this.cleanupTemp(session)
      return session
    })
  }
  /** 回执持久化后仅清理本应用创建的对应临时分块，不触碰原图或其他文件。 */
  private async cleanupTemp(session:UploadSession):Promise<void> {
    try {await unlink(await this.tempPath(session))} catch { /* 清理失败不会撤销已完成的保存回执。 */ }
  }
  private async recover():Promise<void> {
    for(const session of this.store.list<UploadSession>('session').filter(s=>s.state==='committing')) {
      try {await this.complete(session)} catch {session.error='上次保存中断，等待手机连接恢复。';this.store.put('session',session)}
    }
  }
  pairInfo():{addresses:string[];fingerprint:string;secret:string;expiresAt:number;receiverId:string;v:number} {
    requireValue(this.store.list<Library>('library').some(l=>l.enabled),'请先添加至少一个接收目录。')
    requireValue(this.addresses().length>0,'未检测到可用的 IPv4 局域网，请连接 Wi-Fi 或有线网络。')
    this.pairing={secret:randomBytes(24).toString('hex'),expiresAt:Date.now()+5*60000}
    return {...this.pairing,addresses:this.addresses(),fingerprint:this.fingerprint,receiverId:this.receiverId,v:1}
  }
  addresses():string[] {
    return this.lan.addresses().map(address=>`https://${address}:${this.port}`)
  }
  snapshot():unknown {
    const savedCount=Number(this.store.db.prepare("SELECT count(*) AS count FROM records WHERE kind='file'").get()!.count)
    // 旧回执只在读取时关联真实上传会话，不按日期伪造批次或修改历史记录。
    const recentFiles=this.store.recent<Receipt>('file'), legacyIds=new Set(recentFiles.filter(file=>!file.batchId&&file.source!=='folder').map(file=>file.id)), receiptBatches=new Map<string,string>()
    if(legacyIds.size) for(const session of this.store.list<UploadSession>('session').filter(item=>item.receipt&&legacyIds.has(item.receipt.id)).sort((left,right)=>left.updatedAt.localeCompare(right.updatedAt))) if(session.receipt&&!receiptBatches.has(session.receipt.id)) receiptBatches.set(session.receipt.id,session.batchId)
    const files=recentFiles.map(file=>({...file,...(!file.batchId&&receiptBatches.has(file.id)?{batchId:receiptBatches.get(file.id)}:{})}))
    return {receiverId:this.receiverId,name:hostname(),port:this.port,addresses:this.addresses(),accepting:this.accepting,scanning:this.scanning,savedCount,currentLibraryId:this.currentLibraryId,currentLibraryAvailable:this.currentLibraryAvailable(),libraries:this.store.list<Library>('library'),roots:this.store.list<ScanRoot>('root'),devices:this.store.list<Device>('device').map(({tokenHash:_,...device})=>device),sessions:this.store.recent<UploadSession>('session'),files}
  }
  setAccepting(value:boolean):void {this.accepting=value;this.saveConfig()}
  revoke(id:string):void {const device=this.store.get<Device>('device',id);requireValue(device,'设备不存在。');this.store.put('device',{...device,revoked:true})}
  async storedPath(id:string):Promise<string> {
    const file=this.store.get<Receipt>('file',id);requireValue(file,'图片记录不存在。')
    return safePath(this.library(file.libraryId).path,file.relativePath)
  }
  async close():Promise<void> {
    this.closing=true
    this.lan.close()
    if(this.server) {this.server.closeAllConnections();await new Promise<void>(resolve=>this.server!.close(()=>resolve()))}
    // 网络关闭后，仍需等待正在核对文件的请求结束再关闭数据库。
    if(this.activeRequests>0) await new Promise<void>(resolve=>{this.requestsDrained=resolve})
    await Promise.allSettled([...this.locks.values(),...this.scans])
    await this.family.close()
    this.store.close()
  }
}
