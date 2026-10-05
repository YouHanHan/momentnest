import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { Agent, request } from 'node:https'
import sharp from 'sharp'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import { Receiver } from '../src/service/receiver.ts'
import { hashFile } from '../src/service/files.ts'
import type { Receipt } from '../src/service/types.ts'
import type { BabyProfile, FamilyJob } from '../src/shared/family.ts'

/** 等待真实后台结果，不通过相册状态查询启动自动识别。 */
async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

/** 使用合成原图和已保存参考，验证队列及内容缓存的实际协作。 */
async function fixture(detect?: (filename: string) => Promise<void>, autoMatch = true) {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-automatic-queue-'))
  const data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second')
  await Promise.all([data, first, second].map(path => mkdir(path)))
  const store = new Store(join(data, 'family.sqlite')), libraryId = randomUUID(), otherId = randomUUID()
  const paths = new Map([[libraryId, first], [otherId, second]])
  for (const [id, path] of paths) store.put('library', { id, path, name: id, enabled: true })
  store.put('workspace', { id: 'current-library', libraryId })
  const sample = async (filename: string, color: string, targetId = libraryId): Promise<Receipt> => {
    const path = join(paths.get(targetId)!, filename)
    await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).jpeg().toFile(path)
    const identity = await hashFile(path)
    return { id: randomUUID(), receiverId: 'test', libraryId: targetId, hash: identity.hash, size: identity.size, relativePath: filename, filename, savedAt: new Date().toISOString(), captureDate: '2026-01-02', creationDate: '2026-01-02', source: 'phone', kind: 'photo' }
  }
  const reference = await sample('reference.jpg', '#aa3344'), referenceId = `${reference.hash}-${reference.size}`
  const referencePath = join(first, reference.filename), identity = await hashFile(referencePath)
  store.put('familyAsset', { id: referenceId, hash: reference.hash, size: reference.size, filename: reference.filename, kind: 'photo', date: '2026-01-02', captureDate: '2026-01-02', creationDate: '2026-01-02', dateSource: 'capture', dateConfirmed: true, width: 80, height: 60, duration: 0, available: true, locations: [{ id: 'reference-location', libraryId, path: referencePath, relativePath: reference.filename, mtime: identity.mtime, source: 'phone', label: libraryId, available: true }], babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'done', updatedAt: reference.savedAt })
  const face = { id: 'reference-face', assetId: referenceId, x: 0.1, y: 0.1, width: 0.4, height: 0.5, score: 0.95, embedding: [1, 0] }
  store.put('familyFace', face)
  const baby: BabyProfile = { id: randomUUID(), name: '合成宝宝', birthday: '2026-01-01', autoMatch, referenceFaces: [{ assetId: referenceId, faceId: face.id }], updatedAt: reference.savedAt }
  store.put('familyBaby', baby)
  const calls = new Map<string, number>()
  const engine = { async ready() { return { ready: true, error: '' } }, async detect(path: string) { const filename = basename(path); calls.set(filename, (calls.get(filename) ?? 0) + 1); await detect?.(filename); return [{ ...face, id: undefined }] } }
  let catalog = new MediaCatalog(store, data, 'test', undefined, engine)
  const asset = (receipt: Receipt) => catalog.queryMedia({ libraryId: receipt.libraryId }).items.find(item => item.id === `${receipt.hash}-${receipt.size}`)
  const receive = (receipt: Receipt) => { store.put('file', receipt); catalog.recordReceipt(receipt) }
  const done = (receipt: Receipt) => asset(receipt)?.faceState === 'done'
  const close = async () => { await catalog.close(); store.close() }
  return { directory, data, store, libraryId, otherId, paths, baby, calls, sample, receive, asset, done, close, get catalog() { return catalog }, async restart() { await catalog.close(); catalog = new MediaCatalog(store, data, 'test', undefined, engine) } }
}

