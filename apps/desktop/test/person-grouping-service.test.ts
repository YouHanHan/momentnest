import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import type { BabyProfile, FamilyJob, MediaAsset } from '../src/shared/family.ts'

const vector = (degrees: number) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]
type SeedFace = { personId?: string; angle?: number; embedding?: number[]; score?: number; frameTime?: number }
type SavedPerson = { id: string; name: string; embedding: number[]; mergedIntoId?: string; mergeOrigin?: 'manual' | 'automatic' }

/** 每个用例仅建立独立临时目录与合成记录，模型不接触真实照片。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-person-grouping-')), data = join(directory, 'state')
  const firstId = randomUUID(), secondId = randomUUID(), paths = new Map([[firstId, join(directory, 'first')], [secondId, join(directory, 'second')]])
  await mkdir(data); for (const path of paths.values()) await mkdir(path)
  const store = new Store(join(data, 'family.sqlite')), calls = { ready: 0, detected: [] as string[] }, embeddings = new Map<string, number[]>()
  for (const [id, path] of paths) store.put('library', { id, path, name: id === firstId ? '合成第一库' : '合成第二库', enabled: true })
  store.put('workspace', { id: 'current-library', libraryId: firstId })
  store.put('root', { id: 'synthetic-root', path: directory, enabled: true, state: 'ready', count: 0, error: '', scannedAt: null })
  const addPerson = (id: string, angle = 0, name = '', extra: Partial<SavedPerson> = {}) => store.put('familyPerson', { id, name, embedding: vector(angle), ...extra })
  const addAsset = async (filename: string, faces: SeedFace[] = [], options: { libraryIds?: string[]; kind?: 'photo' | 'video'; pending?: boolean } = {}) => {
    const bytes = Buffer.from(`synthetic:${filename}`), hash = createHash('sha256').update(bytes).digest('hex'), id = `${hash}-${bytes.length}`, libraryIds = options.libraryIds ?? [firstId]
    const locations = []
    for (const libraryId of libraryIds) {
      const path = join(paths.get(libraryId)!, filename); await writeFile(path, bytes); const info = await stat(path)
      locations.push({ id: `${id}:${libraryId}`, libraryId, source: 'folder' as const, label: '合成媒体', path, relativePath: filename, mtime: info.mtimeMs, available: true })
    }
    const asset: MediaAsset & { updatedAt: string } = { id, hash, size: bytes.length, filename, kind: options.kind ?? 'photo', date: '2024-03-10', dateSource: 'capture', dateConfirmed: true, captureDate: '2024-03-10', creationDate: null, width: 320, height: 240, duration: options.kind === 'video' ? 8 : 0, available: true, locations, babyIds: [], personIds: [], favorite: false, faces: [], faceState: options.pending ? 'pending' : 'done', updatedAt: 'preserved' }
    store.put('familyAsset', asset)
    for (const [index, face] of faces.entries()) store.put('familyFace', { id: `${id}:${index}`, assetId: id, x: 0.1 + index * 0.3, y: 0.1, width: 0.2, height: 0.3, score: face.score ?? 0.95, embedding: face.embedding ?? vector(face.angle ?? 0), ...(face.personId ? { personId: face.personId } : {}), ...(face.frameTime !== undefined ? { frameTime: face.frameTime } : {}) })
    return asset
  }
  const makeCatalog = () => new MediaCatalog(store, data, 'synthetic-receiver', undefined, {
    async ready() { calls.ready++; return { ready: true, error: '' } },
    async detect(path: string) { const filename = basename(path); calls.detected.push(filename); return [{ x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: 0.95, embedding: embeddings.get(filename) ?? vector(0) }] },
  })
  return { directory, store, firstId, secondId, paths, calls, embeddings, addPerson, addAsset, makeCatalog }
}

/** 等待合成后台任务完成，不调用会启动自动整理的相册状态接口。 */
async function waitJobs(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('合成人物任务未结束。')
}

const records = (store: Store) => store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all()
const changes = (store: Store) => Number(store.db.prepare('SELECT total_changes() AS count').get()!.count)

