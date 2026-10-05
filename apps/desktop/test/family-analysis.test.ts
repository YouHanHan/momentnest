import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import { query as validatedQuery } from '../src/main/family-validation.ts'
import type { BabyProfile, FamilyJob, MediaAsset } from '../src/shared/family.ts'

/** 仅等待实际任务结束，便于独立验证状态轮询触发的自动整理。 */
async function waitJobs(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('测试人物任务未完成。')
}

async function sample(path: string, color: string): Promise<void> {
  await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).jpeg().toFile(path)
}

const detected = (score = 0.95) => [{ x: 0.1, y: 0.1, width: 0.4, height: 0.5, score, embedding: [1, 0] }]

test('两阶段宝宝参考分别找到相似人脸，不依赖人物分组，保留人工排除并复用检测缓存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-multiple-references-')), data = join(directory, 'state'), library = join(directory, 'photos'), libraryId = randomUUID()
  await mkdir(data); await mkdir(library)
  const embeddings: Record<string, number[]> = {
    'reference-early.jpg': [1, 0, 0], 'reference-later.jpg': [0, 1, 0],
    'match-early.jpg': [0.98, 0, Math.sqrt(1 - 0.98 ** 2)], 'match-later.jpg': [0, 0.98, Math.sqrt(1 - 0.98 ** 2)],
    'excluded.jpg': [0, 0.99, Math.sqrt(1 - 0.99 ** 2)], 'unrelated.jpg': [0, 0, 1],
    'candidate-early.jpg': [0.5, 0, Math.sqrt(0.75)], 'candidate-later.jpg': [0, 0.5, Math.sqrt(0.75)],
  }
  await Promise.all(Object.keys(embeddings).map((filename, index) => sample(join(library, filename), `rgb(${30 + index * 22},${180 - index * 15},${50 + index * 17})`)))
  const store = new Store(join(data, 'family.sqlite'))
  let detections = 0
  const engine = { async ready() { return { ready: true, error: '' } }, async detect(path: string) { detections++; return [{ ...detected()[0], embedding: embeddings[basename(path)] }] } }
  const catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '测试宝宝图库', enabled: true }); store.put('workspace', { id: 'current-library', libraryId })
  try {
    catalog.scanMedia(libraryId); await waitJobs(store); catalog.analyzeFaces(libraryId); await waitJobs(store)
    const assets = catalog.queryMedia({ libraryId }).items
    const early = assets.find(asset => asset.filename === 'reference-early.jpg')!, later = assets.find(asset => asset.filename === 'reference-later.jpg')!, excluded = assets.find(asset => asset.filename === 'excluded.jpg')!
    assert.notEqual(early.faces[0].personId, later.faces[0].personId, '不同成长阶段可属于不同人物分组，仍可同时选作一个宝宝的参考')
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyMembership(baby.id, [excluded.id], false)
    catalog.setBabyReference(baby.id, early.id, early.faces[0].id); catalog.matchBaby(baby.id, libraryId)
    assert.deepEqual(catalog.queryMedia({ libraryId, babyId: baby.id }).items.map(asset => asset.filename).sort(), ['match-early.jpg', 'reference-early.jpg'])
    assert.deepEqual(catalog.queryMedia({ libraryId, babyId: baby.id, candidates: true }).items.map(asset => asset.filename), ['candidate-early.jpg'])
    catalog.setBabyReference(baby.id, later.id, later.faces[0].id); catalog.matchBaby(baby.id, libraryId)
    const profile = (await catalog.familyState(libraryId)).babies[0]
    assert.equal(profile.referenceFaces.length, 2)
    assert.deepEqual(catalog.queryMedia({ libraryId, babyId: baby.id }).items.map(asset => asset.filename).sort(), ['match-early.jpg', 'match-later.jpg', 'reference-early.jpg', 'reference-later.jpg'])
    assert.deepEqual(catalog.queryMedia({ libraryId, babyId: baby.id, candidates: true }).items.map(asset => asset.filename).sort(), ['candidate-early.jpg', 'candidate-later.jpg'])
    for (const filename of ['match-early.jpg', 'match-later.jpg']) {
      const asset = assets.find(asset => asset.filename === filename)!
      const decision = store.get<{ score: number; state: string }>('familyDecision', `${baby.id}:${asset.id}`)!
      assert.equal(decision.state, 'included'); assert.ok(Math.abs(decision.score - 0.98) < 1e-8, '每个参考独立保留相似度，不取平均稀释另一成长阶段的命中')
    }
    assert.deepEqual(store.get<{ origin: string; state: string }>('familyDecision', `${baby.id}:${excluded.id}`)?.origin, 'manual')
    assert.equal(store.get<{ state: string }>('familyDecision', `${baby.id}:${excluded.id}`)?.state, 'excluded')
    assert.equal(catalog.queryMedia({ libraryId, babyId: baby.id }).items.some(asset => asset.filename === 'unrelated.jpg'), false)
    const jobs = store.list<FamilyJob>('familyJob').length
    catalog.matchBaby(baby.id, libraryId); catalog.matchBaby(baby.id, libraryId)
    assert.equal(detections, Object.keys(embeddings).length, '添加参考和再次查找只复用已检测人脸，不重复运行模型')
    assert.equal(store.list<FamilyJob>('familyJob').length, jobs)
  } finally { await catalog.close(); store.close() }
})

