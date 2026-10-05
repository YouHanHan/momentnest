import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { query as validatedQuery } from '../src/main/family-validation.ts'
import type { MediaAsset, MediaLocation, MediaQuery } from '../src/shared/family.ts'

type SavedLocation = MediaLocation & { rootId?: string; relativePath: string; mtime: number }
type SavedAsset = MediaAsset & { locations: SavedLocation[]; updatedAt: string }
const firstLibrary = 'library-one', secondLibrary = 'library-two', babyId = 'baby-one'
const engine = { async ready() { return { ready: true, error: '' } }, async detect() { assert.fail('浏览不能启动人物检测') } }

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-browse-')), store = new Store(join(directory, 'state.sqlite'))
  for (const id of [firstLibrary, secondLibrary]) store.put('library', { id, path: join(directory, id), name: id, enabled: true })
  return { directory, store, open: () => new MediaCatalog(store, directory, 'receiver', undefined, engine) }
}
function seed(store: Store, directory: string, index: number, options: { date?: string | null; libraryId?: string; personId?: string; embedding?: unknown; score?: number; favorite?: boolean } = {}) {
  const hash = createHash('sha256').update(`browse-media-${index}`).digest('hex'), id = `${hash}-1024`, filename = `photo-${index}.jpg`, libraryId = options.libraryId ?? firstLibrary
  const date = options.date === undefined ? '2024-05-01' : options.date
  const asset: SavedAsset = { id, hash, size: 1024, filename, kind: 'photo', date, dateSource: date ? 'capture' : 'unknown', dateConfirmed: Boolean(date), captureDate: date, creationDate: null, width: 64, height: 48, duration: 0, available: true, locations: [{ id: `position-${index}`, libraryId, path: join(directory, libraryId, filename), relativePath: filename, mtime: 1, source: 'folder', label: libraryId, available: true }], babyIds: [], personIds: [], favorite: options.favorite ?? false, faces: [], faceState: 'done', updatedAt: '2026-01-01T00:00:00Z' }
  store.put('familyAsset', asset)
  const face = { id: `face-${index}`, assetId: id, x: 0.1, y: 0.1, width: 0.3, height: 0.4, score: options.score ?? 0.95, embedding: options.embedding === undefined ? [1, 0] : options.embedding, personId: options.personId ?? 'person-one' }
  store.put('familyFace', face)
  return { asset, face }
}
const snapshot = (store: Store) => store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all()

test('档案参考查询校验宝宝标识与授权范围，拒绝路径及无宝宝的全局查询', () => {
  const query = { referenceBabyId: babyId, scope: 'all' as const, page: 1, limit: 20 }
  assert.deepEqual(validatedQuery(query), query)
  for (const referenceBabyId of ['', null, 1, '../private.jpg', 'C:/private.jpg']) assert.throws(() => validatedQuery({ ...query, referenceBabyId }), /记录标识无效/)
  assert.throws(() => validatedQuery({ scope: 'all' }), /宝宝标识/)
  assert.throws(() => validatedQuery({ ...query, libraryId: firstLibrary }), /不能限定/)
})