test('整理逐项确认只应用所选来源，可撤销本次别名且保留全部人脸和原图记录', async () => {
  const f = await fixture(); f.addPerson('target', 0, '保留目标'); f.addPerson('first-source', 5); f.addPerson('second-source', 8)
  for (const personId of ['target', 'first-source', 'second-source']) await f.addAsset(`${personId}.jpg`, [{ personId, angle: personId === 'target' ? 0 : personId === 'first-source' ? 5 : 8 }])
  const catalog = f.makeCatalog()
  try {
    const original = f.store.list<SavedPerson>('familyPerson'), faces = f.store.list('familyFace'), assets = f.store.list('familyAsset')
    const plan = await catalog.preparePersonGrouping(f.firstId); assert.equal(plan.merges.length, 2)
    assert.throws(() => catalog.applyPersonGrouping(plan.id, f.firstId, ['unlisted-person']), /不属于本次/)
    assert.equal(catalog.applyPersonGrouping(plan.id, f.firstId, [plan.merges[0].source.id]), 1)
    assert.equal(f.store.list<SavedPerson>('familyPerson').filter(person => person.mergedIntoId).length, 1)
    const undo = (await catalog.familyState(f.firstId)).personGroupingUndo!
    assert.equal(undo.count, 1); assert.equal(undo.libraryId, f.firstId)
    assert.equal(catalog.undoPersonGrouping(undo.token, f.firstId), 1)
    assert.deepEqual(f.store.list<SavedPerson>('familyPerson'), original); assert.deepEqual(f.store.list('familyFace'), faces); assert.deepEqual(f.store.list('familyAsset'), assets)
    assert.equal((await catalog.familyState(f.firstId)).personGroupingUndo, undefined)
    assert.throws(() => catalog.undoPersonGrouping(undo.token, f.firstId), /过期|不属于/)
  } finally { await catalog.close(); f.store.close() }
})

test('全部跳过不改分组，后续命名、目录或媒体变化拒绝撤销旧整理', async () => {
  for (const action of ['name', 'library', 'favorite'] as const) {
    const f = await fixture(); f.addPerson('target', 0, '保留目标'); f.addPerson('source', 5)
    const target = await f.addAsset('target.jpg', [{ personId: 'target' }]); await f.addAsset('source.jpg', [{ personId: 'source', angle: 5 }])
    const catalog = f.makeCatalog()
    try {
      const before = f.store.list('familyPerson'), skip = await catalog.preparePersonGrouping(f.firstId)
      assert.equal(catalog.applyPersonGrouping(skip.id, f.firstId, []), 0); assert.deepEqual(f.store.list('familyPerson'), before)
      const plan = await catalog.preparePersonGrouping(f.firstId); catalog.applyPersonGrouping(plan.id, f.firstId)
      const undo = (await catalog.familyState(f.firstId)).personGroupingUndo!
      assert.throws(() => catalog.undoPersonGrouping(undo.token, f.secondId), /照片库已切换|不属于/)
      if (action === 'name') catalog.namePerson('target', '新的名字')
      else if (action === 'favorite') catalog.setFavorite(target.id, true)
      else f.store.put('library', { id: f.secondId, path: f.paths.get(f.secondId), name: '变化目录', enabled: true })
      assert.throws(() => catalog.undoPersonGrouping(undo.token, f.firstId), /记录已变化/)
      assert.equal(f.store.get<SavedPerson>('familyPerson', 'source')!.mergedIntoId, 'target')
    } finally { await catalog.close(); f.store.close() }
  }
})

test('识别歧义脸缓存为待归组，新脸与明确匹配仍建立正确人物且完成缓存只检测一次', async () => {
  const f = await fixture(); f.addPerson('left', -40); f.addPerson('right', 40)
  await f.addAsset('left-cache.jpg', [{ personId: 'left', angle: -40 }]); await f.addAsset('right-cache.jpg', [{ personId: 'right', angle: 40 }])
  for (const [filename, angle] of [['ambiguous.jpg', 0], ['known.jpg', -40], ['new.jpg', 150]] as const) { await f.addAsset(filename, [], { pending: true }); f.embeddings.set(filename, vector(angle)) }
  const catalog = f.makeCatalog()
  try {
    catalog.analyzeFaces(f.firstId); await waitJobs(f.store)
    const ambiguous = catalog.queryMedia({ libraryId: f.firstId, search: 'ambiguous.jpg' }).items[0]
    assert.equal(ambiguous.faceState, 'done'); assert.equal(ambiguous.faces.length, 1); assert.equal(ambiguous.faces[0].personId, undefined)
    assert.equal(catalog.queryMedia({ libraryId: f.firstId, search: 'known.jpg' }).items[0].faces[0].personId, 'left')
    assert.equal(f.store.list('familyPerson').length, 3, '歧义不能创建额外人物，真正陌生的人只创建一个')
    const state = await catalog.familyState(f.firstId)
    assert.deepEqual(state.ungrouped, { faces: 1, assets: 1 })
    assert.deepEqual(catalog.queryMedia({ libraryId: f.firstId, ungroupedFaces: true }).items.map(asset => asset.id), [ambiguous.id])
    catalog.analyzeFaces(f.firstId); await waitJobs(f.store)
    assert.deepEqual(f.calls.detected.sort(), ['ambiguous.jpg', 'known.jpg', 'new.jpg'])
  } finally { await catalog.close(); f.store.close() }
})