test('全部参考失效、照片与人脸不对应或人脸不清晰时明确拒绝宝宝查找', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-invalid-references-')), data = join(directory, 'state'), library = join(directory, 'photos'), libraryId = randomUUID()
  await mkdir(data); await mkdir(library); await sample(join(library, 'reference.jpg'), '#447799')
  const store = new Store(join(data, 'family.sqlite'))
  let detections = 0
  const catalog = new MediaCatalog(store, data, 'receiver', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { detections++; return detected() } })
  store.put('library', { id: libraryId, path: library, name: '测试库', enabled: true })
  try {
    catalog.scanMedia(libraryId); await waitJobs(store); catalog.analyzeFaces(libraryId); await waitJobs(store)
    const reference = catalog.queryMedia({ libraryId }).items[0], baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: false, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby)
    const assertInvalid = () => assert.throws(() => catalog.matchBaby(baby.id, libraryId), /参考人脸已失效或不清晰.*重新选择参考/)
    store.put('familyBaby', { ...baby, referenceFaces: [{ assetId: reference.id, faceId: 'obsolete-face' }] }); assertInvalid()
    store.put('familyBaby', { ...baby, referenceFaces: [{ assetId: `${'a'.repeat(64)}-1`, faceId: reference.faces[0].id }] }); assertInvalid()
    store.put('familyBaby', { ...baby, referenceFaces: [{ assetId: reference.id, faceId: reference.faces[0].id }] })
    const face = store.get<any>('familyFace', reference.faces[0].id)
    store.put('familyFace', { ...face, score: 0.2 }); assertInvalid()
    assert.doesNotThrow(() => catalog.saveBaby({ ...baby, name: '宝宝改名', autoMatch: true, referenceFaces: [{ assetId: reference.id, faceId: reference.faces[0].id }] }), '旧的不清晰参考不阻止档案编辑和开关保存')
    assertInvalid()
    store.put('familyFace', face); catalog.matchBaby(baby.id, libraryId)
    assert.equal(detections, 1, '校验与匹配均不重新运行检测模型')
  } finally { await catalog.close(); store.close() }
})

