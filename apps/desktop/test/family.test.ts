import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { Agent, request } from 'node:https'
import sharp from 'sharp'
import exifr from 'exifr'
import { ffmpegPath } from '@momentnest/media-tools'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { babyAge, metadataDate, readMetadata, watermarkOverlay, watermarkPreview, watermarkText } from '../src/service/media-tools.ts'
import { contentIdentity, hashFile, localMediaIdentity } from '../src/service/files.ts'
import { Receiver } from '../src/service/receiver.ts'
import type { BabyProfile, FamilyJob, ImportPlan, WatermarkOptions } from '../src/shared/family.ts'
import type { Receipt } from '../src/service/types.ts'
import { copyDirectoryError } from '../src/shared/import-paths.ts'

const waitJobs = async (catalog: MediaCatalog): Promise<void> => {
  for (let index = 0; index < 600; index++) {
    if (!(await catalog.familyState()).jobs.some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('相册任务未在测试时限内完成。')
}
const sample = async (path: string, color: string, date?: string) => {
  let image = sharp({ create: { width: 320, height: 240, channels: 3, background: color } })
  if (date) image = image.withExif({ IFD2: { DateTimeOriginal: date } })
  await image.jpeg({ quality: 90 }).toFile(path)
}
const stubEngine = {
  async ready() { return { ready: true, error: '' } },
  async detect(path: string) {
    const embedding = path.includes('candidate') ? [0.5, Math.sqrt(0.75)] : [1, 0]
    return [{ x: 0.2, y: 0.1, width: 0.3, height: 0.4, score: 0.95, embedding }]
  },
}

test('月龄使用日历月，处理月底、闰年和出生前日期', () => {
  assert.deepEqual(babyAge('2024-01-31', '2024-02-29'), { months: 1, days: 0, totalDays: 29 })
  assert.deepEqual(babyAge('2024-01-31', '2024-03-01'), { months: 1, days: 1, totalDays: 30 })
  assert.deepEqual(babyAge('2024-02-29', '2025-02-28'), { months: 12, days: 0, totalDays: 365 })
  assert.throws(() => babyAge('2024-03-01', '2024-02-29'), /早于/)
  assert.equal(metadataDate('2024:03:10 23:59:59'), '2024-03-10')
  assert.equal(metadataDate('2024-03-10T23:59:59-09:00'), '2024-03-10')
  assert.equal(metadataDate('2024:02:30 12:00:00'), null)
})

test('真实目录导入：日期冻结、原字节校验、多位置去重、水印副本和持久化', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-family-')), source = join(directory, 'source'), destination = join(directory, 'archive'), output = join(directory, 'output'), data = join(directory, 'state')
  await Promise.all([source, destination, output, data].map(path => mkdir(path)))
  const original = join(source, 'original.jpg'), fallback = join(source, 'creation.jpg')
  await sample(original, '#cc9988', '2024:03:10 09:30:00'); await sample(fallback, '#113355')
  await writeFile(join(source, 'renamed.jpg'), await readFile(original))
  let store = new Store(join(data, 'receiver.sqlite')), catalog = new MediaCatalog(store, data, 'receiver-test', undefined, stubEngine)
  const rootId = randomUUID(), libraryId = randomUUID()
  store.put('root', { id: rootId, path: source, enabled: true, state: 'pending', count: 0, error: '', scannedAt: null })
  store.put('library', { id: libraryId, path: destination, name: '测试归档', enabled: true })
  try {
    const birthDate = (await readMetadata(fallback, 'photo')).creationDate
    const plan = catalog.prepareImport(rootId, 'copy', libraryId) as ImportPlan & { state: string }
    assert.equal(plan.state, 'preparing'); assert.throws(() => catalog.executeImport(plan.id), /等待预扫描/)
    await waitJobs(catalog)
    const ready = (await catalog.familyState()).importPlans!.find(item => item.id === plan.id)!
    assert.equal(ready.state, 'ready'); assert.equal(ready.count, 3); assert.equal(ready.creationDates, 1)
    assert.equal(ready.preview.find(item => item.filename === 'original.jpg')!.date, '2024-03-10')
    assert.equal(ready.preview.find(item => item.filename === 'creation.jpg')!.date, birthDate)
    catalog.executeImport(plan.id); await waitJobs(catalog)
    assert.equal((await catalog.familyState()).jobs[0]!.state, 'done')
    const page = catalog.queryMedia({ limit: 100 })
    assert.equal(page.total, 2, '同一原图改名和复制归档不会增加资产数量')
    const photo = page.items.find(item => item.captureDate === '2024-03-10')!
    assert.equal(photo.locations.length, 3); assert.equal(photo.dateConfirmed, true)
    const saved = store.list<{ relativePath: string; hash: string; size: number }>('file')
    assert.equal(saved.length, 2)
    for (const file of saved) assert.equal(createHash('sha256').update(await readFile(join(destination, file.relativePath))).digest('hex'), file.hash)
    catalog.executeImport(plan.id); await waitJobs(catalog); assert.equal(store.list('file').length, 2)
    const baby: BabyProfile = { id: randomUUID(), name: '小宝', birthday: '2024-01-31', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyMembership(baby.id, [photo.id], true)
    const options: WatermarkOptions = { babyId: baby.id, position: 'bottom-right', fontSize: 48, color: '#ffffff', opacity: 0.9, showName: true, showAge: true, showDayCount: false, showDate: true }
    const originalHash = createHash('sha256').update(await readFile(original)).digest('hex')
    assert.match((await catalog.previewWatermark(photo.id, options)).dataUrl!, /^data:image\/jpeg;base64,/)
    const exported = await catalog.exportWatermark([photo.id], options, output)
    assert.equal(exported.length, 1); assert.ok((await stat(exported[0].path!)).size > 0)
    assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'), originalHash)
    assert.notEqual(createHash('sha256').update(await readFile(exported[0].path!)).digest('hex'), originalHash)
    const creationAsset = page.items.find(item => item.dateSource === 'creation')!
    catalog.setBabyMembership(baby.id, [creationAsset.id], true)
    await assert.rejects(catalog.previewWatermark(creationAsset.id, options), /确认拍摄日期/)
    catalog.setMediaDate(creationAsset.id, '2024-03-11'); catalog.setFavorite(photo.id, true)
    assert.equal(catalog.queryMedia({ babyId: baby.id, datePending: true }).total, 0)
    assert.equal(catalog.queryMedia({ favorite: true }).total, 1)
    const sync = catalog.sync({ babies: [], decisions: [], limit: 1 })
    assert.equal(sync.assets.length, 1); assert.equal(sync.nextCursor, 1)
    const json = JSON.stringify(sync)
    assert.ok(!json.includes(source)); assert.ok(!json.includes(destination)); assert.ok(!json.includes('embedding'))
    assert.equal(sync.babies[0].referenceFaces.length, 0)
    const correctedAt = new Date(Date.now() + 1500).toISOString()
    catalog.sync({ babies: [], decisions: [], dates: [{ assetId: photo.id, date: '2024-03-15', updatedAt: correctedAt }] })
    assert.equal(catalog.queryMedia({ favorite: true }).items[0].date, '2024-03-15')
    catalog.sync({ babies: [], decisions: [], dates: [{ assetId: photo.id, date: '2024-03-12', updatedAt: new Date(Date.now() - 1500).toISOString() }] })
    assert.equal(catalog.queryMedia({ favorite: true }).items[0].date, '2024-03-15')
    const pendingAssetId = `${'a'.repeat(64)}-1024`
    catalog.sync({ babies: [], decisions: [], dates: [{ assetId: pendingAssetId, date: '2024-03-16', updatedAt: correctedAt }] })
    assert.equal(catalog.sync({ babies: [], decisions: [] }).dates!.length, 3)
    assert.throws(() => catalog.sync({ babies: [{ ...baby, autoMatch: 'false' as unknown as boolean }], decisions: [] }), /宝宝同步数据无效/)
    await catalog.close(); store.close()
    store = new Store(join(data, 'receiver.sqlite')); catalog = new MediaCatalog(store, data, 'receiver-test', undefined, stubEngine)
    assert.equal(catalog.queryMedia({ favorite: true }).total, 1); assert.equal((await catalog.familyState()).babies.length, 1)
    store.put('root', { id: rootId, path: source, enabled: false, state: 'ready' }); store.put('library', { id: libraryId, path: destination, name: '测试归档', enabled: false })
    await assert.rejects(catalog.mediaPath(photo.id), /目录不可用/)
  } finally { await catalog.close(); store.close() }
})

test('人物参考匹配保留人工排除，低置信度只进入候选且不导出特征向量', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-faces-')), source = join(directory, 'source'), data = join(directory, 'data')
  await mkdir(source); await mkdir(data)
  await sample(join(source, 'first.jpg'), '#ffaaaa', '2024:03:10 10:00:00')
  await sample(join(source, 'excluded.jpg'), '#aaffaa', '2024:03:11 10:00:00')
  await sample(join(source, 'candidate.jpg'), '#aaaaff', '2024:03:12 10:00:00')
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine)
  const rootId = randomUUID(); store.put('root', { id: rootId, path: source, enabled: true, state: 'pending' })
  try {
    catalog.scanMedia(); await waitJobs(catalog); catalog.analyzeFaces(); await waitJobs(catalog)
    const assets = catalog.queryMedia({ limit: 100 }).items, first = assets.find(item => item.filename === 'first.jpg')!, excluded = assets.find(item => item.filename === 'excluded.jpg')!, candidate = assets.find(item => item.filename === 'candidate.jpg')!
    assert.equal(first.faceState, 'done'); assert.equal(first.faces.length, 1)
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2024-01-01', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyMembership(baby.id, [excluded.id], false); catalog.setBabyReference(baby.id, first.id, first.faces[0].id); catalog.matchBaby(baby.id)
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 1)
    assert.equal(catalog.queryMedia({ babyId: baby.id, candidates: true }).items[0].id, candidate.id)
    catalog.namePerson(first.faces[0].personId!, '家人')
    assert.equal(catalog.queryMedia({ personId: first.faces[0].personId }).items.some(item => item.faces.some(face => face.personName === '家人')), true)
    assert.ok(!JSON.stringify(catalog.queryMedia({})).includes('embedding'))
    const newer = new Date(Date.now() + 1000).toISOString()
    catalog.sync({ babies: [], decisions: [{ id: `${baby.id}:${excluded.id}`, babyId: baby.id, assetId: excluded.id, state: 'included', origin: 'recognition', updatedAt: newer }] })
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 1, '其他端识别结果不能变成人工归属')
    catalog.sync({ babies: [], decisions: [{ id: `${baby.id}:${excluded.id}`, babyId: baby.id, assetId: excluded.id, state: 'included', origin: 'manual', updatedAt: newer }] })
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 2)
    catalog.matchBaby(baby.id); assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 2)
    assert.ok(catalog.sync({ babies: [], decisions: [] }).decisions.every(decision => decision.origin === 'manual' && decision.state !== 'candidate'))
  } finally { await catalog.close(); store.close() }
})

