import { parentPort, workerData } from 'node:worker_threads'
import { mkdir } from 'node:fs/promises'
import { Receiver } from './receiver.ts'

async function start():Promise<void> {
  await mkdir(workerData.dataDirectory,{recursive:true})
  const receiver=new Receiver(workerData.dataDirectory,workerData.modelDirectory)
  await receiver.start(workerData.port ?? 45831,workerData.host ?? '0.0.0.0')
  parentPort!.on('message',(message:{id:number;method:string;args:unknown[]})=>{
    void (async()=>{
      const a=message.args
      switch(message.method) {
        case 'snapshot': return receiver.snapshot()
        case 'setCurrentLibrary': return receiver.setCurrentLibrary(String(a[0]))
        case 'pair': return receiver.pairInfo()
        case 'addDirectory': return receiver.addDirectory(String(a[0]),a[1] as 'library'|'root')
        case 'toggleDirectory': return receiver.toggleDirectory(String(a[0]),String(a[1]),Boolean(a[2]))
        case 'scan': return receiver.scan()
        case 'accept': return receiver.setAccepting(Boolean(a[0]))
        case 'revoke': return receiver.revoke(String(a[0]))
        case 'storedPath': return receiver.storedPath(String(a[0]))
        case 'familyState': return receiver.family.familyState(a[0] as string|undefined)
        case 'getJobWarnings': return receiver.family.getJobWarnings(String(a[0]),a[1] as number|undefined,a[2] as string|undefined)
        case 'queryMedia': return receiver.family.queryMedia(a[0] as Parameters<typeof receiver.family.queryMedia>[0])
        case 'querySimilarFaces': return receiver.family.querySimilarFaces(a[0] as Parameters<typeof receiver.family.querySimilarFaces>[0])
        case 'scanMedia': return receiver.family.scanMedia(a[0] as string|undefined)
        case 'prepareImport': return receiver.family.prepareImport(String(a[0]),a[1] as 'index'|'copy',a[2] as string|undefined)
        case 'executeImport': return receiver.family.executeImport(String(a[0]))
        case 'mediaPath': return receiver.family.mediaPath(String(a[0]),Boolean(a[1]),a[2] as string|undefined)
        case 'saveBaby': return receiver.family.saveBaby(a[0] as Parameters<typeof receiver.family.saveBaby>[0],a[1] as 'library'|'all'|undefined)
        case 'setBabyMembership': return receiver.family.setBabyMembership(String(a[0]),a[1] as string[],a[2] as boolean)
        case 'setMediaDate': return receiver.family.setMediaDate(String(a[0]),String(a[1]))
        case 'setFavorite': return receiver.family.setFavorite(String(a[0]),a[1] as boolean)
        case 'analyzeFaces': return receiver.family.analyzeFaces(a[0] as string|undefined,a[1] as boolean|undefined)
        case 'supplementFaces': return receiver.family.supplementFaces(a[0] as string|undefined)
        case 'rebuildFaceIndex': return receiver.family.rebuildFaceIndex(String(a[0]))
        case 'namePerson': return receiver.family.namePerson(String(a[0]),String(a[1]))
        case 'mergePersons': return receiver.family.mergePersons(String(a[0]),String(a[1]),String(a[2]))
        case 'preparePersonGrouping': return receiver.family.preparePersonGrouping(String(a[0]))
        case 'applyPersonGrouping': return receiver.family.applyPersonGrouping(String(a[0]),String(a[1]),a[2] as string[]|undefined)
        case 'undoPersonGrouping': return receiver.family.undoPersonGrouping(String(a[0]),String(a[1]))
        case 'setBabyReference': return receiver.family.setBabyReference(String(a[0]),String(a[1]),String(a[2]))
        case 'matchBaby': return receiver.family.matchBaby(String(a[0]),a[1] as string|undefined,a[2] as 'library'|'all'|undefined)
        case 'previewWatermark': return receiver.family.previewWatermark(String(a[0]),a[1] as Parameters<typeof receiver.family.previewWatermark>[1],a[2] as string|undefined)
        case 'exportWatermark': return receiver.family.exportWatermark(a[0] as string[],a[1] as Parameters<typeof receiver.family.exportWatermark>[1],String(a[2]),a[3] as string|undefined)
        case 'close': return receiver.close()
        default: throw Error('不支持的服务操作。')
      }
    })().then(value=>parentPort!.postMessage({id:message.id,value})).catch(error=>parentPort!.postMessage({id:message.id,error:error.message}))
  })
  parentPort!.postMessage({ready:true})
}
void start().catch(error=>parentPort!.postMessage({fatal:error.code==='EADDRINUSE'?'接收端口 45831 已被占用，请关闭其他拾光匣实例后重试。':`接收服务启动失败：${error.message}`}))
