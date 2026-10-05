import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import type { BabyDecision, BabyProfile, MediaAsset } from '../src/shared/family.ts'

/** 使用独立临时数据库和合成媒体验证浏览失效，不访问个人照片或启动模型。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-browse-revision-')), libraryPath = join(directory, 'library'), databasePath = join(directory, 'state.sqlite')
  await mkdir(libraryPath)
  const store = new Store(databasePath), libraryId = randomUUID(), assets: MediaAsset[] = []
  store.put('library', { id: libraryId, name: '合成照片库', path: libraryPath, enabled: true })
  store.put('workspace', { id: 'current-library', libraryId })
  for (let index = 0; index < 2; index++) {
    const filename = `synthetic-${index}.jpg`, bytes = Buffer.from(filename), path = join(libraryPath, filename), hash = createHash('sha256').update(bytes).digest('hex'), id = `${hash}-${bytes.length}`
    await writeFile(path, bytes)
    const asset: MediaAsset & { updatedAt: string } = { id, hash, size: bytes.length, filename, kind: 'photo', date: '2024-03-10', dateSource: 'capture', dateConfirmed: true, captureDate: '2024-03-10', creationDate: null, width: 320, height: 240, duration: 0, available: true, locations: [{ id: `location-${index}`, libraryId, source: 'folder', label: '合成位置', path, available: true }], babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'done', updatedAt: '2024-03-10T00:00:00Z' }
    assets.push(asset); store.put('familyAsset', asset)
  }
  const baby: BabyProfile = { id: 'synthetic-baby', name: '合成宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [], updatedAt: '2024-03-10T00:00:00Z' }
  store.put('familyBaby', baby)
  store.put('familyPerson', { id: 'synthetic-person', name: '合成人物', embedding: [1, 0] })
  store.put('familyFace', { id: 'synthetic-face', assetId: assets[0].id, personId: 'synthetic-person', x: 0.1, y: 0.1, width: 0.3, height: 0.3, score: 0.95, embedding: [1, 0] })
  const catalog = new MediaCatalog(store, directory, 'synthetic-receiver', undefined, {
    async ready() { return { ready: true, error: '' } },
    async detect() { throw new Error('浏览版本测试不应进行人脸检测。') },
  })
  return { directory, databasePath, store, catalog, assets, libraryId, baby }
}

test('人工归属同数量交换仍使旧宝宝浏览缓存失效', async () => {
  const f = await fixture()
  try {
    const initial = await f.catalog.familyState(f.libraryId)
    assert.equal(typeof initial.browseRevision, 'string')
    assert.equal(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).total, 0)
    f.catalog.setBabyMembership(f.baby.id, [f.assets[0].id], true)
    const added = await f.catalog.familyState(f.libraryId)
    assert.notEqual(added.browseRevision, initial.browseRevision)
    assert.equal(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).total, 1)
    f.catalog.setBabyMembership(f.baby.id, [f.assets[0].id], false)
    f.catalog.setBabyMembership(f.baby.id, [f.assets[1].id], true)
    const swapped = await f.catalog.familyState(f.libraryId)
    assert.notEqual(swapped.browseRevision, added.browseRevision)
    assert.equal(swapped.photoCount, added.photoCount)
    assert.equal(swapped.candidateCount, added.candidateCount)
    assert.deepEqual(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).items.map(asset => asset.id), [f.assets[1].id])
  } finally { await f.catalog.close(); f.store.close() }
})

test('收藏、日期与人物名称改变浏览版本且查询显示最新记录', async () => {
  const f = await fixture()
  try {
    let revision = (await f.catalog.familyState(f.libraryId)).browseRevision
    f.catalog.setFavorite(f.assets[0].id, true)
    let state = await f.catalog.familyState(f.libraryId)
    assert.notEqual(state.browseRevision, revision)
    assert.deepEqual(f.catalog.queryMedia({ libraryId: f.libraryId, favorite: true }).items.map(asset => asset.id), [f.assets[0].id])
    revision = state.browseRevision
    f.catalog.setMediaDate(f.assets[0].id, '2024-03-11')
    state = await f.catalog.familyState(f.libraryId)
    assert.notEqual(state.browseRevision, revision)
    assert.equal(f.catalog.queryMedia({ libraryId: f.libraryId, from: '2024-03-11', to: '2024-03-11' }).items[0].dateSource, 'manual')
    revision = state.browseRevision
    f.catalog.namePerson('synthetic-person', '确认的名字')
    state = await f.catalog.familyState(f.libraryId)
    assert.notEqual(state.browseRevision, revision)
    assert.equal(state.people[0].name, '确认的名字')
    assert.equal(state.photoCount, 2)
  } finally { await f.catalog.close(); f.store.close() }
})

test('普通浏览与本连接非浏览记录更新不会使版本抖动', async () => {
  const f = await fixture()
  try {
    const revision = (await f.catalog.familyState(f.libraryId)).browseRevision
    f.catalog.queryMedia({ libraryId: f.libraryId }); f.store.listFaceMetadata(true); f.store.listPeopleMetadata()
    f.store.get('familyBaby', f.baby.id); f.store.listByInsertion('familyJob')
    assert.equal((await f.catalog.familyState(f.libraryId)).browseRevision, revision)
    for (const kind of ['familyJob', 'familyPlan', 'familyWarning', 'familyExport', 'session', 'batch', 'device', 'config']) {
      f.store.put(kind, { id: `unrelated-${kind}`, state: 'done', processed: 1, total: 1 })
      assert.equal(f.store.browseRevision, revision, `${kind} 的进度或记录不能使图库缓存反复失效`)
    }
    for (const kind of ['familyAsset', 'familyBaby', 'familyDecision', 'familyDate', 'familyFace', 'familyPerson', 'library', 'root', 'workspace']) {
      const before = f.store.browseRevision
      f.store.put(kind, { id: `revision-${kind}` })
      assert.notEqual(f.store.browseRevision, before, `${kind} 变化必须使浏览缓存失效`)
    }
  } finally { await f.catalog.close(); f.store.close() }
})

test('另一 SQLite 连接提交人工归属后版本失效，只读与未提交写入保持稳定', async () => {
  const f = await fixture(), external = new DatabaseSync(f.databasePath)
  try {
    const revision = (await f.catalog.familyState(f.libraryId)).browseRevision
    external.prepare('SELECT count(*) AS count FROM records').get()
    assert.equal(f.store.browseRevision, revision)
    external.exec('BEGIN IMMEDIATE')
    const decision: BabyDecision = { id: `${f.baby.id}:${f.assets[0].id}`, babyId: f.baby.id, assetId: f.assets[0].id, state: 'included', origin: 'manual', updatedAt: '2024-03-10T00:00:00Z' }
    external.prepare('INSERT INTO records VALUES(?,?,?)').run('familyDecision', decision.id, JSON.stringify(decision))
    assert.equal(f.store.browseRevision, revision)
    external.exec('COMMIT')
    const changed = await f.catalog.familyState(f.libraryId)
    assert.notEqual(changed.browseRevision, revision)
    assert.deepEqual(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).items.map(asset => asset.id), [f.assets[0].id])
    assert.equal((await f.catalog.familyState(f.libraryId)).browseRevision, changed.browseRevision)
  } finally { external.close(); await f.catalog.close(); f.store.close() }
})

test('Store 新实例不能复用上个实例的浏览版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-browse-epoch-')), path = join(directory, 'state.sqlite')
  const first = new Store(path), firstRevision = first.browseRevision
  first.close()
  const second = new Store(path)
  try { assert.notEqual(second.browseRevision, firstRevision) } finally { second.close() }
})

test('事务回滚保留原记录并保守使先前浏览版本失效', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-browse-rollback-')), store = new Store(join(directory, 'state.sqlite'))
  try {
    store.put('familyDecision', { id: 'synthetic-decision', state: 'included' })
    const revision = store.browseRevision
    assert.throws(() => store.transaction(() => { store.put('familyDecision', { id: 'synthetic-decision', state: 'excluded' }); throw new Error('合成事务中断') }), /合成事务中断/)
    assert.deepEqual(store.get('familyDecision', 'synthetic-decision'), { id: 'synthetic-decision', state: 'included' })
    assert.notEqual(store.browseRevision, revision)
    assert.equal(store.browseRevision, store.browseRevision)
  } finally { store.close() }
})

test('收藏与人工归属返回修改前后版本，分别对应修改前和最新家庭状态', async () => {
  const f = await fixture()
  try {
    const original = await f.catalog.familyState(f.libraryId)
    const favorite = f.catalog.setFavorite(f.assets[0].id, true)
    assert.equal(favorite.before, original.browseRevision)
    assert.notEqual(favorite.after, favorite.before)
    assert.equal(favorite.after, (await f.catalog.familyState(f.libraryId)).browseRevision)
    assert.deepEqual(Object.keys(favorite).sort(), ['after', 'before'])
    const membership = f.catalog.setBabyMembership(f.baby.id, [f.assets[0].id, f.assets[0].id], true)
    assert.equal(membership.before, favorite.after)
    assert.notEqual(membership.after, membership.before)
    assert.equal(membership.after, (await f.catalog.familyState(f.libraryId)).browseRevision)
    assert.equal(f.store.list<BabyDecision>('familyDecision').length, 1, '重复同一媒体仍只保存一条人工决定')
    assert.equal(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).total, 1)
  } finally { await f.catalog.close(); f.store.close() }
})

test('其它记录变化后局部修改的 before 不冒充旧缓存，后续变化也不冒充 after', async () => {
  const f = await fixture()
  try {
    const cachedRevision = (await f.catalog.familyState(f.libraryId)).browseRevision
    f.catalog.setMediaDate(f.assets[1].id, '2024-04-01')
    const favorite = f.catalog.setFavorite(f.assets[0].id, true)
    assert.notEqual(favorite.before, cachedRevision)
    assert.equal(favorite.after, (await f.catalog.familyState(f.libraryId)).browseRevision)
    const cachedBeforeMembership = favorite.after
    f.catalog.namePerson('synthetic-person', '已更新的人物')
    const membership = f.catalog.setBabyMembership(f.baby.id, [f.assets[0].id], true)
    assert.notEqual(membership.before, cachedBeforeMembership)
    assert.equal(membership.after, (await f.catalog.familyState(f.libraryId)).browseRevision)
    f.catalog.setMediaDate(f.assets[1].id, '2024-05-01')
    assert.notEqual(membership.after, (await f.catalog.familyState(f.libraryId)).browseRevision)
  } finally { await f.catalog.close(); f.store.close() }
})

test('重复人工加入或排除返回版本并保持单条决定，缓存匹配不能覆盖人工结果', async () => {
  const f = await fixture()
  try {
    f.store.put('familyBaby', { ...f.baby, autoMatch: true, referenceFaces: [{ assetId: f.assets[0].id, faceId: 'synthetic-face' }] })
    for (const included of [false, false, true, true]) {
      const before = f.store.browseRevision
      const mutation = f.catalog.setBabyMembership(f.baby.id, [f.assets[0].id], included)
      assert.equal(mutation.before, before)
      assert.equal(mutation.after, f.store.browseRevision)
      f.catalog.matchBaby(f.baby.id, f.libraryId)
      const decisions = f.store.list<BabyDecision>('familyDecision')
      assert.equal(decisions.length, 1)
      assert.equal(decisions[0].origin, 'manual')
      assert.equal(decisions[0].state, included ? 'included' : 'excluded')
      assert.equal(f.catalog.queryMedia({ libraryId: f.libraryId, babyId: f.baby.id }).total, included ? 1 : 0)
    }
  } finally { await f.catalog.close(); f.store.close() }
})
