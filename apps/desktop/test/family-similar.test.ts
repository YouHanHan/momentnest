import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import type { MediaAsset, MediaLocation, SimilarFaceQuery } from '../src/shared/family.ts'

const libraryId = 'library-one', otherLibraryId = 'library-two', rootId = 'historical-root'
const detector = { async ready() { assert.fail('缓存相似查询不需要加载检测模型') }, async detect() { assert.fail('缓存相似查询不重新检测人脸') } }
type SavedLocation = MediaLocation & { rootId?: string; relativePath: string; mtime: number }
type SavedAsset = MediaAsset & { locations: SavedLocation[]; updatedAt: string }
interface SeedOptions {
  libraryId?: string; rootId?: string; available?: boolean; faceState?: MediaAsset['faceState']; kind?: MediaAsset['kind']
  date?: string | null; similarity?: number; faces?: { embedding: number[]; score?: number }[]; personId?: string; locations?: SavedLocation[]
}

/** 使用纯缓存夹具验证查询范围，测试不读取任何实际照片或目录。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-face-query-')), store = new Store(join(directory, 'state.sqlite'))
  store.put('library', { id: libraryId, path: join(directory, 'library-one'), name: '当前库', enabled: true })
  store.put('library', { id: otherLibraryId, path: join(directory, 'library-two'), name: '另一个库', enabled: true })
  store.put('root', { id: rootId, path: join(directory, 'history'), enabled: true })
  return { store, directory, open: () => new MediaCatalog(store, directory, 'receiver', undefined, detector) }
}
function seed(store: Store, directory: string, index: number, options: SeedOptions = {}) {
  const hash = createHash('sha256').update(`synthetic-media-${index}`).digest('hex'), id = `${hash}-1024`, kind = options.kind ?? 'photo', filename = `media-${index}.${kind === 'photo' ? 'jpg' : 'mp4'}`
  const selectedLibrary = options.rootId ? undefined : options.libraryId ?? libraryId
  const location: SavedLocation = { id: `location-${index}`, source: 'folder', label: '缓存位置', path: join(directory, options.rootId ?? selectedLibrary!, filename), libraryId: selectedLibrary, ...(options.rootId ? { rootId: options.rootId } : {}), available: options.available ?? true, relativePath: filename, mtime: 1 }
  const date = options.date === undefined ? '2024-01-01' : options.date
  const asset: SavedAsset = { id, hash, size: 1024, filename, kind, date, dateSource: date ? 'capture' : 'unknown', dateConfirmed: Boolean(date), captureDate: date, creationDate: null, width: 320, height: 240, duration: kind === 'video' ? 10 : 0, available: true, locations: options.locations ?? [location], babyIds: [], personIds: [], favorite: index % 2 === 0, faces: [], faceState: options.faceState ?? 'done', updatedAt: '2026-01-01T00:00:00Z' }
  store.put('familyAsset', asset)
  const similarity = options.similarity ?? 1, faces = options.faces ?? [{ embedding: [similarity, Math.sqrt(1 - similarity ** 2)] }]
  const faceIds = faces.map((face, faceIndex) => {
    const faceId = createHash('sha256').update(`${id}:${faceIndex}`).digest('hex')
    store.put('familyFace', { id: faceId, assetId: id, x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: face.score ?? 0.9, embedding: face.embedding, ...(options.personId ? { personId: options.personId } : {}), ...(kind === 'video' ? { frameTime: faceIndex } : {}) })
    return faceId
  })
  return { asset, faceIds }
}
const records = (store: Store) => store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all()

test('选脸查询跨已拆分人物组和不同月份，完整总数与稳定分页超过已加载 50 项', async () => {
  const setup = await fixture(), { store, directory } = setup
  store.put('familyPerson', { id: 'first-group', name: '同一个人的第一个分组', embedding: [1, 0] })
  store.put('familyPerson', { id: 'second-group', name: '同一个人的第二个分组', embedding: [0.8, 0.6] })
  const reference = seed(store, directory, 0, { personId: 'first-group' }), expected = [reference.asset.id]
  for (let index = 1; index <= 60; index++) expected.push(seed(store, directory, index, { personId: 'second-group', date: `${2020 + index % 3}-${String(index % 12 + 1).padStart(2, '0')}-01`, similarity: 0.9 - index * 0.003 }).asset.id)
  store.put('familyBaby', { id: 'baby-one', name: '测试宝宝', birthday: '2020-01-01', autoMatch: false, referenceFaces: [], updatedAt: '2026-01-01T00:00:00Z' })
  store.put('familyDecision', { id: `baby-one:${expected[2]}`, babyId: 'baby-one', assetId: expected[2], state: 'excluded', origin: 'manual', updatedAt: '2026-01-01T00:00:00Z' })
  const catalog = setup.open(), query: SimilarFaceQuery = { assetId: reference.asset.id, faceId: reference.faceIds[0], scope: 'library', libraryId }
  try {
    const before = records(store)
    assert.equal(catalog.queryMedia({ libraryId, personId: 'first-group' }).total, 1)
    const first = catalog.querySimilarFaces(query)
    assert.equal(first.total, 61); assert.equal(first.items.length, 50); assert.equal(first.threshold, 0.4); assert.deepEqual(first.coverage, { total: 61, done: 61, pending: 0, error: 0 })
    const pages = [1, 2, 3, 4].map(page => catalog.querySimilarFaces({ ...query, page, limit: 20 }))
    assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), expected)
    assert.equal(new Set(pages.flatMap(page => page.items.map(item => item.id))).size, 61)
    assert.ok(first.items.some(item => !item.favorite)); assert.ok(first.items.some(item => item.date?.startsWith('2020')))
    assert.equal(first.items[1].personIds[0], 'second-group')
    assert.ok(first.items.some(item => item.id === expected[2]), '只读相似结果不受宝宝相册的人工归属过滤')
    assert.ok(!JSON.stringify(first).includes('embedding'))
    assert.deepEqual(records(store), before, '相似查询不修改人物、相册归属或识别缓存')
  } finally { await catalog.close(); store.close() }
})

test('全局查询包含全部可用授权库及历史目录，重复内容只一项并排除停用或不可用位置', async () => {
  const setup = await fixture(), { store, directory } = setup, reference = seed(store, directory, 100)
  const current = seed(store, directory, 101), other = seed(store, directory, 102, { libraryId: otherLibraryId }), historical = seed(store, directory, 103, { rootId })
  store.put('library', { id: 'disabled-library', path: join(directory, 'disabled-library'), enabled: false }); store.put('root', { id: 'disabled-root', path: join(directory, 'disabled-root'), enabled: false })
  seed(store, directory, 104, { libraryId: 'disabled-library' }); seed(store, directory, 105, { available: false }); seed(store, directory, 106, { rootId: 'disabled-root' })
  const duplicate = seed(store, directory, 107)
  duplicate.asset.locations.push({ ...duplicate.asset.locations[0], id: 'another-position', libraryId: otherLibraryId, path: join(directory, 'library-two', 'renamed.jpg') }); store.put('familyAsset', duplicate.asset)
  const alternate = seed(store, directory, 108, { available: false })
  alternate.asset.locations.push({ ...alternate.asset.locations[0], id: 'active-other-position', libraryId: otherLibraryId, available: true, path: join(directory, 'library-two', 'alternate.jpg') }); store.put('familyAsset', alternate.asset)
  const catalog = setup.open(), source = { assetId: reference.asset.id, faceId: reference.faceIds[0] }
  try {
    const global = catalog.querySimilarFaces({ ...source, scope: 'all' })
    assert.equal(global.total, 6); assert.equal(global.coverage.total, 6)
    assert.deepEqual(global.items.map(item => item.id).sort(), [reference, current, other, historical, duplicate, alternate].map(item => item.asset.id).sort())
    assert.equal(global.items.filter(item => item.id === duplicate.asset.id).length, 1)
    assert.equal(global.items.find(item => item.id === historical.asset.id)!.available, true)
    const scoped = catalog.querySimilarFaces({ ...source, scope: 'library', libraryId })
    assert.equal(scoped.total, 3); assert.ok(scoped.items.every(item => item.locations.every(location => location.libraryId === libraryId)))
    assert.equal(catalog.queryMedia({ libraryId }).items.some(item => item.id === other.asset.id), false, '普通图库保留当前库范围')
  } finally { await catalog.close(); store.close() }
})

test('覆盖数量明确包含未分析与失败媒体，部分缓存可命中而不假装已完整识别', async () => {
  const setup = await fixture(), { store, directory } = setup, reference = seed(store, directory, 200)
  seed(store, directory, 201, { faces: [] }); seed(store, directory, 202, { faceState: 'pending', faces: [] })
  const partialError = seed(store, directory, 203, { faceState: 'error', similarity: 0.8 }), partialPending = seed(store, directory, 204, { faceState: 'pending' })
  seed(store, directory, 205, { faceState: 'error', faces: [] })
  const catalog = setup.open()
  try {
    const result = catalog.querySimilarFaces({ assetId: reference.asset.id, faceId: reference.faceIds[0], scope: 'all' })
    assert.equal(result.total, 3); assert.deepEqual(result.coverage, { total: 6, done: 2, pending: 2, error: 2 })
    assert.deepEqual(result.items.map(item => item.id).sort(), [reference.asset.id, partialError.asset.id, partialPending.asset.id].sort())
    assert.equal(result.items.find(item => item.id === partialError.asset.id)!.faceState, 'error')
  } finally { await catalog.close(); store.close() }
})

test('媒体类型及日期排序只改变结果展示，未知日期最后且同日以分数与标识稳定排序', async () => {
  const setup = await fixture(), { store, directory } = setup, reference = seed(store, directory, 300, { date: '2026-01-01' })
  const early = seed(store, directory, 301, { date: '2020-01-01', similarity: 0.8 }), video = seed(store, directory, 302, { kind: 'video', date: '2023-01-01', similarity: 0.9 })
  const unknown = seed(store, directory, 303, { date: null, similarity: 0.99 }), sameDate = seed(store, directory, 304, { date: '2020-01-01', similarity: 0.7 })
  const tied = seed(store, directory, 305, { date: '2020-01-01', similarity: 0.7 }), catalog = setup.open(), query: SimilarFaceQuery = { assetId: reference.asset.id, faceId: reference.faceIds[0], scope: 'all' }
  try {
    assert.equal(catalog.querySimilarFaces(query).items[1].id, unknown.asset.id, '默认以相似度排序')
    const ascending = catalog.querySimilarFaces({ ...query, order: 'asc' }).items, descending = catalog.querySimilarFaces({ ...query, order: 'desc' }).items
    assert.equal(ascending[0].id, early.asset.id); assert.equal(ascending.at(-1)!.id, unknown.asset.id)
    assert.equal(descending[0].id, reference.asset.id); assert.equal(descending.at(-1)!.id, unknown.asset.id)
    assert.deepEqual(ascending.slice(1, 3).map(item => item.id), [sameDate.asset.id, tied.asset.id].sort())
    const photos = catalog.querySimilarFaces({ ...query, kind: 'photo' }), videos = catalog.querySimilarFaces({ ...query, kind: 'video' })
    assert.equal(photos.total, 5); assert.equal(photos.coverage.total, 5); assert.ok(photos.items.every(item => item.kind === 'photo'))
    assert.equal(videos.total, 1); assert.equal(videos.coverage.total, 1); assert.equal(videos.items[0].id, video.asset.id)
  } finally { await catalog.close(); store.close() }
})

test('参考必须来自可用授权照片并对应清晰人脸，范围、分页与潜入过滤严格拒绝', async () => {
  const setup = await fixture(), { store, directory } = setup, reference = seed(store, directory, 400), other = seed(store, directory, 401)
  const unclear = seed(store, directory, 402, { faces: [{ embedding: [1, 0], score: 0.49 }] }), unavailable = seed(store, directory, 403, { available: false })
  store.put('library', { id: 'disabled-library', path: join(directory, 'disabled-library'), enabled: false })
  const catalog = setup.open(), query: SimilarFaceQuery = { assetId: reference.asset.id, faceId: reference.faceIds[0], scope: 'all' }
  try {
    assert.equal(catalog.querySimilarFaces(query).total, 2, '不清晰及不可用候选不能作为命中')
    assert.throws(() => catalog.querySimilarFaces({ ...query, faceId: other.faceIds[0] }), /不对应/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, faceId: 'missing-face' }), /不存在/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, assetId: unclear.asset.id, faceId: unclear.faceIds[0] }), /不清晰/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, assetId: unavailable.asset.id, faceId: unavailable.faceIds[0] }), /可用的授权目录/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, scope: 'library', libraryId: 'disabled-library' }), /停用/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, scope: 'library' }), /无效/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, libraryId }), /单个照片库标识/)
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => catalog.querySimilarFaces({ ...query, page: invalid }), /页码无效/)
    for (const invalid of [0, -1, 101, 1.5]) assert.throws(() => catalog.querySimilarFaces({ ...query, limit: invalid }), /无效|数量须/)
    for (const forbidden of ['search', 'from', 'to', 'personId', 'favorite', 'babyId']) assert.throws(() => catalog.querySimilarFaces({ ...query, [forbidden]: 'hidden-filter' } as unknown as SimilarFaceQuery), /不能附带/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, kind: 'audio' } as unknown as SimilarFaceQuery), /媒体类型无效/)
    assert.throws(() => catalog.querySimilarFaces({ ...query, order: 'similarity' } as unknown as SimilarFaceQuery), /日期排序无效/)
  } finally { await catalog.close(); store.close() }
})

test('合照取全部人脸的最高相似度且同一媒体只一项，阈值以下结果不混入', async () => {
  const setup = await fixture(), { store, directory } = setup, reference = seed(store, directory, 500)
  const multiple = seed(store, directory, 501, { faces: [{ embedding: [0, 1] }, { embedding: [0.8, 0.6] }, { embedding: [0.6, 0.8] }] })
  const boundary = seed(store, directory, 502, { similarity: 0.4 })
  seed(store, directory, 503, { similarity: 0.39 })
  const catalog = setup.open()
  try {
    const result = catalog.querySimilarFaces({ assetId: reference.asset.id, faceId: reference.faceIds[0], scope: 'all' })
    assert.equal(result.total, 3); assert.equal(result.coverage.total, 4)
    assert.equal(result.items.filter(item => item.id === multiple.asset.id).length, 1)
    assert.equal(result.items.find(item => item.id === multiple.asset.id)!.similarity, 0.8)
    assert.equal(result.items.find(item => item.id === boundary.asset.id)!.similarity, 0.4)
  } finally { await catalog.close(); store.close() }
})
