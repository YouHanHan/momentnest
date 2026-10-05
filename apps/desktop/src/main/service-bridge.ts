import { Worker } from 'node:worker_threads'
import { join } from 'node:path'

/** 将网络、SQLite、扫描和哈希隔离到专用工作线程。 */
export class ServiceBridge {
  private worker:Worker
  private nextId=0
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>()
  readonly ready:Promise<void>
  private failure:Error|undefined
  constructor(dataDirectory:string, modelDirectory:string) {
    this.worker=new Worker(join(__dirname,'receiver.js'),{workerData:{dataDirectory,modelDirectory}})
    this.ready=new Promise((resolve,reject)=>{
      this.worker.on('message',message=>{
        if(message.ready) {resolve();return}
        if(message.fatal) {this.failure=new Error(message.fatal);reject(this.failure);return}
        const pending=this.pending.get(message.id)
        if(!pending) return
        clearTimeout(pending.timer);this.pending.delete(message.id)
        if(message.error) pending.reject(new Error(message.error));else pending.resolve(message.value)
      })
      this.worker.on('error',error=>{this.failure=error;reject(error);this.failAll(error)})
      this.worker.on('exit',code=>{this.failure=new Error(`接收线程已退出（${code}），请重新打开应用。`);reject(this.failure);this.failAll(this.failure)})
    })
  }
  private failAll(error:Error):void {for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error)}this.pending.clear()}
  async call<T=unknown>(method:string,...args:unknown[]):Promise<T> {
    await this.ready
    if(this.failure) throw this.failure
    const id=++this.nextId
    return new Promise<T>((resolve,reject)=>{
      const timeout=method==='exportWatermark'?15*60*1000:60000
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('服务响应超时，请重试。'))},timeout)
      this.pending.set(id,{resolve:resolve as (value:unknown)=>void,reject,timer})
      this.worker.postMessage({id,method,args})
    })
  }
  async close():Promise<void> {try{await this.call('close')}finally{await this.worker.terminate()}}
}