test('待归组数量与查询只统计当前库有效脸，按照片去重并保留筛选和分页', async () => {
  const f = await fixture()
  for (let index = 0; index < 55; index++) await f.addAsset(`pending-${index}.jpg`, index === 0 ? [{}, {}, {}] : [{}])
  await f.addAsset('other-library.jpg', [{}], { libraryIds: [f.secondId] })
  await f.addAsset('unclear.jpg', [{ score: 0.4 }]); await f.addAsset('invalid-vector.jpg', [{ embedding: [0, 0] }])
  f.addPerson('known'); await f.addAsset('known.jpg', [{ personId: 'known' }])
  const catalog = f.makeCatalog()
  try {
    assert.deepEqual((await catalog.familyState(f.firstId)).ungrouped, { faces: 57, assets: 55 })
    const first = catalog.queryMedia({ libraryId: f.firstId, ungroupedFaces: true, page: 1, limit: 50 }), second = catalog.queryMedia({ libraryId: f.firstId, ungroupedFaces: true, page: 2, limit: 50 })
    assert.equal(first.total, 55); assert.equal(first.items.length, 50); assert.equal(second.items.length, 5)
    assert.equal(new Set([...first.items, ...second.items].map(asset => asset.id)).size, 55)
    assert.equal(catalog.queryMedia({ libraryId: f.firstId, ungroupedFaces: true, search: 'pending-0.jpg', kind: 'photo' }).total, 1)
    assert.equal(catalog.queryMedia({ libraryId: f.firstId, ungroupedFaces: true, kind: 'video' }).total, 0)
    assert.throws(() => catalog.queryMedia({ libraryId: f.firstId, ungroupedFaces: 'yes' } as any), /待归组/)
    assert.throws(() => catalog.queryMedia({ libraryId: f.firstId, ungroupedFaces: true, personId: 'known' }), /待归组查询不能同时限定人物/)
  } finally { await catalog.close(); f.store.close() }
})

test('整理预览只读缓存且不调用模型，确认仅写自动别名并保留媒体、宝宝参考与决定', async () => {
  const f = await fixture(); f.addPerson('target', 0, '保留名字'); f.addPerson('source', 5)
  const first = await f.addAsset('target.jpg', [{ personId: 'target', angle: 0 }]), second = await f.addAsset('source.jpg', [{ personId: 'source', angle: 5 }], { libraryIds: [f.firstId, f.secondId] })
  const baby: BabyProfile = { id: 'synthetic-baby', name: '合成宝宝', birthday: '2024-01-01', autoMatch: true, referenceFaces: [{ assetId: second.id, faceId: `${second.id}:0` }], updatedAt: 'preserved' }
  f.store.put('familyBaby', baby); f.store.put('familyDecision', { id: `${baby.id}:${first.id}`, babyId: baby.id, assetId: first.id, state: 'excluded', origin: 'manual', updatedAt: 'preserved' })
  const catalog = f.makeCatalog()
  try {
    const before = records(f.store), beforeChanges = changes(f.store)
    const originals = ['familyFace', 'familyAsset', 'familyBaby', 'familyDecision', 'library', 'root', 'workspace'].map(kind => [kind, f.store.list(kind)] as const)
    const bytes = await readFile(second.locations[0].path), plan = await catalog.preparePersonGrouping(f.firstId)
    assert.deepEqual(records(f.store), before); assert.equal(changes(f.store), beforeChanges)
    assert.deepEqual(f.calls, { ready: 0, detected: [] }, '预览不能通过 familyState 启动模型或自动任务')
    assert.equal(plan.before, 2); assert.equal(plan.after, 1); assert.equal(plan.merges.length, 1)
    assert.equal(plan.merges[0].source.id, 'source'); assert.equal(plan.merges[0].target.name, '保留名字')
    assert.equal(plan.merges[0].source.reference?.assetId, second.id)
    assert.ok(!JSON.stringify(plan).includes('embedding')); assert.ok(!JSON.stringify(plan).includes('mergedIntoId')); assert.ok(!JSON.stringify(plan).includes(f.directory))
    assert.equal(catalog.applyPersonGrouping(plan.id, f.firstId), 1)
    assert.equal(changes(f.store) - beforeChanges, 1)
    assert.deepEqual(f.store.get<SavedPerson>('familyPerson', 'source'), { id: 'source', name: '', embedding: vector(5), mergedIntoId: 'target', mergeOrigin: 'automatic' })
    for (const [kind, original] of originals) assert.deepEqual(f.store.list(kind), original)
    assert.deepEqual(await readFile(second.locations[0].path), bytes)
    assert.equal(catalog.queryMedia({ libraryId: f.secondId, personId: 'target' }).total, 1, '共享别名仍能在另一库读取正确人物')
    assert.throws(() => catalog.applyPersonGrouping(plan.id, f.firstId), /不存在或已使用/)
    assert.deepEqual(f.calls, { ready: 0, detected: [] })
  } finally { await catalog.close(); f.store.close() }
})

