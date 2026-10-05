const {app}=require('electron')
const {Worker}=require('node:worker_threads')
const {readFileSync,mkdirSync,writeFileSync}=require('node:fs')
const {join,resolve}=require('node:path')
const {randomUUID,createHash}=require('node:crypto')
const assert=require('node:assert/strict')
const root=resolve(__dirname,'..')
const latest=JSON.parse(readFileSync(join(root,'release','latest.json'),'utf8'))
const packaged=join(latest.directory,'resources','app')
const directory=join(root,'.cache',`portable-verification-${Date.now()}`)
mkdirSync(directory,{recursive:true});app.setPath('userData',directory);app.disableHardwareAcceleration()

// 使用发布包内的工作线程、原生依赖及模型验证，素材全部来自人工生成的测试图片。
async function verify() {
  const worker=new Worker(join(packaged,'out','main','receiver.js'),{workerData:{dataDirectory:join(directory,'receiver'),modelDirectory:join(packaged,'models'),port:0,host:'127.0.0.1'}})
  const pending=new Map();let sequence=0
  await new Promise((resolveReady,reject)=>{
    worker.on('message',message=>{
      if(message.ready) resolveReady()
      else if(message.fatal) reject(new Error(message.fatal))
      else {
        const item=pending.get(message.id);if(!item)return
        pending.delete(message.id);clearTimeout(item.timer)
        message.error?item.reject(new Error(message.error)):item.resolve(message.value)
      }
    })
    worker.on('error',reject)
  })
  const call=(method,...args)=>new Promise((resolveValue,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} 超时`))},60000)
    pending.set(id,{resolve:resolveValue,reject,timer});worker.postMessage({id,method,args})
  })
  const waitJobs=async()=>{
    for(let index=0;index<600;index++) {
      const state=await call('familyState')
      const failed=state.jobs.find(job=>job.state==='error');if(failed)throw new Error(failed.error)
      if(!state.jobs.some(job=>job.state==='running'))return state
      await new Promise(resolveWait=>setTimeout(resolveWait,100))
    }
    throw new Error('发布包处理任务超时。')
  }
  try {
    const source=join(root,'.cache','smoke-media'),archive=join(directory,'archive'),exports=join(directory,'exports')
    mkdirSync(archive);mkdirSync(exports)
    await call('addDirectory',source,'root');await call('addDirectory',archive,'library')
    const receiver=await call('snapshot')
    const plan=await call('prepareImport',receiver.roots[0].id,'copy',receiver.libraries[0].id)
    await waitJobs();await call('executeImport',plan.id);await waitJobs()
    let page=await call('queryMedia',{limit:100})
    assert.equal(page.total,4);assert.equal(page.items.filter(item=>item.kind==='video').length,1)
    assert.equal(page.items.filter(item=>item.dateSource==='creation').length,1)
    for(const asset of page.items) {
      const original=readFileSync(join(source,asset.filename))
      assert.equal(original.length,asset.size)
      assert.equal(createHash('sha256').update(original).digest('hex'),asset.hash)
      const copied=asset.locations.find(location=>location.libraryId===receiver.libraries[0].id)
      assert.ok(copied)
      assert.deepEqual(readFileSync(copied.path),original)
    }
    await call('analyzeFaces');const state=await waitJobs();assert.equal(state.modelReady,true)
    page=await call('queryMedia',{limit:100})
    const photo=page.items.find(item=>item.filename==='宝宝参考.jpg')
    assert.ok(photo.faces.length>0);assert.equal(photo.captureDate,'2026-09-15')
    const baby={id:randomUUID(),name:'验收宝宝',birthday:'2026-06-08',autoMatch:true,referenceFaces:[],updatedAt:new Date().toISOString()}
    await call('saveBaby',baby);await call('setBabyReference',baby.id,photo.id,photo.faces[0].id);await call('matchBaby',baby.id)
    const related=await call('queryMedia',{babyId:baby.id,limit:100});assert.ok(related.total>=2)
    const options={babyId:baby.id,position:'bottom-left',fontSize:48,color:'#ffffff',opacity:0.95,showName:true,showAge:true,showDayCount:true,showDate:true}
    const preview=await call('previewWatermark',photo.id,options);assert.match(preview.dataUrl,/^data:image\/jpeg;base64,/)
    const output=await call('exportWatermark',[photo.id],options,exports);assert.equal(output.length,1)
    assert.notEqual(createHash('sha256').update(readFileSync(output[0].path)).digest('hex'),photo.hash)
    const version=JSON.parse(readFileSync(join(packaged,'package.json'),'utf8')).version
    const report={version,packagedDirectory:latest.directory,photoCount:state.photoCount,videoCount:state.videoCount,matchedAssets:related.total,offlineModels:true,originalBytes:true,watermarkExport:true,checkedAt:new Date().toISOString()}
    writeFileSync(join(root,'.cache','portable-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
  } finally {await call('close');await worker.terminate()}
}
app.whenReady().then(verify).then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1)})