test('档案参考按媒体标识跨库读取，去重且不依赖人工归属，停用目录与迟到缓存及时失效', async context => {
  const setup = await fixture(), { store, directory } = setup
  const first = seed(store, directory, 6000), second = seed(store, directory, 6001, { libraryId: secondLibrary }), unrelated = seed(store, directory, 6002)
  const references = [first, second].map(item => ({ assetId: item.asset.id, faceId: item.face.id }))
  store.put('familyBaby', { id: babyId, name: '宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [...references, { assetId: first.asset.id, faceId: 'old-face' }, { assetId: 'missing-media', faceId: 'missing-face' }], updatedAt: '2026-01-01T00:00:00Z' })
  store.put('familyDecision', { id: `${babyId}:${first.asset.id}`, babyId, assetId: first.asset.id, state: 'excluded', origin: 'manual', updatedAt: '2026-01-01T00:00:00Z' })
  const catalog = setup.open(), before = snapshot(store)
  context.mock.method(catalog as any, 'scopedAssets', () => assert.fail('参考查询不应枚举整库媒体'))
  try {
    const query = { referenceBabyId: babyId, scope: 'all' as const, page: 1, limit: 20 }
    const result = catalog.queryMedia(query)
    assert.deepEqual(result.items.map(item => item.id).sort(), [first.asset.id, second.asset.id].sort())
    assert.equal(result.total, 2); assert.ok(result.items.every(item => item.id !== unrelated.asset.id))
    assert.deepEqual(result.items.find(item => item.id === first.asset.id)!.babyIds, [])
    assert.equal(catalog.queryMedia({ referenceBabyId: babyId, scope: 'library', libraryId: firstLibrary }).total, 1)
    assert.throws(() => catalog.queryMedia({ referenceBabyId: babyId, libraryId: 'missing-library' }), /照片库不存在/)
    assert.deepEqual(snapshot(store), before, '浏览参考不能改写人脸、媒体和人工记录')
    store.put('library', { id: secondLibrary, path: join(directory, secondLibrary), name: secondLibrary, enabled: false })
    assert.deepEqual(catalog.queryMedia(query).items.map(item => item.id), [first.asset.id])
    store.put('familyBaby', { ...store.get<any>('familyBaby', babyId), referenceFaces: [] })
    assert.equal(catalog.queryMedia(query).total, 0, '参考移除后不能复用旧列表')
  } finally { context.mock.restoreAll(); await catalog.close(); store.close() }
})

test('2570 项连续分页仅装饰本页，浏览及状态投影不解析全部特征数组且原记录不变', async context => {
  const setup = await fixture(), { store, directory } = setup, vector = Array.from({ length: 512 }, (_, index) => index % 3 ? 0.125 : -0.25)
  store.put('familyPerson', { id: 'person-one', name: '测试人物', embedding: vector })
  const ids: string[] = []
  store.transaction(() => { for (let index = 0; index < 2570; index++) ids.push(seed(store, directory, index, { date: index < 2030 ? '2024-05-01' : '2024-04-01', embedding: vector }).asset.id) })
  const catalog = setup.open(), before = snapshot(store), originalList = store.list.bind(store)
  const originalDecorated = (catalog as any).decorated.bind(catalog)
  let decorated = 0
  context.mock.method(catalog as any, 'decorated', (...args: unknown[]) => { decorated++; return originalDecorated(...args) })
  context.mock.method(store, 'list', (kind: string) => { assert.notEqual(kind, 'familyFace', '浏览不能整批解析人脸向量'); assert.notEqual(kind, 'familyPerson', '浏览不能整批解析人物向量'); return originalList(kind) })
  try {
    const collected: string[] = []
    for (let page = 1; page <= 52; page++) {
      const result = catalog.queryMedia({ libraryId: firstLibrary, page, limit: 50 })
      assert.equal(result.total, 2570); assert.equal(result.items.length, page === 52 ? 20 : 50)
      assert.ok(result.items.every(item => item.faces.length === 1 && item.faces[0].personName === '测试人物'))
      assert.ok(!JSON.stringify(result).includes('embedding'))
      collected.push(...result.items.map(item => item.id))
    }
    assert.equal(decorated, 2570, '所有分页合计只装饰实际返回的媒体，不能每页装饰整库')
    assert.equal(new Set(collected).size, 2570); assert.deepEqual([...collected].sort(), ids.sort())
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, page: 53, limit: 50 }).items.length, 0)
    assert.equal(decorated, 2570, '末尾空页不装饰媒体')
    const state = await catalog.familyState(firstLibrary)
    assert.equal(state.photoCount, 2570); assert.equal(state.people[0].assetCount, 2570); assert.ok(state.people[0].reference)
    assert.ok(!JSON.stringify(state).includes('embedding'))
    assert.deepEqual(snapshot(store), before)
  } finally { context.mock.restoreAll(); await catalog.close(); store.close() }
})

test('轻量过滤保持当前库文件名、真实回执名、来源及人物别名搜索，分页日期排序稳定', async () => {
  const setup = await fixture(), { store, directory } = setup
  store.put('familyPerson', { id: 'person-old', name: '旧名字', embedding: [1, 0], mergedIntoId: 'person-target' }); store.put('familyPerson', { id: 'person-target', name: '统一人物名', embedding: [1, 0] })
  const shared = seed(store, directory, 3000, { date: '2024-06-01', personId: 'person-old', favorite: true })
  shared.asset.locations.push({ ...shared.asset.locations[0], id: 'second-copy', libraryId: secondLibrary, source: 'phone', path: join(directory, secondLibrary, 'renamed.jpg'), relativePath: 'renamed.jpg', receiptId: 'receipt-one' }); store.put('familyAsset', shared.asset)
  store.put('file', { id: 'receipt-one', libraryId: secondLibrary, receiverId: 'receiver', hash: shared.asset.hash, size: shared.asset.size, relativePath: 'renamed.jpg', filename: '手机原名.jpg', savedAt: '2026-01-01T00:00:00Z' })
  const older = seed(store, directory, 3001, { date: '2020-01-01', personId: 'person-target' }), unknown = seed(store, directory, 3002, { date: null, personId: 'person-target' })
  const sameDate = seed(store, directory, 3003, { date: '2020-01-01', personId: 'person-target' }), outside = seed(store, directory, 3004, { libraryId: secondLibrary })
  const catalog = setup.open()
  try {
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, search: '手机原名' }).total, 0)
    assert.equal(catalog.queryMedia({ libraryId: secondLibrary, search: '手机原名' }).items[0].filename, '手机原名.jpg')
    assert.equal(catalog.queryMedia({ libraryId: secondLibrary, search: 'photo-3000' }).total, 0)
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, source: 'phone' }).total, 0)
    assert.equal(catalog.queryMedia({ libraryId: secondLibrary, source: 'phone' }).items[0].id, shared.asset.id)
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, search: '统一人物名' }).total, 4)
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, personId: 'person-old' }).total, 4)
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, favorite: true }).items[0].id, shared.asset.id)
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary }).items.some(item => item.id === outside.asset.id), false)
    for (const order of ['asc', 'desc'] as const) {
      const full = catalog.queryMedia({ libraryId: firstLibrary, order }), pages = [1, 2].map(page => catalog.queryMedia({ libraryId: firstLibrary, order, limit: 2, page }))
      assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), full.items.map(item => item.id))
      assert.equal(full.items.at(-1)!.id, unknown.asset.id)
      const day = full.items.filter(item => item.date === '2020-01-01').map(item => item.id)
      assert.deepEqual(day, [older.asset.id, sameDate.asset.id].sort())
    }
  } finally { await catalog.close(); store.close() }
})