test('接收完成直接启动批量匹配，无页面查询、重复传入和已完成参考均不重复识别', async () => {
  const f = await fixture()
  try {
    const receipts = await Promise.all(['#3388aa', '#88aa33', '#bb9922'].map((color, index) => f.sample(`received-${index}.jpg`, color)))
    receipts.forEach(f.receive)
    await until(() => receipts.every(f.done), '新照片没有在接收后自动识别')
    assert.equal(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).total, receipts.length)
    assert.equal(f.calls.has('reference.jpg'), false)
    receipts.forEach(receipt => assert.equal(f.calls.get(receipt.filename), 1))
    receipts.forEach(f.receive)
    await until(() => !f.store.list<FamilyJob>('familyJob').some(job => job.state === 'running'), '批量识别未结束')
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(f.store.list<FamilyJob>('familyJob').filter(job => job.kind === 'faces').length, 1)
    receipts.forEach(receipt => assert.equal(f.calls.get(receipt.filename), 1))
  } finally { await f.close() }
})

test('识别期间收到的新照片自动接续，切库后仍按回执目标处理', async () => {
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async filename => { if (filename === 'first.jpg') { began(); await gate } })
  try {
    const first = await f.sample('first.jpg', '#3388aa'); f.receive(first)
    await Promise.race([started, until(() => f.calls.has(first.filename), '首张照片未自动开始识别')])
    f.store.put('workspace', { id: 'current-library', libraryId: f.otherId })
    const late = await f.sample('late.jpg', '#88aa33'), other = await f.sample('other.jpg', '#bb9922', f.otherId)
    f.receive(late); f.receive(other)
    await until(() => Boolean(f.asset(late) && f.asset(other)), '识别期间的新照片未建立索引')
    release()
    await until(() => [first, late, other].every(f.done), '识别期间的新照片未接续')
    for (const receipt of [first, late, other]) assert.equal(f.calls.get(receipt.filename), 1)
    const jobs = f.store.list<FamilyJob>('familyJob').filter(job => job.kind === 'faces')
    assert.ok(jobs.some(job => job.libraryId === f.libraryId))
    assert.ok(jobs.some(job => job.libraryId === f.otherId))
    assert.ok(jobs.every(job => job.libraryId && job.state === 'done'))
  } finally { release(); await f.close() }
})

test('复制导入结束后自动匹配，识别启动时导入已完成', async () => {
  let activeImports = -1
  const f = await fixture(async () => { activeImports = f.store.list<FamilyJob>('familyJob').filter(job => job.kind === 'import' && job.state === 'running').length })
  try {
    const rootId = randomUUID(), source = join(f.directory, 'source'); await mkdir(source)
    await sharp({ create: { width: 80, height: 60, channels: 3, background: '#3388aa' } }).jpeg().toFile(join(source, 'imported.jpg'))
    f.store.put('root', { id: rootId, path: source, enabled: true, state: 'pending', count: 0, error: '', scannedAt: null })
    const plan = f.catalog.prepareImport(rootId, 'copy', f.libraryId)
    await until(() => f.store.get<{ state: string }>('familyPlan', plan.id)?.state === 'ready', '导入计划未完成')
    f.catalog.executeImport(plan.id)
    await until(() => f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).total === 1, '导入后未自动匹配')
    assert.equal(activeImports, 0)
    assert.equal([...f.calls.values()].reduce((sum, count) => sum + count, 0), 1)
  } finally { await f.close() }
})

test('重新扫描结束后自动识别新增内容，无需相册轮询', async () => {
  const f = await fixture()
  try {
    const receipt = await f.sample('scanned.jpg', '#3388aa')
    f.catalog.scanMedia(f.libraryId)
    await until(() => f.done(receipt), '扫描后的新增内容未自动识别')
    assert.equal(f.calls.get(receipt.filename), 1)
    assert.equal(f.calls.has('reference.jpg'), false)
  } finally { await f.close() }
})

test('识别失败不因新接收任务重复重试，人工排除优先', async () => {
  const f = await fixture(async filename => { if (filename === 'failed.jpg') throw new Error('合成解码失败') })
  try {
    const failed = await f.sample('failed.jpg', '#3388aa'), excluded = await f.sample('excluded.jpg', '#88aa33')
    f.receive(failed); f.receive(excluded)
    await until(() => Boolean(f.asset(excluded)), '待排除照片未入库')
    f.catalog.setBabyMembership(f.baby.id, [f.asset(excluded)!.id], false)
    await until(() => f.asset(failed)?.faceState === 'error' && f.done(excluded), '失败及人工排除未处理完成')
    f.receive(failed)
    const later = await f.sample('later.jpg', '#bb9922'); f.receive(later)
    await until(() => f.done(later), '失败项阻塞了后续照片')
    assert.equal(f.calls.get(failed.filename), 1)
    assert.equal(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).items.some(item => item.id === f.asset(excluded)!.id), false)
    assert.equal(f.store.get<{ origin: string; state: string }>('familyDecision', `${f.baby.id}:${f.asset(excluded)!.id}`)?.origin, 'manual')
  } finally { await f.close() }
})