test('视频原字节传输与日期元数据，认证同步不泄露电脑路径，范围读取可恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-video-')), data = join(directory, 'data'), library = join(directory, 'library'), video = join(directory, 'sample.mp4')
  await mkdir(data); await mkdir(library)
  await new Promise<void>((resolve, reject) => execFile(ffmpegPath!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1', '-c:v', 'libx264', '-metadata', 'creation_time=2024-03-10T23:30:00-09:00', video], { windowsHide: true }, error => error ? reject(error) : resolve()))
  const metadata = await readMetadata(video, 'video'); assert.ok(metadata.duration > 0); assert.equal(metadata.width, 320); assert.ok(metadata.captureDate)
  const receiver = new Receiver(data); await receiver.addDirectory(library, 'library'); await receiver.start(0, '127.0.0.1')
  const cert = JSON.parse(await readFile(join(data, 'tls-identity.json'), 'utf8')).cert
  const agent = new Agent({ ca: cert, checkServerIdentity: () => undefined }); let token = ''
  const call = (method: string, path: string, value?: unknown, auth = true, range?: string): Promise<{ status: number; bytes: Buffer; body: any }> => new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(value) ? value : value === undefined ? undefined : Buffer.from(JSON.stringify(value))
    const req = request({ hostname: '127.0.0.1', port: receiver.port, path, method, agent, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(bytes ? { 'content-length': bytes.length } : {}), ...(range ? { range } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode!, bytes, body: String(res.headers['content-type']).includes('json') ? JSON.parse(bytes.toString()) : undefined }) })
    }); req.on('error', reject); req.end(bytes)
  })
  try {
    assert.equal((await call('POST', '/v1/family/sync', { babies: [], decisions: [] }, false)).status, 401)
    const paired = await call('POST', '/v1/pair', { secret: receiver.pairInfo().secret, name: '测试手机' }, false); token = paired.body.token
    const libraryId = receiver.store.list<{ id: string }>('library')[0].id, bytes = await readFile(video), hash = createHash('sha256').update(bytes).digest('hex')
    const batch = (await call('POST', '/v1/batches', { libraryId, mode: 'capture', clientKey: randomUUID() })).body
    const upload = (await call('POST', '/v1/uploads', { batchId: batch.id, clientKey: randomUUID(), filename: 'sample.mp4', hash, size: bytes.length, captureDate: metadata.captureDate, creationDate: metadata.creationDate })).body
    assert.equal(upload.kind, 'video'); assert.equal(upload.archiveDate, metadata.captureDate)
    await call('PUT', `/v1/uploads/${upload.id}/content?offset=0`, bytes)
    const complete = await call('POST', `/v1/uploads/${upload.id}/complete`, {})
    assert.equal(complete.status, 200); assert.equal(complete.body.receipt.hash, hash)
    for (let index = 0; index < 200 && !receiver.family.queryMedia({}).total; index++) await new Promise(resolve => setTimeout(resolve, 25))
    const sync = await call('POST', '/v1/family/sync', { babies: [], decisions: [], limit: 100 })
    assert.equal(sync.body.assets[0].id, `${hash}-${bytes.length}`); assert.ok(!sync.bytes.toString().includes(library))
    const assetId = sync.body.assets[0].id
    assert.equal((await call('GET', `/v1/family/assets/${assetId}/thumb`)).status, 200)
    const range = await call('GET', `/v1/family/assets/${assetId}/content`, undefined, true, 'bytes=0-99')
    assert.equal(range.status, 206); assert.deepEqual(range.bytes, bytes.subarray(0, 100))
    assert.equal((await call('GET', `/v1/family/assets/${assetId}/content`, undefined, false)).status, 401)
    assert.equal((await call('GET', `/v1/family/assets/${assetId}/content`, undefined, true, 'bytes=999999999-')).status, 416)
    assert.deepEqual((await call('GET', `/v1/family/assets/${assetId}/content`)).bytes, bytes)
  } finally { agent.destroy(); await receiver.close() }
})