test('宝宝统一结果包括已加入及待确认，排除其它宝宝和人工排除且候选不冒充相册归属', async () => {
  const setup = await fixture(), { store, directory } = setup
  store.put('familyBaby', { id: babyId, name: '宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [], updatedAt: '2026-01-01T00:00:00Z' })
  const included = seed(store, directory, 4000), candidate = seed(store, directory, 4001), excluded = seed(store, directory, 4002), anotherBaby = seed(store, directory, 4003), outside = seed(store, directory, 4004, { libraryId: secondLibrary })
  for (const [assetId, state, origin, targetBaby] of [[included.asset.id, 'included', 'manual', babyId], [candidate.asset.id, 'candidate', 'recognition', babyId], [excluded.asset.id, 'excluded', 'manual', babyId], [anotherBaby.asset.id, 'candidate', 'recognition', 'baby-other'], [outside.asset.id, 'candidate', 'recognition', babyId]]) store.put('familyDecision', { id: `${targetBaby}:${assetId}`, babyId: targetBaby, assetId, state, origin, updatedAt: '2026-01-01T00:00:00Z' })
  const catalog = setup.open(), before = snapshot(store)
  try {
    const merged = catalog.queryMedia({ libraryId: firstLibrary, babyId, includeCandidates: true, limit: 1 })
    assert.equal(merged.total, 2)
    const all = [merged, catalog.queryMedia({ libraryId: firstLibrary, babyId, includeCandidates: true, limit: 1, page: 2 })].flatMap(page => page.items)
    assert.deepEqual(all.map(item => item.id).sort(), [included.asset.id, candidate.asset.id].sort())
    assert.deepEqual(all.find(item => item.id === candidate.asset.id)!.babyIds, [], '待确认不能作为已加入宝宝相册的证据')
    assert.deepEqual(all.find(item => item.id === included.asset.id)!.babyIds, [babyId])
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, babyId }).total, 1)
    assert.equal(catalog.queryMedia({ libraryId: firstLibrary, babyId, candidates: true }).total, 1)
    assert.throws(() => catalog.queryMedia({ includeCandidates: true }), /指定宝宝/)
    assert.throws(() => catalog.queryMedia({ babyId, includeCandidates: true, candidates: true }), /不能与/)
    assert.throws(() => catalog.queryMedia({ babyId, includeCandidates: 'true' } as unknown as MediaQuery), /参数无效/)
    assert.deepEqual(snapshot(store), before)
  } finally { await catalog.close(); store.close() }
})

test('只读投影保留原始记录，头像仅选择有限非零有效特征而不返回向量', async () => {
  const setup = await fixture(), { store, directory } = setup
  store.put('familyPerson', { id: 'person-one', name: '头像测试', embedding: [1, 0] })
  const valid = seed(store, directory, 5000, { embedding: [0.5, -0.5], score: 0.8 })
  seed(store, directory, 5001, { embedding: [], score: 0.99 }); seed(store, directory, 5002, { embedding: [0, 0], score: 0.99 }); seed(store, directory, 5003, { embedding: [1, null], score: 0.99 }); seed(store, directory, 5004, { embedding: [1, '2'], score: 0.99 })
  const catalog = setup.open(), before = snapshot(store)
  try {
    const projected = store.listFaceMetadata<{ id: string; embedding?: number[] }>(true)
    assert.ok(projected.every(face => !('embedding' in face))); assert.equal(projected.filter(face => face.embeddingValid).length, 1)
    assert.ok(!('embedding' in store.listPeopleMetadata<{ id: string }>() [0]))
    const state = await catalog.familyState(firstLibrary)
    assert.equal(state.people[0].reference?.assetId, valid.asset.id); assert.equal(state.people[0].faceCount, 5)
    assert.ok(!JSON.stringify(state).includes('embedding'))
    assert.deepEqual(snapshot(store), before)
  } finally { await catalog.close(); store.close() }
})
