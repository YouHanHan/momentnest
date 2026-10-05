import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Agent, request } from 'node:https'
import sharp from 'sharp'
import { Receiver } from '../src/service/receiver.ts'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import type { Library, Receipt } from '../src/service/types.ts'
import type { BabyProfile, FamilyJob, WatermarkOptions } from '../src/shared/family.ts'

async function waitJobs(catalog: MediaCatalog): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (!(await catalog.familyState()).jobs.some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('测试整理任务未完成。')
}

async function sample(path: string, color: string): Promise<void> {
  await sharp({ create: { width: 80, height: 60, channels: 3, background: color } })
    .withExif({ IFD2: { DateTimeOriginal: '2026:04:10 09:30:00' } }).jpeg().toFile(path)
}

test('当前库持久化，禁用或离线保留选择，不自动回退其他库', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-current-library-'))
  const data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second')
  await Promise.all([data, first, second].map(path => mkdir(path)))
  let receiver = new Receiver(data)
  try {
    assert.equal((receiver.snapshot() as any).currentLibraryId, null)
    await receiver.addDirectory(first, 'library'); await receiver.addDirectory(second, 'library')
    const libraries = receiver.store.list<Library>('library'), firstLibrary = libraries.find(item => item.path === first)!, secondLibrary = libraries.find(item => item.path === second)!
    assert.equal((receiver.snapshot() as any).currentLibraryId, firstLibrary.id)
    receiver.setCurrentLibrary(secondLibrary.id)
    assert.equal((receiver.snapshot() as any).currentLibraryAvailable, true)
    await receiver.close(); receiver = new Receiver(data)
    assert.equal((receiver.snapshot() as any).currentLibraryId, secondLibrary.id)
    await receiver.toggleDirectory('library', secondLibrary.id, false)
    assert.equal((receiver.snapshot() as any).currentLibraryId, secondLibrary.id)
    assert.equal((receiver.snapshot() as any).currentLibraryAvailable, false)
    assert.throws(() => receiver.setCurrentLibrary(secondLibrary.id), /停用/)
    await receiver.toggleDirectory('library', secondLibrary.id, true)
    receiver.store.put('library', { ...secondLibrary, path: join(directory, 'offline-volume') })
    assert.equal((receiver.snapshot() as any).currentLibraryId, secondLibrary.id)
    assert.equal((receiver.snapshot() as any).currentLibraryAvailable, false)
    receiver.setCurrentLibrary(firstLibrary.id)
    assert.equal((receiver.snapshot() as any).currentLibraryAvailable, true)
  } finally { await receiver.close() }
})