test('人工决定与日期独立分页，未收到的原图也保留人工记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-sync-')), store = new Store(join(directory, 'family.sqlite')), catalog = new MediaCatalog(store, directory, 'receiver', undefined, stubEngine)
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [], updatedAt: new Date().toISOString() }
  catalog.saveBaby(baby)
  try {
    const updatedAt = new Date(Date.now() + 1000).toISOString()
    for (let start = 0; start < 501; start += 100) {
      const ids = Array.from({ length: Math.min(100, 501 - start) }, (_, index) => `${createHash('sha256').update(String(start + index)).digest('hex')}-512`)
      catalog.sync({ babies: [], decisions: ids.map(assetId => ({ id: `${baby.id}:${assetId}`, babyId: baby.id, assetId, state: 'excluded', origin: 'manual', updatedAt })), dates: ids.map(assetId => ({ assetId, date: '2024-03-10', updatedAt })) })
    }
    const first = catalog.sync({ babies: [], decisions: [] }), second = catalog.sync({ babies: [], decisions: [], decisionCursor: 500, dateCursor: 500 })
    assert.equal(first.decisions.length, 500); assert.equal(first.nextDecisionCursor, 500); assert.equal(first.dates!.length, 500); assert.equal(first.nextDateCursor, 500)
    assert.equal(second.decisions.length, 1); assert.equal(second.nextDecisionCursor, null); assert.equal(second.dates!.length, 1); assert.equal(second.nextDateCursor, null)
    assert.equal(catalog.queryMedia({}).total, 0, '同步归属记录不能伪造原图或保存回执')
    assert.equal(store.list('file').length, 0)
  } finally { await catalog.close(); store.close() }
})