test('整理使用所有库的共现约束，同照片与同视频帧保留不同人物，跨帧允许合并', async () => {
  for (const mode of ['photo', 'same-frame', 'different-frame'] as const) {
    const f = await fixture(); f.addPerson('a'); f.addPerson('b')
    await f.addAsset('a.jpg', [{ personId: 'a' }]); await f.addAsset('b.jpg', [{ personId: 'b' }])
    await f.addAsset(mode === 'photo' ? 'other.jpg' : 'other.mp4', [{ personId: 'a', frameTime: mode === 'photo' ? undefined : 1 }, { personId: 'b', frameTime: mode === 'different-frame' ? 2 : mode === 'photo' ? undefined : 1 }], { libraryIds: [f.secondId], kind: mode === 'photo' ? 'photo' : 'video' })
    const catalog = f.makeCatalog()
    try {
      const plan = await catalog.preparePersonGrouping(f.firstId)
      assert.equal(plan.merges.length, mode === 'different-frame' ? 1 : 0)
      if (mode !== 'different-frame') { assert.equal(plan.conflicts, 1); assert.equal(plan.after, 2) }
      assert.equal(catalog.applyPersonGrouping(plan.id, f.firstId), mode === 'different-frame' ? 1 : 0)
      assert.deepEqual(f.calls, { ready: 0, detected: [] })
    } finally { await catalog.close(); f.store.close() }
  }
})

test('命名人物与人工或旧版合并根不被自动替换，手工合并明确记录来源', async () => {
  for (const mergeOrigin of [undefined, 'manual'] as const) {
    const f = await fixture(); f.addPerson('confirmed'); f.addPerson('manual-alias', 5, '', { mergedIntoId: 'confirmed', ...(mergeOrigin ? { mergeOrigin } : {}) }); f.addPerson('other')
    await f.addAsset('confirmed.jpg', [{ personId: 'confirmed' }]); await f.addAsset('alias.jpg', [{ personId: 'manual-alias', angle: 5 }]); await f.addAsset('other.jpg', [{ personId: 'other' }])
    const catalog = f.makeCatalog()
    try {
      const plan = await catalog.preparePersonGrouping(f.firstId)
      assert.equal(plan.merges.length, 1); assert.equal(plan.merges[0].target.id, 'confirmed'); assert.equal(plan.merges[0].source.id, 'other')
      catalog.applyPersonGrouping(plan.id, f.firstId)
      assert.equal(f.store.get<SavedPerson>('familyPerson', 'confirmed')?.mergedIntoId, undefined)
      assert.equal(f.store.get<SavedPerson>('familyPerson', 'manual-alias')?.mergeOrigin, mergeOrigin)
    } finally { await catalog.close(); f.store.close() }
  }
  const f = await fixture(); f.addPerson('first', 0, '第一人'); f.addPerson('second', 0, '第二人')
  await f.addAsset('first.jpg', [{ personId: 'first' }]); await f.addAsset('second.jpg', [{ personId: 'second' }])
  const catalog = f.makeCatalog()
  try {
    assert.equal((await catalog.preparePersonGrouping(f.firstId)).merges.length, 0, '两个已命名人物即使特征相同也不自动合并')
    catalog.mergePersons('first', 'second', f.firstId)
    assert.equal(f.store.get<SavedPerson>('familyPerson', 'first')?.mergeOrigin, 'manual')
  } finally { await catalog.close(); f.store.close() }
})

