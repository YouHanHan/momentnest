import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mediaResponse } from '../src/main/media-response.ts'
import { baby, date, query, similarQuery, watermark, ids, warningPage } from '../src/main/family-validation.ts'

test('视频预览按字节范围流式返回，拒绝越界与多范围请求',async()=>{
  const directory=join(process.cwd(),'.cache','tests',randomUUID());await mkdir(directory,{recursive:true})
  const path=join(directory,'video.mp4');await writeFile(path,Buffer.from('0123456789'))
  const response=await mediaResponse(path,'GET','bytes=2-5')
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 2-5/10');assert.equal(await response.text(),'2345')
  assert.equal(await (await mediaResponse(path,'GET','bytes=-3')).text(),'789')
  assert.equal((await mediaResponse(path,'GET','bytes=50-')).status,416)
  assert.equal((await mediaResponse(path,'GET','bytes=0-1,3-5')).status,416)
  assert.equal((await mediaResponse(path,'PUT',null)).status,405)
  assert.equal((await mediaResponse(path,'HEAD',null)).headers.get('content-length'),'10')
})

test('JPEG 别名文件预览正确返回 image/jpeg，HEAD 不要求解码原图',async()=>{
  const directory=join(process.cwd(),'.cache','tests',randomUUID());await mkdir(directory,{recursive:true})
  for(const extension of ['jfif','jpe']) {
    const path=join(directory,`preview.${extension}`);await writeFile(path,Buffer.from('synthetic-jpeg'))
    const response=await mediaResponse(path,'HEAD',null)
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg')
    assert.equal(await response.text(),'')
  }
})

test('照片预览返回原文件的完整字节，不转码、不移除元数据',async()=>{
  const directory=join(process.cwd(),'.cache','tests',randomUUID());await mkdir(directory,{recursive:true})
  const original=Buffer.from([0xff,0xd8,0xff,0xe1,0x00,0x08,0x45,0x78,0x69,0x66,0x00,0x00,0xff,0xd9])
  const path=join(directory,'original.jpg');await writeFile(path,original)
  const response=await mediaResponse(path,'GET',null)
  assert.equal(response.status,200)
  assert.equal(response.headers.get('content-type'),'image/jpeg')
  assert.equal(response.headers.get('content-length'),String(original.length))
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),original)
})

test('相册 IPC 参数拒绝路径、错误日期和未受限水印文本',()=>{
  assert.throws(()=>ids(['../../outside']))
  assert.throws(()=>date('2025-02-29'));assert.equal(date('2024-02-29'),'2024-02-29')
  assert.throws(()=>query({limit:1000000}));assert.throws(()=>query({from:'2025-04-31'}))
  assert.throws(()=>baby({id:'baby-1',name:'<script>\u0000',birthday:'2026-01-01',autoMatch:true,referenceFaces:[]}))
  assert.throws(()=>watermark({babyId:'baby-1',color:'url(secret)',opacity:1,fontSize:30,position:'bottom-left',showName:true,showAge:true,showDayCount:false,showDate:false}))
})

test('跳过原因 IPC 页码只接受受限正整数，并为未提供页码使用第一页',()=>{
  assert.equal(warningPage(undefined),1)
  assert.equal(warningPage(1),1)
  assert.equal(warningPage(1000000),1000000)
  for(const value of [0,-1,1.5,1000001,NaN,Infinity,'1',null,true,{},[]]) assert.throws(()=>warningPage(value),/数值参数超出范围/)
})

test('宝宝全部匹配 IPC 仅接受布尔开关，并要求宝宝标识且与仅看待确认互斥',()=>{
  const combined={babyId:'baby-one',libraryId:'library-one',includeCandidates:true,candidates:false}
  assert.deepEqual(query(combined),combined)
  assert.deepEqual(query({includeCandidates:false,candidates:true}),{includeCandidates:false,candidates:true})
  for(const value of ['true',1,0,null,{},[]]) assert.throws(()=>query({babyId:'baby-one',includeCandidates:value}),/开关参数无效/)
  assert.throws(()=>query({includeCandidates:true}),/宝宝标识/)
  assert.throws(()=>query({babyId:'baby-one',includeCandidates:true,candidates:true}),/同时限定待确认/)
  for(const babyId of ['',null,1,'../../outside']) assert.throws(()=>query({babyId,includeCandidates:true}),/记录标识无效/)
})

test('相似人脸 IPC 固定参考与授权范围，拒绝额外查询字段和非法分页类型',()=>{
  const reference={assetId:'a'.repeat(64)+'-1024',faceId:'b'.repeat(64)}
  assert.deepEqual(similarQuery({...reference,scope:'all'}),{...reference,scope:'all'})
  const library={...reference,scope:'library',libraryId:'library-one',page:2,limit:50,kind:'video',order:'asc'}
  assert.deepEqual(similarQuery(library),library)
  assert.equal(similarQuery({...reference,scope:'all',page:1000000,limit:100}).page,1000000)
  for(const source of [null,[],{}, {faceId:reference.faceId,scope:'all'}, {assetId:reference.assetId,scope:'all'}, reference, {...reference,scope:'cloud'}, {...reference,scope:'library'}, {...reference,scope:'all',libraryId:'library-one'}]) assert.throws(()=>similarQuery(source))
  for(const field of ['path','embedding','personId','from','to','search','date','babyId','favorite']) assert.throws(()=>similarQuery({...reference,scope:'all',[field]:'untrusted'}),/不支持/)
  for(const invalid of ['../../outside','C:/Private','a'.repeat(81),'',null,1]) {
    assert.throws(()=>similarQuery({...reference,scope:'all',assetId:invalid}))
    assert.throws(()=>similarQuery({...reference,scope:'all',faceId:invalid}))
    assert.throws(()=>similarQuery({...reference,scope:'library',libraryId:invalid}))
  }
  for(const page of [0,-1,1.5,1000001,NaN,Infinity,'1',null]) assert.throws(()=>similarQuery({...reference,scope:'all',page}))
  for(const limit of [0,-1,1.5,101,NaN,Infinity,'50',null]) assert.throws(()=>similarQuery({...reference,scope:'all',limit}))
  for(const kind of ['image','all','',null]) assert.throws(()=>similarQuery({...reference,scope:'all',kind}))
  for(const order of ['newest','ASC','',null]) assert.throws(()=>similarQuery({...reference,scope:'all',order}))
})