test('视频抽帧分析失败重试复用已检测人脸，不重复人物分组', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-face-retry-')), source = join(directory, 'source'), data = join(directory, 'data'), video = join(source, 'retry.mp4')
  await mkdir(source); await mkdir(data)
  await new Promise<void>((resolve, reject) => execFile(ffmpegPath!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=6', '-c:v', 'libx264', video], { windowsHide: true }, error => error ? reject(error) : resolve()))
  let calls = 0, closed = false
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { calls++; if (calls === 2) throw new Error('模拟第二帧解码失败'); return [{ x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: 0.95, embedding: [1, 0] }] }, async close() { closed = true } }
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('root', { id: randomUUID(), path: source, enabled: true, state: 'pending' })
  try {
    catalog.scanMedia(); await waitJobs(catalog); catalog.analyzeFaces(); await waitJobs(catalog)
    const before = catalog.queryMedia({}).items[0]
    assert.equal(before.faceState, 'error'); assert.equal(before.faces.length, 1)
    catalog.analyzeFaces(); await waitJobs(catalog)
    const after = catalog.queryMedia({}).items[0]
    assert.equal(after.faceState, 'done'); assert.equal(after.faces.length, 3); assert.equal(after.faces.find(face => face.frameTime === before.faces[0].frameTime)?.id, before.faces[0].id)
    assert.deepEqual(after.faces.map(face => face.frameTime).sort(), [1, 3, 5])
    assert.equal(calls, 4, '重试只分析失败帧及尚未检查的第三帧，成功帧不重复运行模型')
    assert.equal((await catalog.familyState()).people.length, 1)
  } finally { await catalog.close(); store.close() }
  assert.equal(closed, true)
})