test('有效宝宝参考自动增量整理，人工排除优先，失败不随轮询重跑且关闭开关停止新增识别', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-auto-faces-')), data = join(directory, 'state'), library = join(directory, 'photos'), libraryId = randomUUID()
  await mkdir(data); await mkdir(library); await sample(join(library, 'reference.jpg'), '#aa3344')
  const store = new Store(join(data, 'family.sqlite'))
  const calls = new Map<string, number>()
  let retryAllowed = false
  const engine = {
    async ready() { return { ready: true, error: '' } },
    async detect(path: string) {
      const filename = basename(path); calls.set(filename, (calls.get(filename) ?? 0) + 1)
      if (filename === 'failed.jpg' && !retryAllowed) throw new Error('模拟坏照片解码失败')
      return detected()
    },
  }
  const catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '宝宝图库', enabled: true })
  store.put('workspace', { id: 'current-library', libraryId })
  try {
    catalog.scanMedia(libraryId); await waitJobs(store)
    await catalog.familyState(libraryId)
    catalog.analyzeFaces(libraryId); await waitJobs(store)
    const reference = catalog.queryMedia({ libraryId }).items[0]
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby)
    await Promise.all([sample(join(library, 'matched.jpg'), '#3388aa'), sample(join(library, 'excluded.jpg'), '#88aa33'), sample(join(library, 'failed.jpg'), '#bb9922')])
    catalog.scanMedia(libraryId); await waitJobs(store)
    await catalog.familyState(libraryId)
    assert.equal(calls.size, 1, '无参考时不会因为打开相册运行整库识别')
    const excluded = catalog.queryMedia({ libraryId, search: 'excluded' }).items[0]
    catalog.setBabyMembership(baby.id, [excluded.id], false)
    catalog.setBabyReference(baby.id, reference.id, reference.faces[0].id)
    await waitJobs(store)
    const state = await catalog.familyState(libraryId)
    assert.deepEqual(state.analysis, { pending: 0, done: 3, error: 1, faceCount: 3, noFaces: 0, supplementPending: 0 })
    assert.deepEqual(catalog.queryMedia({ libraryId, babyId: baby.id }).items.map(asset => asset.filename).sort(), ['matched.jpg', 'reference.jpg'])
    assert.equal(calls.get('reference.jpg'), 1, '已检测的参考原图直接复用缓存')
    assert.equal(calls.get('failed.jpg'), 1)
    const jobCount = store.list<FamilyJob>('familyJob').length
    for (let index = 0; index < 4; index++) await catalog.familyState(libraryId)
    assert.equal(store.list<FamilyJob>('familyJob').length, jobCount, '轮询不制造零项任务或反复重试错误项')
    assert.equal(calls.get('failed.jpg'), 1)
    assert.equal(state.jobs[0].skipped, 1); assert.match(state.jobs[0].warnings![0], /failed\.jpg.*坏照片/)
    catalog.saveBaby({ ...state.babies[0], autoMatch: false })
    await sample(join(library, 'new.jpg'), '#9966aa'); catalog.scanMedia(libraryId); await waitJobs(store)
    assert.equal((await catalog.familyState(libraryId)).analysis!.pending, 1)
    assert.equal(calls.has('new.jpg'), false, '用户关闭自动归类后不自动识别新内容')
    catalog.saveBaby({ ...(await catalog.familyState(libraryId)).babies[0], autoMatch: true }); await waitJobs(store)
    assert.equal(calls.get('new.jpg'), 1); assert.equal(calls.get('failed.jpg'), 1)
    retryAllowed = true; catalog.analyzeFaces(libraryId); await waitJobs(store)
    assert.equal(calls.get('failed.jpg'), 2); assert.equal(calls.get('new.jpg'), 1)
    assert.equal((await catalog.familyState(libraryId)).analysis!.error, 0)
    assert.equal(catalog.queryMedia({ libraryId, babyId: baby.id }).items.some(asset => asset.id === excluded.id), false)
    const completedCount = store.list<FamilyJob>('familyJob').length
    catalog.analyzeFaces(libraryId)
    assert.equal(store.list<FamilyJob>('familyJob').length, completedCount, '全部有缓存时手动整理也不建立空任务')
  } finally { await catalog.close(); store.close() }
})

test('重启后宝宝自动整理仅补新内容，人物头像只选当前库清晰可用照片且不泄露特征', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-person-preview-')), data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second')
  await Promise.all([data, first, second].map(path => mkdir(path)))
  await sample(join(first, 'lower.jpg'), '#bb4444'); await sample(join(first, 'clear.jpg'), '#44bb44'); await sample(join(second, 'other.jpg'), '#4444bb')
  const store = new Store(join(data, 'family.sqlite')), firstId = randomUUID(), secondId = randomUUID()
  store.put('library', { id: firstId, path: first, name: '第一库', enabled: true }); store.put('library', { id: secondId, path: second, name: '第二库', enabled: true })
  store.put('workspace', { id: 'current-library', libraryId: firstId })
  const calls = new Map<string, number>()
  const engine = { async ready() { return { ready: true, error: '' } }, async detect(path: string) { const filename = basename(path); calls.set(filename, (calls.get(filename) ?? 0) + 1); return detected(filename === 'lower.jpg' ? 0.85 : filename === 'other.jpg' ? 0.99 : 0.96) } }
  let catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  try {
    catalog.scanMedia(firstId); await waitJobs(store); catalog.scanMedia(secondId); await waitJobs(store)
    catalog.analyzeFaces(firstId); await waitJobs(store); catalog.analyzeFaces(secondId); await waitJobs(store)
    const state = await catalog.familyState(firstId), otherState = await catalog.familyState(secondId)
    assert.equal(state.people.length, 1); assert.equal(otherState.people.length, 1)
    const reference = state.people[0].reference!, otherReference = otherState.people[0].reference!
    assert.equal(catalog.queryMedia({ libraryId: firstId, search: 'clear' }).items[0].id, reference.assetId)
    assert.equal(catalog.queryMedia({ libraryId: secondId, search: 'other' }).items[0].id, otherReference.assetId)
    assert.equal(reference.kind, 'photo'); assert.equal(reference.face.score, 0.96)
    assert.ok(!JSON.stringify(state).includes('embedding')); assert.ok(!JSON.stringify(catalog.queryMedia({})).includes('faceFrames'))
    await assert.rejects(catalog.mediaPath(otherReference.assetId, true, firstId), /不在所选照片库/)
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyReference(baby.id, reference.assetId, reference.face.id)
    assert.equal(catalog.queryMedia({ libraryId: firstId, babyId: baby.id }).total, 2, '设置参考立即匹配已有缓存，不必再次点击整理')
    await sample(join(first, 'later.jpg'), '#aa7799'); catalog.scanMedia(firstId); await waitJobs(store)
    await catalog.close(); catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
    await catalog.familyState(firstId); await waitJobs(store)
    assert.equal(calls.get('later.jpg'), 1); assert.equal(calls.get('clear.jpg'), 1); assert.equal(calls.get('lower.jpg'), 1); assert.equal(calls.get('other.jpg'), 1)
    assert.equal(catalog.queryMedia({ libraryId: firstId, babyId: baby.id }).total, 3)
    store.put('library', { id: firstId, path: first, name: '停用库', enabled: false })
    assert.equal((await catalog.familyState(firstId)).people[0].reference, undefined, '停用来源不提供可打开的头像')
  } finally { await catalog.close(); store.close() }
})

