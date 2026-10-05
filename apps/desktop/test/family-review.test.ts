import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import { query as validatedQuery } from '../src/main/family-validation.ts'
import type { BabyDecision, BabyProfile, FamilyJob, MediaAsset, MediaQuery } from '../src/shared/family.ts'

const babyId = 'baby-one', firstId = 'library-one', secondId = 'library-two', disabledId = 'library-disabled'
const updatedAt = '2026-01-01T00:00:00Z'

/** 只建立合成索引，人工核对与缓存匹配均不需要读取照片或运行检测。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-baby-review-')), store = new Store(join(directory, 'synthetic.sqlite'))
  for (const id of [firstId, secondId, disabledId]) store.put('library', { id, path: join(directory, id), name: id, enabled: id !== disabledId })
  const baby: BabyProfile = { id: babyId, name: '宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [], updatedAt }
  store.put('familyBaby', baby)
  let detections = 0
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { detections++; assert.fail('核对索引和缓存匹配不能运行模型') } }
  const seed = (index: number, options: { date?: string | null; libraryId?: string; available?: boolean; faceState?: MediaAsset['faceState']; embedding?: number[] } = {}) => {
    const hash = createHash('sha256').update(`synthetic-review-${index}`).digest('hex'), id = `${hash}-1024`, date = options.date === undefined ? '2026-01-01' : options.date, libraryId = options.libraryId ?? firstId
    const asset = { id, hash, size: 1024, filename: `review-${index}.jpg`, kind: 'photo', date, dateSource: date ? 'capture' : 'unknown', dateConfirmed: Boolean(date), captureDate: date, creationDate: null, width: 80, height: 60, duration: 0, available: true, locations: [{ id: `location-${index}`, libraryId, path: join(directory, libraryId, `review-${index}.jpg`), relativePath: `review-${index}.jpg`, mtime: 1, source: 'folder', label: libraryId, available: options.available ?? true }], babyIds: [], personIds: [], favorite: false, faces: [], faceState: options.faceState ?? 'done', updatedAt }
    store.put('familyAsset', asset)
    if (options.embedding) store.put('familyFace', { id: `face-${index}`, assetId: id, x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.95, embedding: options.embedding })
    return asset
  }
  const decide = (assetId: string, state: BabyDecision['state'], origin: BabyDecision['origin'] = 'recognition', score?: number, targetBaby = babyId) => store.put('familyDecision', { id: `${targetBaby}:${assetId}`, babyId: targetBaby, assetId, state, origin, score, updatedAt })
  return { directory, store, baby, seed, decide, open: () => new MediaCatalog(store, directory, 'synthetic', undefined, engine), detections: () => detections }
}

async function waitJobs(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('合成宝宝匹配任务未完成。')
}

const snapshot = (store: Store) => store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all()

test('无参考也可分页核对未分析、失败、无脸及旧自动排除，读取不迁移记录且人工确认优先', async () => {
  const f = await fixture(), pending = f.seed(1, { faceState: 'pending', date: '2026-03-01' }), error = f.seed(2, { faceState: 'error', date: '2026-02-01' }), noFace = f.seed(3, { date: null }), low = f.seed(4, { embedding: [0, 1] }), legacy = f.seed(5, { embedding: [0, 1] })
  const included = f.seed(6), candidate = f.seed(7), excluded = f.seed(8), manualIncluded = f.seed(9), otherBaby = f.seed(10), unconfirmed = f.seed(11)
  f.decide(legacy.id, 'excluded', 'recognition', 0.2); f.decide(included.id, 'included'); f.decide(candidate.id, 'candidate'); f.decide(excluded.id, 'excluded', 'manual'); f.decide(manualIncluded.id, 'included', 'manual'); f.decide(otherBaby.id, 'candidate', 'recognition', 0.5, 'baby-other'); f.decide(unconfirmed.id, 'unconfirmed')
  const catalog = f.open(), before = snapshot(f.store)
  try {
    const query: MediaQuery = { libraryId: firstId, scope: 'library', babyId, unconfirmed: true, limit: 2 }
    const expected = [pending, error, noFace, low, legacy, otherBaby, unconfirmed].map(item => item.id).sort()
    const first = catalog.queryMedia(query)
    assert.equal(first.total, 7); assert.equal(first.items[0].id, pending.id)
    const pages = Array.from({ length: 4 }, (_, index) => catalog.queryMedia({ ...query, page: index + 1 }))
    const all = pages.flatMap(page => page.items)
    assert.deepEqual(all.map(item => item.id).sort(), expected); assert.equal(new Set(all.map(item => item.id)).size, 7)
    assert.equal(all.at(-1)!.id, noFace.id, '未知日期仍排在最后')
    assert.match(all.find(item => item.id === pending.id)!.babyReviewReason!, /尚未分析.*人工核对/)
    assert.match(all.find(item => item.id === error.id)!.babyReviewReason!, /识别失败.*人工核对/)
    assert.match(all.find(item => item.id === noFace.id)!.babyReviewReason!, /未检测到人脸.*人工核对/)
    assert.match(all.find(item => item.id === low.id)!.babyReviewReason!, /尚未设置参考.*人工核对/)
    assert.equal(all.find(item => item.id === legacy.id)!.babyDecisions![0].state, 'unconfirmed')
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${legacy.id}`)!.state, 'excluded', '兼容读取不能批量修改旧缓存')
    assert.deepEqual(snapshot(f.store), before)
    const matched = catalog.queryMedia({ libraryId: firstId, babyId, includeCandidates: true }).items
    assert.deepEqual(matched.map(item => item.id).sort(), [included.id, candidate.id, manualIncluded.id].sort())
    assert.ok(all.every(item => !item.babyIds.includes(babyId)), '未确定项不冒充宝宝归属或疑似')
    assert.equal(catalog.queryMedia({ ...query, from: '2026-02-01' }).total, 2)
    catalog.setBabyMembership(babyId, [pending.id], true); catalog.setBabyMembership(babyId, [noFace.id], false)
    assert.equal(catalog.queryMedia(query).total, 5)
    assert.equal(f.detections(), 0, '无参考仍可人工加入或排除，无需识别成功')
  } finally { await catalog.close(); f.store.close() }
})

test('待核对当前库和全部范围使用实际可用授权位置，共享内容不重复且筛选计数一致', async () => {
  const f = await fixture(), first = f.seed(1), second = f.seed(2, { libraryId: secondId }), disabled = f.seed(3, { libraryId: disabledId }), offline = f.seed(4, { available: false }), shared = f.seed(5, { available: false })
  shared.locations.push({ ...shared.locations[0], id: 'shared-second', libraryId: secondId, available: true }); f.store.put('familyAsset', shared)
  const catalog = f.open()
  try {
    const current = catalog.queryMedia({ libraryId: firstId, scope: 'library', babyId, unconfirmed: true })
    assert.deepEqual(current.items.map(item => item.id), [first.id]); assert.equal(current.total, 1)
    const global = catalog.queryMedia({ scope: 'all', babyId, unconfirmed: true, limit: 1 })
    assert.equal(global.total, 3)
    const all = [1, 2, 3].flatMap(page => catalog.queryMedia({ scope: 'all', babyId, unconfirmed: true, limit: 1, page }).items)
    assert.deepEqual(all.map(item => item.id).sort(), [first.id, second.id, shared.id].sort())
    assert.ok(!all.some(item => item.id === disabled.id || item.id === offline.id))
    assert.equal(catalog.queryMedia({ babyId, unconfirmed: true }).total, 3, '省略scope时也不能泄漏停用或不可用位置')
    assert.equal(catalog.queryMedia({ libraryId: secondId, babyId, unconfirmed: true, search: 'review-5' }).total, 1)
    f.store.put('library', { id: secondId, path: join(f.directory, secondId), name: secondId, enabled: false })
    assert.equal(catalog.queryMedia({ scope: 'all', babyId, unconfirmed: true }).total, 1)
    assert.equal(catalog.queryMedia({ libraryId: secondId, babyId, unconfirmed: true }).total, 0)
  } finally { await catalog.close(); f.store.close() }
})

test('低相似与失效参考只使自动结果回到未确定，人工决定不变且高相似候选保持独立', async () => {
  const f = await fixture(), reference = f.seed(0, { embedding: [1, 0] }), lowFresh = f.seed(1, { embedding: [0, 1] }), previousIncluded = f.seed(2, { embedding: [0, 1] }), previousCandidate = f.seed(3, { embedding: [0, 1] }), oldExcluded = f.seed(4, { embedding: [0, 1] }), manualIncluded = f.seed(5, { embedding: [0, 1] }), manualExcluded = f.seed(6, { embedding: [1, 0] }), strong = f.seed(7, { embedding: [1, 0] }), noFace = f.seed(8)
  f.decide(reference.id, 'included', 'manual'); f.decide(previousIncluded.id, 'included', 'recognition', 0.9); f.decide(previousCandidate.id, 'candidate', 'recognition', 0.5); f.decide(oldExcluded.id, 'excluded', 'recognition', 0.1); f.decide(manualIncluded.id, 'included', 'manual'); f.decide(manualExcluded.id, 'excluded', 'manual')
  f.store.put('familyBaby', { ...f.baby, referenceFaces: [{ assetId: reference.id, faceId: 'face-0' }] })
  const catalog = f.open()
  try {
    catalog.matchBaby(babyId, firstId); await waitJobs(f.store)
    for (const asset of [previousIncluded, previousCandidate, oldExcluded]) assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${asset.id}`)?.state, 'unconfirmed')
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${lowFresh.id}`), undefined, '未知媒体不批量创建自动疑似或排除')
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${noFace.id}`), undefined)
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${manualIncluded.id}`)?.state, 'included')
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${manualExcluded.id}`)?.state, 'excluded')
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${strong.id}`)?.state, 'candidate')
    const pending = catalog.queryMedia({ libraryId: firstId, babyId, unconfirmed: true })
    assert.equal(pending.total, 5); assert.match(pending.items.find(item => item.id === previousIncluded.id)!.babyReviewReason!, /相似度较低.*人工核对/)
    assert.equal(catalog.queryMedia({ libraryId: firstId, babyId, candidates: true }).total, 1)
    catalog.saveBaby({ ...f.baby, referenceFaces: [] }, 'all'); await waitJobs(f.store)
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${babyId}:${strong.id}`)?.state, 'unconfirmed', '无有效参考时也不能自动排除')
    assert.equal(catalog.queryMedia({ scope: 'all', babyId, unconfirmed: true }).total, 6)
    assert.equal(f.detections(), 0)
  } finally { await catalog.close(); f.store.close() }
})

test('待核对查询参数必须明确且同步只接受和输出人工加入或排除', async () => {
  const f = await fixture(), unknown = f.seed(1), included = f.seed(2), excluded = f.seed(3)
  f.decide(unknown.id, 'unconfirmed', 'manual'); f.decide(included.id, 'included', 'manual'); f.decide(excluded.id, 'excluded', 'manual')
  const catalog = f.open()
  try {
    assert.deepEqual(validatedQuery({ babyId, libraryId: firstId, unconfirmed: true }), { babyId, libraryId: firstId, unconfirmed: true })
    for (const invalid of [{ unconfirmed: true }, { babyId, unconfirmed: true, candidates: true }, { babyId, unconfirmed: true, includeCandidates: true }, { babyId, unconfirmed: 'true' }]) {
      assert.throws(() => validatedQuery(invalid)); assert.throws(() => catalog.queryMedia(invalid as MediaQuery))
    }
    assert.throws(() => catalog.sync({ babies: [], decisions: [{ id: `${babyId}:${unknown.id}`, babyId, assetId: unknown.id, origin: 'manual', state: 'unconfirmed', updatedAt }] }), /归属同步数据无效/)
    const result = catalog.sync({ babies: [], decisions: [{ id: `${babyId}:${unknown.id}`, babyId, assetId: unknown.id, origin: 'recognition', state: 'unconfirmed', updatedAt }] })
    assert.deepEqual(result.decisions.map(item => item.assetId).sort(), [included.id, excluded.id].sort())
    assert.ok(result.decisions.every(item => item.origin === 'manual' && ['included', 'excluded'].includes(item.state)))
  } finally { await catalog.close(); f.store.close() }
})