test('人脸分析重启复用包含无脸结果的缓存，重扫后只检测新媒体', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-face-incremental-')), source = join(directory, 'source'), data = join(directory, 'data')
  await mkdir(source); await mkdir(data)
  await sample(join(source, 'existing.jpg'), '#aa5555'); await sample(join(source, 'no-face.jpg'), '#55aa55')
  const detected: string[] = []
  const engine = { async ready() { return { ready: true, error: '' } }, async detect(path: string) { detected.push(path); return path.endsWith('no-face.jpg') ? [] : [{ x: 0.2, y: 0.1, width: 0.3, height: 0.4, score: 0.95, embedding: [1, 0] }] } }
  let store = new Store(join(data, 'receiver.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('root', { id: randomUUID(), path: source, enabled: true, state: 'pending' })
  try {
    catalog.scanMedia(); await waitJobs(catalog); catalog.analyzeFaces(); await waitJobs(catalog)
    assert.equal(detected.length, 2)
    const completed = catalog.queryMedia({}).items
    assert.ok(completed.every(asset => asset.faceState === 'done'))
    const firstJob = store.list<FamilyJob>('familyJob').find(job => job.kind === 'faces')!
    assert.ok(Number.isFinite(Date.parse(firstJob.startedAt!)))
    await catalog.close(); store.close()
    store = new Store(join(data, 'receiver.sqlite')); catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
    catalog.analyzeFaces(); await waitJobs(catalog)
    assert.equal(detected.length, 2, '重启后不重新检测已完成或已确认无脸的照片')
    await sample(join(source, 'added.jpg'), '#5555aa')
    catalog.scanMedia(); await waitJobs(catalog); catalog.analyzeFaces(); await waitJobs(catalog)
    assert.equal(detected.length, 3, '只对新增媒体运行模型')
    assert.ok(detected[2].endsWith('added.jpg'))
    for (const asset of completed) assert.deepEqual(catalog.queryMedia({}).items.find(item => item.id === asset.id)?.faces, asset.faces)
  } finally { await catalog.close(); store.close() }
})

test('日期待确认双向筛选与移除宝宝参考立即生效，保留人工归属', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-reference-edit-')), source = join(directory, 'source'), data = join(directory, 'data')
  await mkdir(source); await mkdir(data)
  await sample(join(source, 'reference.jpg'), '#dd5555', '2024:03:10 10:00:00')
  await sample(join(source, 'matched.jpg'), '#55dd55', '2024:03:12 10:00:00')
  await sample(join(source, 'creation.jpg'), '#5555dd')
  await sample(join(source, 'before-birth.jpg'), '#dd55dd', '2023:12:31 10:00:00')
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine)
  store.put('root', { id: randomUUID(), path: source, enabled: true, state: 'pending' })
  try {
    catalog.scanMedia(); await waitJobs(catalog); catalog.analyzeFaces(); await waitJobs(catalog)
    const items = catalog.queryMedia({}).items, reference = items.find(item => item.filename === 'reference.jpg')!, creation = items.find(item => item.filename === 'creation.jpg')!
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2024-01-01', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyReference(baby.id, reference.id, reference.faces[0].id); catalog.matchBaby(baby.id)
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 4)
    assert.equal(catalog.queryMedia({ babyId: baby.id, datePending: false }).total, 2)
    assert.equal(catalog.queryMedia({ babyId: baby.id, datePending: true }).total, 2)
    catalog.setMediaDate(creation.id, '2024-03-15')
    assert.equal(catalog.queryMedia({ babyId: baby.id, datePending: false, from: '2024-03-12' }).total, 2)
    assert.equal(catalog.queryMedia({ babyId: baby.id, datePending: true }).total, 1)
    assert.equal(catalog.queryMedia({ babyId: baby.id, dateSource: 'manual', datePending: false }).total, 1)
    catalog.saveBaby({ ...(await catalog.familyState()).babies[0], referenceFaces: [] })
    assert.equal((await catalog.familyState()).babies[0].referenceFaces.length, 0)
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 1, '移除参考后自动归属失效，手动加入的参考原图保留')
    assert.throws(() => catalog.matchBaby(baby.id), /先选择/)
    assert.throws(() => catalog.saveBaby({ ...baby, referenceFaces: [{ assetId: creation.id, faceId: reference.faces[0].id }] }), /不匹配/)
    const oldInvalid = { assetId: `${'a'.repeat(64)}-123`, faceId: 'obsolete-face' }
    store.put('familyBaby', { ...baby, referenceFaces: [oldInvalid] })
    catalog.saveBaby({ ...baby, name: '宝宝改名', referenceFaces: [oldInvalid] })
    assert.equal((await catalog.familyState()).babies[0].name, '宝宝改名', '旧参考不可用不阻止修改档案')
    catalog.saveBaby({ ...baby, referenceFaces: [] })
    assert.equal((await catalog.familyState()).babies[0].referenceFaces.length, 0)
  } finally { await catalog.close(); store.close() }
})

test('空媒体跳过并保留可执行计划，图库扫描不会因一个坏文件中断', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-warning-')), source = join(directory, 'source'), data = join(directory, 'data')
  await mkdir(source); await mkdir(data)
  await writeFile(join(source, 'empty.mp4'), Buffer.alloc(0))
  await sample(join(source, 'valid.jpg'), '#33cc77', '2024:03:10 10:00:00')
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine), rootId = randomUUID()
  store.put('root', { id: rootId, path: source, enabled: true, state: 'pending', count: 0, error: '', scannedAt: null })
  try {
    const plan = catalog.prepareImport(rootId, 'index'); await waitJobs(catalog)
    const ready = (await catalog.familyState()).importPlans!.find(item => item.id === plan.id)!
    assert.equal(ready.state, 'ready'); assert.equal(ready.count, 1)
    assert.equal(ready.skipped, 1); assert.match(ready.warnings![0], /empty\.mp4.*空/)
    catalog.executeImport(plan.id); await waitJobs(catalog)
    assert.equal(catalog.queryMedia({}).total, 1)
    catalog.scanMedia(); await waitJobs(catalog)
    const job = (await catalog.familyState()).jobs[0]!
    assert.equal(job.state, 'done'); assert.equal(job.processed, 1); assert.equal(job.skipped, 1)
    assert.equal(catalog.queryMedia({}).total, 1); assert.equal(store.get<{ state: string }>('root', rootId)!.state, 'partial')
  } finally { await catalog.close(); store.close() }
})