test('图库、人物与候选按库隔离，共享识别缓存且预览不回退别库位置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-library-scope-'))
  const data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second'), empty = join(directory, 'empty')
  await Promise.all([data, first, second, empty].map(path => mkdir(path)))
  await sample(join(first, 'shared.jpg'), '#889966')
  await writeFile(join(second, 'renamed.jpg'), await readFile(join(first, 'shared.jpg')))
  await sample(join(first, 'first-only.jpg'), '#bb6622'); await sample(join(second, 'second-only.jpg'), '#2266bb')
  const store = new Store(join(data, 'receiver.sqlite'))
  let detections = 0
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { detections++; return [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3, score: 0.95, embedding: [1, 0] }] } }
  const catalog = new MediaCatalog(store, data, 'receiver-test', undefined, engine)
  const firstId = randomUUID(), secondId = randomUUID(), emptyId = randomUUID()
  for (const [id, path] of [[firstId, first], [secondId, second], [emptyId, empty]]) store.put('library', { id, path, name: id, enabled: true })
  try {
    catalog.scanMedia(firstId); await waitJobs(catalog)
    assert.equal(catalog.queryMedia({ libraryId: firstId }).total, 2)
    assert.equal(catalog.queryMedia({ libraryId: secondId }).total, 0)
    catalog.scanMedia(secondId); await waitJobs(catalog)
    assert.equal(catalog.queryMedia({}).total, 3)
    const firstPage = catalog.queryMedia({ libraryId: firstId }), shared = firstPage.items.find(asset => asset.filename === 'shared.jpg')!, firstOnly = firstPage.items.find(asset => asset.filename === 'first-only.jpg')!
    assert.equal(shared.locations.length, 1); assert.equal(shared.locations[0].libraryId, firstId)
    assert.equal(catalog.queryMedia({ libraryId: secondId, search: 'renamed' }).items[0].id, shared.id)
    assert.equal(catalog.queryMedia({ libraryId: secondId, search: 'renamed' }).items[0].filename, 'renamed.jpg')
    assert.equal(catalog.queryMedia({ libraryId: firstId, search: 'renamed' }).total, 0)
    assert.equal(catalog.queryMedia({ libraryId: secondId, search: 'shared' }).total, 0)
    assert.equal(await catalog.mediaPath(shared.id, false, secondId), join(second, 'renamed.jpg'))
    await assert.rejects(catalog.mediaPath(firstOnly.id, false, secondId), /不在所选照片库/)
    await assert.rejects(catalog.mediaPath(firstOnly.id, true, secondId), /不在所选照片库/)
    catalog.analyzeFaces(firstId); await waitJobs(catalog); assert.equal(detections, 2)
    catalog.analyzeFaces(secondId); await waitJobs(catalog); assert.equal(detections, 3, '另一库中的相同内容复用已完成人脸结果')
    const receipt: Receipt = { id: randomUUID(), receiverId: 'receiver-test', libraryId: secondId, hash: shared.hash, size: shared.size, relativePath: 'renamed.jpg', filename: '手机原名.jpg', savedAt: new Date().toISOString(), source: 'phone' }
    store.put('file', receipt); catalog.scanMedia(secondId); await waitJobs(catalog)
    assert.equal(catalog.queryMedia({ libraryId: secondId, search: '手机原名' }).items[0].id, shared.id)
    assert.equal(catalog.queryMedia({ libraryId: secondId, search: '手机原名' }).items[0].filename, '手机原名.jpg')
    assert.equal(catalog.queryMedia({ libraryId: firstId }).items.find(asset => asset.id === shared.id)!.filename, 'shared.jpg')
    assert.equal(detections, 3, '按库命名和扫描不会改变共享人脸结果')
    const baby: BabyProfile = { id: randomUUID(), name: '测试宝宝', birthday: '2026-03-19', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyMembership(baby.id, [shared.id], true)
    store.put('familyDecision', { id: `${baby.id}:${firstOnly.id}`, babyId: baby.id, assetId: firstOnly.id, state: 'candidate', origin: 'recognition', updatedAt: new Date().toISOString() })
    assert.equal((await catalog.familyState(firstId)).candidateCount, 1)
    assert.equal((await catalog.familyState(secondId)).candidateCount, 0)
    assert.equal((await catalog.familyState(firstId)).people[0].assetCount, 2)
    assert.equal((await catalog.familyState(secondId)).people[0].assetCount, 2)
    assert.equal((await catalog.familyState(emptyId)).people.length, 0)
    assert.equal((await catalog.familyState(emptyId)).photoCount, 0)
    assert.equal(catalog.queryMedia({ libraryId: secondId, babyId: baby.id }).total, 1)
    const options: WatermarkOptions = { babyId: baby.id, position: 'bottom-right', fontSize: 20, color: '#ffffff', opacity: 0.9, showName: true, showAge: true, showDayCount: false, showDate: true }
    assert.match((await catalog.previewWatermark(shared.id, options, secondId)).dataUrl!, /^data:image\/jpeg;base64,/)
    store.put('library', { id: firstId, path: join(directory, 'offline-first'), name: '离线库', enabled: true })
    await assert.rejects(catalog.mediaPath(shared.id, true, firstId), /目录不可用/)
    await assert.rejects(catalog.previewWatermark(shared.id, options, firstId), /目录不可用/)
    assert.equal(await catalog.mediaPath(shared.id, false, secondId), join(second, 'renamed.jpg'))
    assert.equal(catalog.queryMedia({ libraryId: firstId }).items.find(asset => asset.id === shared.id)!.available, false)
    assert.equal(catalog.queryMedia({ libraryId: secondId }).items.find(asset => asset.id === shared.id)!.available, true)
  } finally { await catalog.close(); store.close() }
})