test('连续整理与重启保留自动组件全部锚点，作为来源或目标都不能绕过旧场景约束', async () => {
  for (const role of ['source', 'target'] as const) {
    const f = await fixture(); f.addPerson('a', 0, role === 'target' ? '保留根' : ''); f.addPerson('b', 30)
    await f.addAsset('a.jpg', [{ personId: 'a', angle: 0 }]); await f.addAsset('b.jpg', [{ personId: 'b', angle: 30 }])
    let catalog = f.makeCatalog()
    try {
      const first = await catalog.preparePersonGrouping(f.firstId)
      assert.equal(first.merges.length, 1); assert.equal(first.merges[0].source.id, 'b'); assert.equal(first.merges[0].target.id, 'a')
      assert.equal(catalog.applyPersonGrouping(first.id, f.firstId), 1)
      await catalog.close()
      // 新场景与根很相似，但与已确认自动组件里的旧场景差距过大。
      f.addPerson('c', -30, role === 'source' ? '另一保留根' : '')
      await f.addAsset('c.jpg', [{ personId: 'c', angle: -30 }])
      catalog = f.makeCatalog()
      const before = records(f.store), beforeChanges = changes(f.store), second = await catalog.preparePersonGrouping(f.firstId)
      assert.equal(second.before, 2); assert.equal(second.after, 2); assert.equal(second.merges.length, 0, `${role} 角色必须复用前次整理的所有原始锚点`)
      assert.equal(catalog.applyPersonGrouping(second.id, f.firstId), 0)
      assert.deepEqual(records(f.store), before); assert.equal(changes(f.store), beforeChanges)
      assert.equal(f.store.get<SavedPerson>('familyPerson', 'b')?.mergedIntoId, 'a')
      assert.equal(f.store.get<SavedPerson>('familyPerson', 'a')?.mergedIntoId, undefined)
      assert.equal(f.store.get<SavedPerson>('familyPerson', 'c')?.mergedIntoId, undefined)
      assert.deepEqual(f.calls, { ready: 0, detected: [] })
    } finally { await catalog.close(); f.store.close() }
  }
})

test('整理预览对人物、人脸、媒体、目录和当前库的任何迟到变化均拒绝应用', async () => {
  for (const kind of ['familyPerson', 'familyFace', 'familyAsset', 'library', 'root', 'workspace'] as const) {
    const f = await fixture(); f.addPerson('target', 0, '保留'); f.addPerson('source', 5)
    const asset = await f.addAsset('source.jpg', [{ personId: 'source', angle: 5 }]); await f.addAsset('target.jpg', [{ personId: 'target' }])
    const catalog = f.makeCatalog()
    try {
      const plan = await catalog.preparePersonGrouping(f.firstId)
      const id = kind === 'familyPerson' ? 'source' : kind === 'familyFace' ? `${asset.id}:0` : kind === 'familyAsset' ? asset.id : kind === 'library' ? f.firstId : kind === 'root' ? 'synthetic-root' : 'current-library'
      const original = f.store.get<any>(kind, id)
      f.store.put(kind, { ...original, changedDuringPreview: true })
      const before = records(f.store), beforeChanges = changes(f.store)
      assert.throws(() => catalog.applyPersonGrouping(plan.id, f.firstId), /记录已变化/)
      assert.deepEqual(records(f.store), before); assert.equal(changes(f.store), beforeChanges)
      assert.equal(f.store.get<SavedPerson>('familyPerson', 'source')?.mergedIntoId, undefined)
    } finally { await catalog.close(); f.store.close() }
  }
})

test('生成提案期间库切换、任务启动、记录修改或关闭服务丢弃迟到预览', async () => {
  for (const action of ['workspace', 'job', 'face', 'close'] as const) {
    const f = await fixture()
    for (let index = 0; index < 32; index++) { f.addPerson(`person-${index}`); await f.addAsset(`face-${index}.jpg`, [{ personId: `person-${index}` }]) }
    const catalog = f.makeCatalog()
    try {
      const pending = catalog.preparePersonGrouping(f.firstId)
      if (action === 'workspace') f.store.put('workspace', { id: 'current-library', libraryId: f.secondId })
      else if (action === 'job') f.store.put('familyJob', { id: 'new-job', kind: 'faces', state: 'running', processed: 0, total: 1, label: '合成', error: '' })
      else if (action === 'face') { const face = f.store.list<any>('familyFace')[0]; f.store.put('familyFace', { ...face, score: 0.85 }) }
      else await catalog.close()
      await assert.rejects(pending, /已切换|正在进行|记录已变化|服务已关闭/)
      assert.ok(f.store.list<SavedPerson>('familyPerson').every(person => !person.mergedIntoId))
      assert.deepEqual(f.calls, { ready: 0, detected: [] })
    } finally { await catalog.close(); f.store.close() }
  }
})