test('失效的旧归档回执可重新保存原文件，不触发内容唯一约束', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-stale-receipt-')), source = join(directory, 'source'), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([source, library, data].map(path => mkdir(path)))
  const original = join(source, 'original.jpg'); await sample(original, '#557799', '2024:03:10 10:00:00')
  const identity = await hashFile(original), libraryId = randomUUID(), rootId = randomUUID()
  const stale: Receipt = { id: randomUUID(), receiverId: 'receiver', libraryId, hash: identity.hash, size: identity.size, relativePath: '2024-03-10/missing.jpg', filename: 'original.jpg', savedAt: new Date().toISOString(), captureDate: '2024-03-10', source: 'folder', kind: 'photo' }
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine)
  store.put('root', { id: rootId, path: source, enabled: true, state: 'pending' }); store.put('library', { id: libraryId, path: library, enabled: true, name: '归档' }); store.put('file', stale)
  try {
    const plan = catalog.prepareImport(rootId, 'copy', libraryId); await waitJobs(catalog); catalog.executeImport(plan.id); await waitJobs(catalog)
    assert.equal((await catalog.familyState()).jobs[0]!.state, 'done')
    const saved = store.list<Receipt>('file')
    assert.equal(saved.length, 1); assert.equal(saved[0].id, stale.id); assert.notEqual(saved[0].relativePath, stale.relativePath)
    assert.equal((await hashFile(join(library, saved[0].relativePath))).hash, identity.hash)
    assert.equal(catalog.queryMedia({}).items[0].locations.some(location => location.receiptId === stale.id && location.available), true)
  } finally { await catalog.close(); store.close() }
})

test('接收库同路径被其他内容覆盖，不冒充原回执或继承旧拍摄日期', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-overwritten-library-')), library = join(directory, 'library'), data = join(directory, 'data')
  await mkdir(library); await mkdir(data)
  const file = join(library, 'shared.jpg'); await sample(file, '#aa3344', '2024:03:10 10:00:00')
  const identity = await hashFile(file), libraryId = randomUUID()
  const receipt: Receipt = { id: randomUUID(), receiverId: 'receiver', libraryId, hash: identity.hash, size: identity.size, relativePath: 'shared.jpg', filename: 'shared.jpg', savedAt: new Date().toISOString(), captureDate: '2024-03-10', source: 'phone', kind: 'photo' }
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine)
  store.put('library', { id: libraryId, path: library, enabled: true, name: '归档' }); store.put('file', receipt)
  try {
    catalog.scanMedia(); await waitJobs(catalog)
    await writeFile(file, await sharp({ create: { width: 320, height: 240, channels: 3, background: '#44cc55' } }).jpeg({ quality: 90 }).toBuffer())
    catalog.scanMedia(); await waitJobs(catalog)
    const replacement = catalog.queryMedia({}).items.find(asset => asset.hash !== receipt.hash)!
    assert.equal(replacement.dateSource, 'creation'); assert.equal(replacement.captureDate, null)
    assert.equal(replacement.locations[0].receiptId, undefined); assert.equal(replacement.locations[0].source, 'folder')
    const original = catalog.queryMedia({}).items.find(asset => asset.hash === receipt.hash)!
    assert.equal(original.available, false)
  } finally { await catalog.close(); store.close() }
})

test('来自另一端的人工归属优先于本机较新的识别结果，自动开关同步后重新计算候选', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-sync-priority-')), source = join(directory, 'source'), data = join(directory, 'data')
  await mkdir(source); await mkdir(data)
  await sample(join(source, 'reference.jpg'), '#3388aa', '2024:03:10 10:00:00'); await sample(join(source, 'match.jpg'), '#aa7733', '2024:03:11 10:00:00'); await sample(join(source, 'another.jpg'), '#7744aa', '2024:03:12 10:00:00')
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine)
  store.put('root', { id: randomUUID(), path: source, enabled: true, state: 'pending' })
  try {
    catalog.scanMedia(); await waitJobs(catalog); catalog.analyzeFaces(); await waitJobs(catalog)
    const items = catalog.queryMedia({}).items, reference = items.find(item => item.filename === 'reference.jpg')!, matched = items.find(item => item.filename === 'match.jpg')!
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2024-01-01', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyReference(baby.id, reference.id, reference.faces[0].id); catalog.matchBaby(baby.id)
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 3)
    catalog.sync({ babies: [], decisions: [{ id: `${baby.id}:${matched.id}`, babyId: baby.id, assetId: matched.id, state: 'excluded', origin: 'manual', updatedAt: new Date(Date.now() - 60000).toISOString() }] })
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 2, '人工决定不能被本机识别时间戳覆盖')
    catalog.matchBaby(baby.id); assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 2)
    const updatedAt = new Date(Date.now() + 1000).toISOString()
    catalog.sync({ babies: [{ ...baby, autoMatch: false, updatedAt }], decisions: [] })
    assert.equal((await catalog.familyState()).babies[0].autoMatch, false)
    assert.equal(catalog.queryMedia({ babyId: baby.id }).total, 1, '人工确认的参考照片仍保留')
    assert.equal(catalog.queryMedia({ babyId: baby.id, candidates: true }).total, 1, '另一张自动匹配退回候选，人工排除不回到候选')
  } finally { await catalog.close(); store.close() }
})