test('自动整理必须有明确启用照片库，档案保存和兼容全局状态读取不扩大扫描范围', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-auto-face-scope-')), data = join(directory, 'state'), library = join(directory, 'photos'), libraryId = randomUUID()
  await mkdir(data); await mkdir(library); await sample(join(library, 'reference.jpg'), '#5588aa')
  const store = new Store(join(data, 'family.sqlite'))
  let calls = 0
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { calls++; return detected() } }
  const catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '测试库', enabled: true })
  try {
    catalog.scanMedia(libraryId); await waitJobs(store); catalog.analyzeFaces(libraryId); await waitJobs(store)
    const reference = catalog.queryMedia({ libraryId }).items[0]
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: true, referenceFaces: [{ assetId: reference.id, faceId: reference.faces[0].id }], updatedAt: new Date().toISOString() }
    await sample(join(library, 'pending.jpg'), '#aa8855'); catalog.scanMedia(libraryId); await waitJobs(store)
    const jobCount = store.list<FamilyJob>('familyJob').length
    catalog.saveBaby(baby); catalog.setBabyReference(baby.id, reference.id, reference.faces[0].id)
    await catalog.familyState()
    assert.equal(store.list<FamilyJob>('familyJob').length, jobCount, '未选择当前库时不因档案或全局状态启动所有库分析')
    assert.equal(calls, 1)
    store.put('workspace', { id: 'current-library', libraryId })
    store.put('library', { id: libraryId, path: library, name: '停用库', enabled: false })
    catalog.saveBaby({ ...baby, name: '宝宝改名' }); await catalog.familyState(libraryId)
    assert.equal(store.list<FamilyJob>('familyJob').length, jobCount, '当前库停用时不改扫其他目录')
    store.put('library', { id: libraryId, path: library, name: '测试库', enabled: true })
    await catalog.familyState(libraryId); await waitJobs(store)
    assert.equal(calls, 2, '明确启用库恢复后只分析该库的新内容')
  } finally { await catalog.close(); store.close() }
})

test('日期排序双向稳定分页，未知日期始终最后且服务与 IPC 拒绝非法排序', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-date-order-')), store = new Store(join(directory, 'family.sqlite')), libraryId = randomUUID()
  store.put('library', { id: libraryId, path: directory, name: '测试库', enabled: true })
  for (const [letter, date] of [['a', '2026-01-01'], ['b', '2026-01-05'], ['c', '2026-01-05'], ['d', null]] as const) {
    const hash = letter.repeat(64), id = `${hash}-1`
    const asset: MediaAsset = { id, hash, size: 1, filename: `${letter}.jpg`, kind: 'photo', date, dateSource: date ? 'capture' : 'unknown', dateConfirmed: Boolean(date), captureDate: date, creationDate: null, width: 80, height: 60, duration: 0, available: true, locations: [{ id: letter, path: join(directory, `${letter}.jpg`), label: '测试库', source: 'folder', libraryId, available: true }], babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'done' }
    store.put('familyAsset', { ...asset, updatedAt: new Date().toISOString() })
  }
  const catalog = new MediaCatalog(store, directory, 'receiver', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { return [] } })
  try {
    const names = (order: 'asc' | 'desc', page = 1, limit = 100) => catalog.queryMedia({ libraryId, order, page, limit }).items.map(asset => asset.filename)
    assert.deepEqual(names('asc'), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'])
    assert.deepEqual(names('desc'), ['b.jpg', 'c.jpg', 'a.jpg', 'd.jpg'])
    assert.deepEqual([...names('asc', 1, 2), ...names('asc', 2, 2)], names('asc'))
    assert.equal(validatedQuery({ order: 'asc' }).order, 'asc'); assert.throws(() => validatedQuery({ order: 'random' }))
    assert.throws(() => catalog.queryMedia({ order: 'random' as 'asc' }), /排序无效/)
  } finally { await catalog.close(); store.close() }
})