test('应用预览拒绝错误库、运行任务、停用或离线目录、过期和关闭服务，均不写别名', async () => {
  for (const action of ['wrong-library', 'job', 'disabled', 'offline', 'expired', 'closed'] as const) {
    const f = await fixture(); f.addPerson('target', 0, '保留'); f.addPerson('source')
    await f.addAsset('target.jpg', [{ personId: 'target' }]); await f.addAsset('source.jpg', [{ personId: 'source' }])
    const catalog = f.makeCatalog(), actualNow = Date.now
    try {
      const plan = await catalog.preparePersonGrouping(f.firstId)
      if (action === 'wrong-library') f.store.put('workspace', { id: 'current-library', libraryId: f.secondId })
      else if (action === 'job') f.store.put('familyJob', { id: 'active', kind: 'scan', state: 'running', processed: 0, total: 0, label: '合成扫描', error: '' })
      else if (action === 'disabled' || action === 'offline') { const library = f.store.get<any>('library', f.firstId); f.store.put('library', { ...library, ...(action === 'disabled' ? { enabled: false } : { path: join(f.directory, 'absent-library') }) }) }
      else if (action === 'expired') Date.now = () => actualNow() + 11 * 60 * 1000
      else await catalog.close()
      const before = records(f.store), beforeChanges = changes(f.store)
      assert.throws(() => catalog.applyPersonGrouping(plan.id, action === 'wrong-library' ? f.secondId : f.firstId), /不属于|正在进行|停用|不可用|过期|服务已关闭/)
      assert.deepEqual(records(f.store), before); assert.equal(changes(f.store), beforeChanges)
    } finally { Date.now = actualNow; await catalog.close(); f.store.close() }
  }
})

test('多别名应用中途写入失败时整批回滚，原提案仍可明确重试', async () => {
  const f = await fixture(); f.addPerson('target', 0, '保留'); f.addPerson('source-one'); f.addPerson('source-two')
  for (const id of ['target', 'source-one', 'source-two']) await f.addAsset(`${id}.jpg`, [{ personId: id }])
  const catalog = f.makeCatalog(), originalPut = f.store.put.bind(f.store)
  try {
    const plan = await catalog.preparePersonGrouping(f.firstId), original = records(f.store)
    assert.equal(plan.merges.length, 2)
    let writes = 0
    f.store.put = (kind, value) => { if (kind === 'familyPerson' && ++writes === 2) throw new Error('模拟第二次别名写入失败'); originalPut(kind, value) }
    assert.throws(() => catalog.applyPersonGrouping(plan.id, f.firstId), /第二次别名写入失败/)
    assert.deepEqual(records(f.store), original, '第一条成功写入也必须随事务回滚')
    f.store.put = originalPut
    assert.equal(catalog.applyPersonGrouping(plan.id, f.firstId), 2)
    assert.equal(f.store.list<SavedPerson>('familyPerson').filter(person => person.mergeOrigin === 'automatic').length, 2)
  } finally { f.store.put = originalPut; await catalog.close(); f.store.close() }
})

test('自动整理别名不能成为可信锚点，手工及旧版确认的锚点重启后仍指导新增脸', async () => {
  for (const mergeOrigin of ['automatic', 'manual', undefined] as const) {
    const f = await fixture(); f.addPerson('target', 0, '保留'); f.addPerson('source', 40, '', { mergedIntoId: 'target', ...(mergeOrigin ? { mergeOrigin } : {}) })
    await f.addAsset('target.jpg', [{ personId: 'target' }]); await f.addAsset('source.jpg', [{ personId: 'source', angle: 65 }])
    const incoming = await f.addAsset('new-scene.jpg', [], { pending: true }); f.embeddings.set(incoming.filename, vector(105))
    const catalog = f.makeCatalog()
    try {
      catalog.analyzeFaces(f.firstId); await waitJobs(f.store)
      const asset = catalog.queryMedia({ libraryId: f.firstId, search: incoming.filename }).items[0]
      assert.equal(asset.faces[0].personId, mergeOrigin === 'automatic' ? undefined : 'target')
      assert.equal(f.store.list('familyPerson').length, 2, '自动锚点不足时缓存待归组，不能建立新人物')
    } finally { await catalog.close(); f.store.close() }
  }
})