test('本地大视频索引与归档允许超过 2 GiB，网络传输仍保持原有限制', () => {
  const large = { hash: 'a'.repeat(64), size: 2 * 1024 ** 3 + 1 }
  assert.deepEqual(localMediaIdentity(large), large)
  assert.throws(() => contentIdentity(large), /2 GiB/)
  assert.throws(() => localMediaIdentity({ ...large, size: 0 }), /空/)
  assert.throws(() => localMediaIdentity({ ...large, size: Number.MAX_SAFE_INTEGER + 1 }), /无效/)
})

test('离线来源目录保留不可用状态，其余已授权目录继续扫描', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-offline-root-')), source = join(directory, 'source'), data = join(directory, 'data')
  await mkdir(source); await mkdir(data); await sample(join(source, 'valid.jpg'), '#336688')
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine), missingId = randomUUID(), validId = randomUUID()
  store.put('root', { id: missingId, path: join(directory, 'offline-drive'), enabled: true, state: 'ready', count: 10, error: '', scannedAt: null })
  store.put('root', { id: validId, path: source, enabled: true, state: 'pending', count: 0, error: '', scannedAt: null })
  try {
    catalog.scanMedia(); await waitJobs(catalog)
    assert.equal(catalog.queryMedia({}).total, 1)
    assert.equal(store.get<{ state: string }>('root', missingId)!.state, 'unavailable')
    assert.equal(store.get<{ state: string }>('root', validId)!.state, 'ready')
    const job = (await catalog.familyState()).jobs[0]!
    assert.equal(job.state, 'done'); assert.equal(job.skipped, 1); assert.equal(job.processed, 1)
  } finally { await catalog.close(); store.close() }
})

test('长中文月龄水印完整换行，日期有可见像素且四角和极小图片不越界', async () => {
  const baby: BabyProfile = { id: 'watermark-test', name: '宝宝成长的每一个美好瞬间都值得一家人珍惜和记录', birthday: '2026-06-08', autoMatch: false, referenceFaces: [], updatedAt: new Date().toISOString() }
  const options: WatermarkOptions = { babyId: baby.id, position: 'bottom-right', fontSize: 48, color: '#ffffff', opacity: 0.9, showName: true, showAge: true, showDayCount: true, showDate: true }
  const text = watermarkText(baby, '2026-09-15', options), withDate = await watermarkOverlay(text, options, 512, 512), withoutDate = await watermarkOverlay(watermarkText(baby, '2026-09-15', { ...options, showDate: false }), options, 512, 512)
  const pixels = async (buffer: Buffer) => { const alpha = await sharp(buffer).extractChannel('alpha').raw().toBuffer(); return alpha.reduce((total, value) => total + value, 0) }
  assert.ok(await pixels(withDate.buffer) > await pixels(withoutDate.buffer), '日期必须增加可见字形，不能在右侧被裁掉')
  assert.ok((await sharp(withDate.buffer).metadata()).height! > 40, '长文字应分行，不能强行裁成单行')
  for (const [width, height] of [[512, 512], [32, 16], [16, 256], [1, 1]]) {
    for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      const stamp = await watermarkOverlay(text, { ...options, position }, width, height), info = await sharp(stamp.buffer).metadata()
      assert.ok(stamp.left >= 0 && stamp.top >= 0)
      assert.ok(stamp.left + info.width! <= width && stamp.top + info.height! <= height)
      const composite = await sharp({ create: { width, height, channels: 3, background: '#112233' } }).composite([{ input: stamp.buffer, left: stamp.left, top: stamp.top }]).png().toBuffer()
      assert.ok(composite.length > 0)
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-watermark-wrap-')), original = join(directory, 'original.jpg')
  await sharp({ create: { width: 512, height: 512, channels: 3, background: '#335577' } }).jpeg().toFile(original)
  const preview = await watermarkPreview(original, 'photo', text, options, directory)
  assert.equal((await sharp(preview).metadata()).width, 512)
})

test('零字节、单字节及截断图片头的元数据解析显式关闭文件句柄', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-exif-close-'))
  type Reader = { read(path: string): Promise<void>; file?: { fh?: { fd: number; stat(): Promise<unknown> }; close?(): Promise<void> } }
  const prototype = (exifr.Exifr as unknown as { prototype: Reader }).prototype, originalRead = prototype.read
  const captured: { reader: Reader; handle: NonNullable<NonNullable<Reader['file']>['fh']> }[] = []
  context.mock.method(prototype, 'read', async function(this: Reader, path: string) {
    await originalRead.call(this, path)
    if (this.file?.fh) captured.push({ reader: this, handle: this.file.fh })
  })
  try {
    for (const [name, bytes] of [['zero.jpg', Buffer.alloc(0)], ['one.jpg', Buffer.from([0xff])], ['truncated.jpg', Buffer.from([0x89, 0x50])]] as const) {
      const path = join(directory, name); await writeFile(path, bytes)
      const metadata = await readMetadata(path, 'photo')
      assert.equal(metadata.captureDate, null); assert.equal(metadata.width, 0); assert.equal(metadata.height, 0)
    }
    assert.equal(captured.length, 3, '测试必须经过真实分块 EXIF 文件读取')
    for (const item of captured) {
      assert.equal(item.reader.file?.fh, undefined, '解析失败后文件读句柄必须显式释放')
      assert.equal(item.handle.fd, -1)
      await assert.rejects(item.handle.stat(), /closed/)
    }
  } finally {
    await Promise.all(captured.map(item => item.reader.file?.close?.()))
    context.mock.restoreAll()
  }
})