test('关闭自动匹配或停用目标库暂停待处理内容，恢复后无需打开相册', async () => {
  const f = await fixture(undefined, false)
  try {
    const receipt = await f.sample('paused.jpg', '#3388aa'); f.receive(receipt)
    await until(() => Boolean(f.asset(receipt)), '关闭自动匹配时未保存索引')
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(f.calls.size, 0)
    f.store.put('library', { id: f.libraryId, path: f.paths.get(f.libraryId)!, name: '停用库', enabled: false })
    f.catalog.saveBaby({ ...f.baby, autoMatch: true })
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(f.calls.size, 0)
    f.store.put('library', { id: f.libraryId, path: f.paths.get(f.libraryId)!, name: '恢复库', enabled: true })
    f.catalog.requestAutomaticFaces(f.libraryId)
    await until(() => f.done(receipt), '恢复目标库后未自动继续')
    assert.equal(f.calls.get(receipt.filename), 1)
  } finally { await f.close() }
})

test('重启恢复已接收照片的目标队列，不依赖当前页面且不扩大到未排队的库', async () => {
  const f = await fixture(undefined, false)
  try {
    const queued = await f.sample('queued.jpg', '#3388aa'); f.receive(queued)
    await until(() => Boolean(f.asset(queued)), '重启前照片未建立索引')
    const other = await f.sample('not-queued.jpg', '#88aa33', f.otherId)
    f.catalog.scanMedia(f.otherId)
    await until(() => Boolean(f.asset(other)) && !f.store.list<FamilyJob>('familyJob').some(job => job.state === 'running'), '另一库索引未完成')
    f.store.put('familyAutomaticQueue', { id: 'main', libraryIds: [f.libraryId] })
    f.store.put('workspace', { id: 'current-library', libraryId: f.otherId })
    f.store.put('familyBaby', { ...f.baby, autoMatch: true })
    await f.restart()
    await until(() => f.done(queued), '重启后原目标队列未恢复')
    assert.equal(f.calls.get(queued.filename), 1)
    assert.equal(f.calls.has(other.filename), false)
    assert.equal(f.asset(other)?.faceState, 'pending')
  } finally { await f.close() }
})

test('没有待分析内容时页面刷新不反复写队列，队列记录不使图库版本失效', async () => {
  const f = await fixture()
  try {
    const revision = f.store.browseRevision
    const changes = Number(f.store.db.prepare('SELECT total_changes() AS changes').get()!.changes)
    for (let index = 0; index < 3; index++) await f.catalog.familyState(f.libraryId)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(f.store.get('familyAutomaticQueue', 'main'), undefined)
    assert.equal(Number(f.store.db.prepare('SELECT total_changes() AS changes').get()!.changes), changes)
    assert.equal(f.store.browseRevision, revision)
    assert.equal(f.calls.size, 0)
  } finally { await f.close() }
})

test('处理中停用目标库保留剩余照片，重新启用后接续且不重复已完成内容', async () => {
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let firstCall = true
  const f = await fixture(async () => { if (firstCall) { firstCall = false; began(); await gate } })
  try {
    const first = await f.sample('one.jpg', '#3388aa'), second = await f.sample('two.jpg', '#88aa33')
    f.receive(first); f.receive(second)
    await Promise.race([started, until(() => f.calls.size > 0, '未开始停用前的识别')])
    f.store.put('library', { id: f.libraryId, path: f.paths.get(f.libraryId)!, name: '停用库', enabled: false })
    release()
    await until(() => !f.store.list<FamilyJob>('familyJob').some(job => job.state === 'running'), '停用后任务未暂停')
    assert.equal(f.calls.size, 1)
    assert.equal([first, second].filter(receipt => f.asset(receipt)?.faceState === 'pending').length, 1)
    f.store.put('library', { id: f.libraryId, path: f.paths.get(f.libraryId)!, name: '恢复库', enabled: true })
    f.catalog.requestAutomaticFaces(f.libraryId)
    await until(() => [first, second].every(f.done), '启用后剩余照片未接续')
    assert.equal(f.calls.get(first.filename), 1); assert.equal(f.calls.get(second.filename), 1)
  } finally { release(); await f.close() }
})