test('新复制计划默认当前库，切库后执行旧计划保持原库与日期', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-import-library-'))
  const data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second'), source = join(directory, 'source')
  await Promise.all([data, first, second, source].map(path => mkdir(path)))
  await sample(join(source, 'original.jpg'), '#aa8844')
  const original = await readFile(join(source, 'original.jpg')), receiver = new Receiver(data)
  try {
    await receiver.addDirectory(first, 'library'); await receiver.addDirectory(second, 'library'); await receiver.addDirectory(source, 'root')
    const firstLibrary = receiver.store.list<Library>('library').find(item => item.path === first)!, secondLibrary = receiver.store.list<Library>('library').find(item => item.path === second)!
    const root = receiver.store.list<{ id: string }>('root')[0]
    const plan = receiver.family.prepareImport(root.id, 'copy'); await waitJobs(receiver.family)
    assert.equal(plan.libraryId, firstLibrary.id)
    receiver.setCurrentLibrary(secondLibrary.id)
    receiver.family.executeImport(plan.id); await waitJobs(receiver.family)
    const receipt = receiver.store.list<Receipt>('file')[0]
    assert.equal(receipt.libraryId, firstLibrary.id); assert.match(receipt.relativePath, /^2026-04-10\//)
    assert.deepEqual(await readFile(join(first, receipt.relativePath)), original)
    assert.deepEqual(await readFile(join(source, 'original.jpg')), original)
    assert.equal(receiver.family.queryMedia({ libraryId: secondLibrary.id }).total, 0)
    assert.equal(receiver.family.queryMedia({ libraryId: firstLibrary.id }).total, 1)
    await receiver.addDirectory(second, 'root')
    const sameRoot = receiver.store.list<{ id: string; path: string }>('root').find(item => item.path === second)!
    assert.throws(() => receiver.family.prepareImport(sameRoot.id, 'copy'), /同一|互不包含|相同/)
  } finally { await receiver.close() }
})

test('父子照片库分别扫描同一文件，位置归属不覆盖且旧缓存正常兼容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-nested-library-'))
  const data = join(directory, 'state'), parent = join(directory, 'photos'), child = join(parent, 'baby')
  await mkdir(data); await mkdir(child, { recursive: true }); await sample(join(child, 'shared.jpg'), '#669977')
  const store = new Store(join(data, 'receiver.sqlite')), parentId = randomUUID(), childId = randomUUID()
  store.put('library', { id: parentId, path: parent, name: '家庭', enabled: true }); store.put('library', { id: childId, path: child, name: '宝宝', enabled: true })
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { return [] } }
  let catalog = new MediaCatalog(store, data, 'receiver-test', undefined, engine)
  try {
    catalog.scanMedia(parentId); await waitJobs(catalog)
    const indexed = store.list<any>('familyAsset')[0]
    indexed.locations[0].id = createHash('sha256').update(join(child, 'shared.jpg').toLowerCase()).digest('hex')
    store.put('familyAsset', indexed)
    await catalog.close(); catalog = new MediaCatalog(store, data, 'receiver-test', undefined, engine)
    catalog.scanMedia(childId); await waitJobs(catalog)
    assert.equal(catalog.queryMedia({ libraryId: parentId }).total, 1)
    assert.equal(catalog.queryMedia({ libraryId: childId }).total, 1)
    assert.equal(catalog.queryMedia({}).total, 1)
    catalog.scanMedia(parentId); await waitJobs(catalog)
    assert.equal(catalog.queryMedia({}).items[0].locations.length, 2)
    assert.equal(catalog.queryMedia({ libraryId: parentId }).items[0].locations[0].available, true)
    assert.equal(catalog.queryMedia({ libraryId: childId }).items[0].locations[0].available, true)
    assert.equal(await catalog.mediaPath(indexed.id, false, parentId), join(child, 'shared.jpg'))
    assert.equal(await catalog.mediaPath(indexed.id, false, childId), join(child, 'shared.jpg'))
  } finally { await catalog.close(); store.close() }
})