test('复制目录比较统一 Windows 路径形式，禁止同目录和父子包含', () => {
  assert.match(copyDirectoryError('C:\\Photos', 'c:/photos/')!, /同一个目录/)
  assert.match(copyDirectoryError('D:/Photos/', 'd:\\PHOTOS\\archive\\')!, /目标不能位于来源/)
  assert.match(copyDirectoryError('D:/Photos/baby', 'D:\\Photos')!, /来源目录不能位于归档目标/)
  assert.match(copyDirectoryError('\\\\server\\share\\Photos', '//SERVER/share/photos/')!, /同一个目录/)
  assert.equal(copyDirectoryError('D:/Photos', 'D:/Photos2'), null)
  assert.equal(copyDirectoryError('C:/', 'D:/archive'), null)
})

test('实际复制目录同目录及父子关系在预扫描前拒绝，互不包含可正常复制', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-copy-paths-')), source = join(directory, 'source'), nested = join(source, 'archive'), library = join(directory, 'archive'), data = join(directory, 'data')
  await mkdir(source); await Promise.all([nested, library, data].map(path => mkdir(path)))
  const original = join(source, 'photo.jpg'); await sample(original, '#773344', '2024:03:10 10:00:00')
  const identity = await hashFile(original), rootId = randomUUID(), libraryId = randomUUID()
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine)
  store.put('root', { id: rootId, path: source, enabled: true, state: 'pending' })
  try {
    for (const [path, message] of [[source, /同一个目录/], [nested, /目标不能位于来源/], [directory, /来源目录不能位于归档目标/]] as const) {
      store.put('library', { id: libraryId, path, enabled: true, name: '归档' })
      assert.throws(() => catalog.prepareImport(rootId, 'copy', libraryId), message)
      assert.equal(store.list('familyPlan').length, 0); assert.equal(store.list('familyJob').length, 0)
    }
    store.put('library', { id: libraryId, path: library, enabled: true, name: '归档' })
    const plan = catalog.prepareImport(rootId, 'copy', libraryId); await waitJobs(catalog); catalog.executeImport(plan.id); await waitJobs(catalog)
    assert.equal((await catalog.familyState()).jobs[0]!.state, 'done')
    const saved = store.list<Receipt>('file')
    assert.equal(saved.length, 1); assert.equal((await hashFile(join(library, saved[0].relativePath))).hash, identity.hash)
    assert.equal((await hashFile(original)).hash, identity.hash, '来源照片始终保留且内容不变')
  } finally { await catalog.close(); store.close() }
})

test('旧复制计划执行前与处理下一项前重新验证目录，保留已保存照片', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-copy-revalidate-')), source = join(directory, 'source'), library = join(directory, 'archive'), data = join(directory, 'data')
  await Promise.all([source, library, data].map(path => mkdir(path)))
  await sample(join(source, 'first.jpg'), '#773388', '2024:03:10 10:00:00'); await sample(join(source, 'second.jpg'), '#33aa77', '2024:03:11 10:00:00')
  const firstHash = (await hashFile(join(source, 'first.jpg'))).hash, secondHash = (await hashFile(join(source, 'second.jpg'))).hash, rootId = randomUUID(), libraryId = randomUUID()
  const target = { id: libraryId, path: library, enabled: true, name: '归档' }
  const store = new Store(join(data, 'family.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, stubEngine)
  store.put('root', { id: rootId, path: source, enabled: true, state: 'pending' }); store.put('library', target)
  try {
    const plan = catalog.prepareImport(rootId, 'copy', libraryId); await waitJobs(catalog)
    store.put('library', { ...target, path: source })
    assert.throws(() => catalog.executeImport(plan.id), /同一个目录/)
    assert.equal(store.list<FamilyJob>('familyJob').some(job => job.kind === 'import'), false)
    store.put('library', target)
    const originalPut = store.put.bind(store)
    let changed = false
    context.mock.method(store, 'put', (kind: string, value: { id: string }) => {
      originalPut(kind, value)
      const job = value as FamilyJob
      if (!changed && kind === 'familyJob' && job.kind === 'import' && job.state === 'running' && job.processed === 1) { changed = true; originalPut('library', { ...target, path: source }) }
    })
    catalog.executeImport(plan.id); await waitJobs(catalog)
    const job = (await catalog.familyState()).jobs[0]!
    assert.equal(job.state, 'error'); assert.equal(job.processed, 1); assert.match(job.error, /同一个目录/)
    const saved = store.list<Receipt>('file')
    assert.equal(saved.length, 1); assert.equal((await hashFile(join(library, saved[0].relativePath))).hash, saved[0].hash)
    assert.equal((await hashFile(join(source, 'first.jpg'))).hash, firstHash); assert.equal((await hashFile(join(source, 'second.jpg'))).hash, secondHash)
  } finally { context.mock.restoreAll(); await catalog.close(); store.close() }
})