test('关闭服务取消延迟唤醒，原照片与待处理队列保留', async () => {
  const f = await fixture()
  try {
    const receipt = await f.sample('closing.jpg', '#3388aa'); f.receive(receipt)
    await until(() => Boolean(f.asset(receipt)), '关闭前照片未入库')
    await f.catalog.close()
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(f.calls.size, 0)
    assert.equal(f.asset(receipt)?.faceState, 'pending')
    assert.deepEqual(f.store.get<{ libraryIds: string[] }>('familyAutomaticQueue', 'main')?.libraryIds, [f.libraryId])
    assert.equal((await hashFile(join(f.paths.get(f.libraryId)!, receipt.relativePath))).hash, receipt.hash)
  } finally { await f.close() }
})

test('真实 HTTPS 接收提交后排队，切库不改变旧批次目标且成功回执不等待识别', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-queue-receiver-'))
  const data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second')
  await Promise.all([data, first, second].map(path => mkdir(path)))
  const receiver = new Receiver(data)
  let agent: Agent | undefined
  try {
    const libraryId = await receiver.addDirectory(first, 'library'), otherId = await receiver.addDirectory(second, 'library')
    await receiver.start(0, '127.0.0.1')
    const identity = JSON.parse(await readFile(join(data, 'tls-identity.json'), 'utf8'))
    agent = new Agent({ ca: identity.cert, checkServerIdentity: (_host, cert) => cert.fingerprint256.replaceAll(':', '').toLowerCase() === receiver.fingerprint ? undefined : new Error('测试证书不匹配') })
    let token = ''
    const call = (method: string, path: string, value: unknown, auth = true): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
      const req = request({ hostname: '127.0.0.1', port: receiver.port, method, path, agent, headers: { 'content-length': bytes.length, ...(auth ? { authorization: `Bearer ${token}` } : {}) } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }))
      })
      req.on('error', reject); req.end(bytes)
    })
    const pair = receiver.pairInfo(), paired = await call('POST', '/v1/pair', { secret: pair.secret, name: '合成测试手机' }, false)
    assert.equal(paired.status, 200); token = paired.body.token
    const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#3388aa' } }).jpeg().toBuffer()
    const batch = await call('POST', '/v1/batches', { clientKey: randomUUID(), libraryId, mode: 'capture', manualDate: null })
    assert.equal(batch.status, 200, JSON.stringify(batch.body))
    const session = await call('POST', '/v1/uploads', { clientKey: randomUUID(), batchId: batch.body.id, libraryId, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, filename: 'received.jpg', captureDate: '2026-01-02', creationDate: '2026-01-02' })
    assert.equal(session.status, 200)
    receiver.setCurrentLibrary(otherId)
    const requested: string[] = [], actualRequest = receiver.family.requestAutomaticFaces.bind(receiver.family)
    receiver.family.requestAutomaticFaces = id => { if (id) requested.push(id); actualRequest(id) }
    assert.equal((await call('PUT', `/v1/uploads/${session.body.id}/content?offset=0`, bytes)).status, 200)
    const complete = await call('POST', `/v1/uploads/${session.body.id}/complete`, {})
    assert.equal(complete.status, 200); assert.equal(complete.body.state, 'complete')
    assert.equal(complete.body.receipt.libraryId, libraryId)
    await until(() => requested.includes(libraryId), '真实接收回执未触发原目标库排队')
    assert.equal(requested.includes(otherId), false)
    const asset = receiver.family.queryMedia({ libraryId }).items[0]
    assert.equal(asset.faceState, 'pending', '尚未设置宝宝参考时回执成功仍独立成立')
    assert.equal(receiver.family.queryMedia({ libraryId: otherId }).total, 0)
    assert.deepEqual(await readFile(join(first, complete.body.receipt.relativePath)), bytes)
  } finally { agent?.destroy(); await receiver.close() }
})
