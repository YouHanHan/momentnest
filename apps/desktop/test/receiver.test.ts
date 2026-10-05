import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { request, Agent } from 'node:https'
import { Receiver } from '../src/service/receiver.ts'
import { validDate } from '../src/service/files.ts'
import type { Library, Receipt, UploadSession } from '../src/service/types.ts'

const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex')

test('真实 HTTPS：认证、原图保存、去重、历史核对、断点恢复和日期冻结',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'momentnest-test-'))
  const data=join(directory,'state'), libraryPath=join(directory,'photos'), historyPath=join(directory,'old-photos')
  await Promise.all([mkdir(data),mkdir(libraryPath),mkdir(historyPath)])
  let receiver=new Receiver(data)
  await receiver.addDirectory(libraryPath,'library');await receiver.addDirectory(historyPath,'root')
  await receiver.start(0,'127.0.0.1')
  const identity=JSON.parse(await readFile(join(data,'tls-identity.json'),'utf8'))
  const agent=new Agent({ca:identity.cert,checkServerIdentity:(_host,cert)=>cert.fingerprint256.replaceAll(':','').toLowerCase()===receiver.fingerprint?undefined:new Error('错误证书')})
  let token=''
  const call=(method:string,path:string,value?:unknown,offset?:number,auth=true):Promise<{status:number;body:any}>=>new Promise((resolve,reject)=>{
    const bytes=Buffer.isBuffer(value)?value:value===undefined?undefined:Buffer.from(JSON.stringify(value))
    const req=request({hostname:'127.0.0.1',port:receiver.port,path:path+(offset===undefined?'':`?offset=${offset}`),method,agent,headers:{...(bytes?{'content-length':bytes.length}:{}),...(auth?{authorization:`Bearer ${token}`}:{})}},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}))
    });req.on('error',reject);req.end(bytes)
  })
  try {
    assert.equal((await call('GET','/v1/receiver',undefined,undefined,false)).status,401)
    const pair=receiver.pairInfo()
    assert.equal((await call('POST','/v1/pair',{secret:'wrong',name:'测试手机'},undefined,false)).status,401)
    const paired=await call('POST','/v1/pair',{secret:pair.secret,name:'测试手机'},undefined,false)
    assert.equal(paired.status,200);token=paired.body.token
    assert.equal((await call('POST','/v1/pair',{secret:pair.secret,name:'重放'},undefined,false)).status,401)
    const library=receiver.store.list<Library>('library')[0]
    const old=Buffer.from('old original photo'), original=Buffer.from('original image content for resumable upload')
    const beforeScan=await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(old),size:old.length}]})
    assert.equal(beforeScan.body.results[0].complete,false)
    await writeFile(join(historyPath,'old.jpg'),old)
    await receiver.scan()
    for(let i=0;i<100 && (receiver.snapshot() as any).scanning;i++) await new Promise(resolve=>setTimeout(resolve,10))
    const check=await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(old),size:old.length}]})
    assert.equal(check.body.results[0].receipt,null)
    assert.equal(check.body.results[0].matches.length,1)
    assert.equal(check.body.results[0].complete,true)
    await writeFile(join(historyPath,'old.jpg'),Buffer.from('changed'))
    assert.equal((await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(old),size:old.length}]})).body.results[0].matches.length,0)
    const batchKey=randomUUID()
    const batchData={clientKey:batchKey,libraryId:library.id,mode:'manual',manualDate:'2024-02-29'}
    const batch=(await call('POST','/v1/batches',batchData)).body
    assert.equal((await call('POST','/v1/batches',{...batchData,manualDate:'2024-03-01'})).status,409)
    assert.equal((await call('POST','/v1/batches',{...batchData,clientKey:randomUUID(),manualDate:'2024-02-30'})).status,400)
    const uploadData={clientKey:randomUUID(),batchId:batch.id,filename:'IMG_same.jpg',hash:hash(original),size:original.length}
    const session=(await call('POST','/v1/uploads',uploadData)).body as UploadSession
    assert.equal((await call('POST','/v1/uploads',uploadData)).body.id,session.id)
    assert.equal(session.archiveDate,'2024-02-29')
    assert.equal((await call('PUT',`/v1/uploads/${session.id}/content`,original.subarray(0,7),1)).status,409)
    const firstChunk=await call('PUT',`/v1/uploads/${session.id}/content`,original.subarray(0,7),0)
    assert.equal(firstChunk.status,200,JSON.stringify(firstChunk.body))
    assert.equal(firstChunk.body.offset,7)
    assert.equal((await call('POST',`/v1/uploads/${session.id}/complete`,{})).status,409)
    await receiver.close();receiver=new Receiver(data);await receiver.start(0,'127.0.0.1')
    assert.equal((await call('GET',`/v1/uploads/${session.id}`)).body.offset,7)
    await writeFile(join(libraryPath,'.momentnest-incoming',`${session.id}.part`),Buffer.concat([original.subarray(0,7),Buffer.from('unconfirmed-tail')]))
    assert.equal((await call('GET',`/v1/uploads/${session.id}`)).body.offset,7)
    assert.equal((await stat(join(libraryPath,'.momentnest-incoming',`${session.id}.part`))).size,7)
    const tail=await call('PUT',`/v1/uploads/${session.id}/content`,original.subarray(7),7)
    assert.equal(tail.status,200)
    const completed=await call('POST',`/v1/uploads/${session.id}/complete`,{})
    assert.equal(completed.status,200);assert.equal(completed.body.state,'complete')
    assert.deepEqual(await readFile(join(libraryPath,completed.body.receipt.relativePath)),original)
    assert.equal((await call('POST',`/v1/uploads/${session.id}/complete`,{})).body.receipt.id,completed.body.receipt.id)
    const duplicate=(await call('POST','/v1/uploads',{...uploadData,clientKey:randomUUID(),filename:'another-name.jpg'})).body
    assert.equal(duplicate.state,'complete');assert.equal(duplicate.receipt.id,completed.body.receipt.id)
    assert.equal(receiver.store.list<Receipt>('file').length,1)
    const second=Buffer.from('different content, same filename')
    const next=(await call('POST','/v1/uploads',{...uploadData,clientKey:randomUUID(),hash:hash(second),size:second.length})).body
    await call('PUT',`/v1/uploads/${next.id}/content`,second,0)
    const secondCompleted=(await call('POST',`/v1/uploads/${next.id}/complete`,{})).body
    assert.notEqual(secondCompleted.receipt.relativePath,completed.body.receipt.relativePath)
    assert.deepEqual(await readFile(join(libraryPath,completed.body.receipt.relativePath)),original)
    const corrupt=Buffer.from('bad image bytes')
    const broken=(await call('POST','/v1/uploads',{...uploadData,clientKey:randomUUID(),hash:hash(Buffer.alloc(corrupt.length)),size:corrupt.length})).body
    await call('PUT',`/v1/uploads/${broken.id}/content`,corrupt,0)
    assert.equal((await call('POST',`/v1/uploads/${broken.id}/complete`,{})).status,422)
    assert.equal((await call('GET',`/v1/uploads/${broken.id}`)).body.offset,0)
    assert.equal((await call('POST',`/v1/uploads/${broken.id}/cancel`,{})).body.state,'cancelled')
    assert.equal((await call('POST',`/v1/uploads/${broken.id}/complete`,{})).status,409)
    const recoveryBytes=Buffer.from('recover committed file without receipt')
    const recovery=(await call('POST','/v1/uploads',{...uploadData,clientKey:randomUUID(),hash:hash(recoveryBytes),size:recoveryBytes.length})).body as UploadSession
    await call('PUT',`/v1/uploads/${recovery.id}/content`,recoveryBytes,0)
    const persisted=receiver.store.get<UploadSession>('session',recovery.id)!
    persisted.state='committing';receiver.store.put('session',persisted)
    await link(join(libraryPath,'.momentnest-incoming',`${recovery.id}.part`),join(libraryPath,persisted.relativePath))
    await receiver.close();receiver=new Receiver(data);await receiver.start(0,'127.0.0.1')
    assert.equal((await call('GET',`/v1/uploads/${recovery.id}`)).body.state,'complete')
    await writeFile(join(libraryPath,completed.body.receipt.relativePath),Buffer.from('externally corrupted'))
    assert.equal((await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(original),size:original.length}]})).body.results[0].receipt,null)
    const corruptStatus=(await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(original),size:original.length}]})).body.results[0]
    assert.equal(corruptStatus.receiptState,'corrupt');assert.equal(corruptStatus.previousReceipt.id,completed.body.receipt.id)
    // 用不存在的测试位置模拟外部文件缺失，保留所有实际测试文件。
    const historical=receiver.store.content<Receipt>(library.id,hash(original),original.length)!
    receiver.store.put('file',{...historical,relativePath:'2024-02-29/externally-missing.jpg'})
    const missing=(await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(original),size:original.length}]})).body.results[0]
    assert.equal(missing.receiptState,'missing');assert.equal(missing.previousReceipt.id,historical.id)
    receiver.store.put('library',{...library,path:join(directory,'offline-drive')})
    const offline=(await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(original),size:original.length}]})).body.results[0]
    assert.equal(offline.receiptState,'unavailable');assert.equal(offline.complete,false);assert.equal(offline.receipt,null)
    receiver.store.put('library',library);receiver.store.put('file',historical)
    const repair=(await call('POST','/v1/uploads',{...uploadData,clientKey:randomUUID()})).body
    assert.equal(repair.state,'receiving')
    await call('PUT',`/v1/uploads/${repair.id}/content`,original,0)
    assert.equal((await call('POST',`/v1/uploads/${repair.id}/complete`,{})).body.state,'complete')
    const otherLibraryPath=join(directory,'second-library')
    await mkdir(otherLibraryPath);await receiver.addDirectory(otherLibraryPath,'library')
    const otherLibrary=receiver.store.list<Library>('library').find(item=>item.id!==library.id)!
    const otherCheck=await call('POST','/v1/assets/check',{libraryId:otherLibrary.id,assets:[{hash:hash(original),size:original.length}]})
    assert.equal(otherCheck.body.results[0].receipt,null)
    assert.equal(otherCheck.body.results[0].matches.length,1)
    assert.equal(otherCheck.body.results[0].matches[0].libraryId,library.id)
    receiver.setCurrentLibrary(otherLibrary.id)
    const captureBatch=(await call('POST','/v1/batches',{clientKey:randomUUID(),libraryId:otherLibrary.id,mode:'capture'})).body
    const otherUpload=(await call('POST','/v1/uploads',{...uploadData,clientKey:randomUUID(),batchId:captureBatch.id,captureDate:'2023-05-01'})).body
    assert.equal(otherUpload.state,'receiving');assert.equal(otherUpload.archiveDate,'2023-05-01')
    await call('PUT',`/v1/uploads/${otherUpload.id}/content`,original,0)
    const otherReceipt=(await call('POST',`/v1/uploads/${otherUpload.id}/complete`,{})).body.receipt
    assert.equal(otherReceipt.libraryId,otherLibrary.id)
    assert.deepEqual(await readFile(join(otherLibraryPath,otherReceipt.relativePath)),original)
    await receiver.toggleDirectory('library',otherLibrary.id,false)
    assert.equal((await call('POST','/v1/assets/check',{libraryId:otherLibrary.id,assets:[{hash:hash(original),size:original.length}]})).status,404)
    assert.equal((await call('GET','/v1/receiver')).body.libraries.length,1)
    const otherPair=receiver.pairInfo()
    const other=(await call('POST','/v1/pair',{secret:otherPair.secret,name:'另一设备'},undefined,false)).body
    const previousToken=token;token=other.token
    const otherPhoneCheck=await call('POST','/v1/assets/check',{libraryId:library.id,assets:[{hash:hash(original),size:original.length}]})
    assert.ok(otherPhoneCheck.body.results[0].receipt)
    assert.equal((await call('GET',`/v1/uploads/${repair.id}`)).status,404)
    token=previousToken
    receiver.setAccepting(false)
    assert.equal((await call('POST','/v1/batches',{...batchData,clientKey:randomUUID()})).status,503)
    receiver.setAccepting(true)
    receiver.revoke(paired.body.deviceId)
    assert.equal((await call('GET','/v1/receiver')).status,401)
    assert.equal(validDate('2024-02-29'),true);assert.equal(validDate('../photos'),false)
  } finally {agent.destroy();await receiver.close()}
})