test('真实 HTTPS 暴露电脑当前库，旧上传批次切库后保持原目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-library-http-'))
  const data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second')
  await Promise.all([data, first, second].map(path => mkdir(path)))
  const receiver = new Receiver(data)
  await receiver.addDirectory(first, 'library'); await receiver.addDirectory(second, 'library'); await receiver.start(0, '127.0.0.1')
  const identity = JSON.parse(await readFile(join(data, 'tls-identity.json'), 'utf8')), agent = new Agent({ ca: identity.cert, checkServerIdentity: () => undefined })
  let token = ''
  const call = (method: string, path: string, value?: unknown): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(value) ? value : value === undefined ? undefined : Buffer.from(JSON.stringify(value))
    const req = request({ hostname: '127.0.0.1', port: receiver.port, path, method, agent, headers: { ...(bytes ? { 'content-length': bytes.length } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }))
    }); req.on('error', reject); req.end(bytes)
  })
  try {
    token = (await call('POST', '/v1/pair', { secret: receiver.pairInfo().secret, name: '测试手机' })).body.token
    const libraries = receiver.store.list<Library>('library'), firstId = libraries.find(item => item.path === first)!.id, secondId = libraries.find(item => item.path === second)!.id
    const batchData = { clientKey: randomUUID(), libraryId: firstId, mode: 'manual', manualDate: '2026-09-30' }
    const batch = (await call('POST', '/v1/batches', batchData)).body
    receiver.setCurrentLibrary(secondId)
    const snapshot = (await call('GET', '/v1/receiver')).body
    assert.equal(snapshot.currentLibraryId, secondId); assert.equal(snapshot.currentLibraryAvailable, true)
    assert.equal((await call('POST', '/v1/batches', { ...batchData, clientKey: randomUUID() })).status, 409, '切库后禁止在旧库新建批次')
    const resumed = (await call('POST', '/v1/batches', batchData)).body
    assert.equal(resumed.id, batch.id); assert.equal(resumed.libraryId, firstId); assert.equal(resumed.manualDate, '2026-09-30')
    const newer = (await call('POST', '/v1/batches', { clientKey: randomUUID(), libraryId: snapshot.currentLibraryId, mode: 'capture' })).body
    assert.equal(newer.libraryId, secondId)
    const currentLibrary = receiver.store.get<Library>('library', secondId)!
    receiver.store.put('library', { ...currentLibrary, path: join(directory, 'offline-current') })
    assert.equal((await call('POST', '/v1/batches', { clientKey: randomUUID(), libraryId: secondId, mode: 'capture' })).status, 409, '当前库离线禁止创建新批次')
    assert.equal((await call('POST', '/v1/batches', batchData)).status, 200, '当前库离线不影响旧库批次恢复')
    receiver.store.put('library', currentLibrary)
    await receiver.toggleDirectory('library', secondId, false)
    assert.equal((await call('POST', '/v1/batches', { clientKey: randomUUID(), libraryId: secondId, mode: 'capture' })).status, 409, '当前库停用禁止创建新批次')
    assert.equal((await call('POST', '/v1/batches', batchData)).status, 200)
    await receiver.toggleDirectory('library', secondId, true)
    const original = Buffer.from('original'), hash = createHash('sha256').update(original).digest('hex')
    const upload = await call('POST', '/v1/uploads', { clientKey: randomUUID(), batchId: batch.id, filename: 'original.jpg', hash, size: original.length })
    assert.equal(upload.status, 200); assert.equal(upload.body.libraryId, firstId); assert.equal(upload.body.archiveDate, '2026-09-30')
    await call('PUT', `/v1/uploads/${upload.body.id}/content?offset=0`, original)
    const completed = (await call('POST', `/v1/uploads/${upload.body.id}/complete`, {})).body
    assert.equal(completed.receipt.batchId, batch.id)
    const { batchId: _, ...legacy } = receiver.store.get<Receipt>('file', completed.receipt.id)!
    receiver.store.put('file', legacy)
    assert.equal((receiver.snapshot() as any).files.find((file: Receipt) => file.id === legacy.id).batchId, batch.id)
    assert.equal(receiver.store.get<Receipt>('file', legacy.id)!.batchId, undefined, '读取旧批次关联不批量修改历史回执')
    assert.deepEqual(await readFile(join(first, completed.receipt.relativePath)), original)
  } finally { agent.destroy(); await receiver.close() }
})

test('处理任务按首次插入倒序取最近25条，先筛选照片库且更新旧错误不提升顺序', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-job-order-'))
  const store = new Store(join(directory, 'receiver.sqlite'))
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { return [] } }
  const catalog = new MediaCatalog(store, directory, 'receiver-test', undefined, engine)
  const firstId = randomUUID(), secondId = randomUUID(), emptyId = randomUUID()
  for (const id of [firstId, secondId, emptyId]) store.put('library', { id, path: directory, name: id, enabled: true })
  const legacy: FamilyJob = { id: 'job-999', kind: 'scan', state: 'error', processed: 7005, total: 7005, label: '旧版扫描', error: '媒体大小须在 1 字节到 2 GiB 之间。' }
  const firstJobs: FamilyJob[] = [], secondJobs: FamilyJob[] = []
  try {
    store.put('familyJob', legacy)
    for (let index = 1; index <= 27; index++) {
      const job: FamilyJob = { id: `job-${999 - index}`, kind: 'scan', state: 'done', processed: index, total: index, label: `当前库扫描${index}`, error: '', libraryId: firstId }
      firstJobs.push(job); store.put('familyJob', job)
    }
    for (let index = 1; index <= 40; index++) {
      const job: FamilyJob = { id: `job-${972 - index}`, kind: 'scan', state: 'done', processed: index, total: index, label: `其他库扫描${index}`, error: '', libraryId: secondId }
      secondJobs.push(job); store.put('familyJob', job)
    }
    const latestFirst = firstJobs.slice(-25).reverse().map(job => job.id)
    assert.deepEqual((await catalog.familyState(firstId)).jobs.map(job => job.id), latestFirst, '其他库较新的40条不能抢占当前库的25条范围')
    assert.deepEqual((await catalog.familyState()).jobs.map(job => job.id), secondJobs.slice(-25).reverse().map(job => job.id), '插入更晚的任务排在前面，不按故意逆序的标识排序')
    store.put('familyJob', { ...legacy, label: '旧版扫描更新说明' })
    assert.equal(store.listByInsertion<FamilyJob>('familyJob').at(-1)!.id, legacy.id, '更新旧记录保留首次插入顺序')
    assert.deepEqual((await catalog.familyState(firstId)).jobs.map(job => job.id), latestFirst)
    const historical = (await catalog.familyState(emptyId)).jobs
    assert.equal(historical.length, 1); assert.equal(historical[0].id, legacy.id); assert.equal(historical[0].libraryId, undefined)
    assert.equal(historical[0].state, 'error'); assert.equal(historical[0].label, '旧版扫描更新说明')
    assert.equal(store.list<FamilyJob>('familyJob').length, 68, '历史记录全部保留，不补写时间字段')
    assert.equal(store.get<FamilyJob>('familyJob', legacy.id)!.error, legacy.error)
  } finally { await catalog.close(); store.close() }
})
