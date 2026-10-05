import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import { readRebuildBabySnapshot } from '../src/service/face-rebuild-snapshot.ts'
import type { BabyDecision, BabyProfile, FamilyJob, MediaAsset, MediaFace } from '../src/shared/family.ts'

type Face = MediaFace & { assetId: string; embedding: number[] }
type Detection = Omit<Face, 'assetId' | 'id' | 'personId'>
const detection = (x = 0.1, embedding = [1, 0]): Detection => ({ x, y: 0.1, width: 0.2, height: 0.3, score: 0.96, embedding })

/** 合成文件只供验证授权路径及内容保护，不接触真实相册。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-face-rebuild-')), data = join(directory, 'state'), first = join(directory, 'first'), second = join(directory, 'second')
  await Promise.all([data, first, second].map(path => mkdir(path)))
  const firstId = randomUUID(), secondId = randomUUID(), store = new Store(join(data, 'family.sqlite'))
  const paths = new Map([[firstId, first], [secondId, second]])
  for (const [id, path] of paths) store.put('library', { id, path, name: id, enabled: true })
  store.put('workspace', { id: 'current-library', libraryId: firstId })
  const addAsset = async (filename: string, libraryIds = [firstId]) => {
    const bytes = Buffer.from(`synthetic original ${filename}`), hash = createHash('sha256').update(bytes).digest('hex'), id = `${hash}-${bytes.length}`, thumbnailPath = join(data, `${hash}.thumbnail.jpg`)
    await writeFile(thumbnailPath, '保留缩略图')
    const locations = []
    for (const libraryId of libraryIds) {
      const path = join(paths.get(libraryId)!, filename); await writeFile(path, bytes); const info = await stat(path)
      locations.push({ id: `${id}:${libraryId}`, libraryId, source: 'folder' as const, label: '测试库', path, relativePath: filename, mtime: info.mtimeMs, available: true })
    }
    const asset: MediaAsset & { thumbnailPath: string; faceFrames: string[]; faceSupplementVersion: number; updatedAt: string } = { id, hash, size: bytes.length, filename, kind: 'photo', date: '2024-03-10', dateSource: 'manual', dateConfirmed: true, captureDate: '2024-03-11', creationDate: '2024-03-12', width: 320, height: 240, duration: 0, available: true, locations, babyIds: [], personIds: [], favorite: true, faces: [], faceState: 'done', faceFrames: ['photo', 'supplement:1:photo'], faceSupplementVersion: 1, thumbnailPath, updatedAt: 'old-index' }
    store.put('familyAsset', asset)
    return asset
  }
  const addFace = (asset: MediaAsset, index: number, personId: string, face: Detection = detection()) => {
    const id = createHash('sha256').update(`${asset.id}:photo:${index}`).digest('hex'), saved: Face = { ...face, id, assetId: asset.id, personId }
    store.put('familyFace', saved); return saved
  }
  const addPerson = (id: string, name = '', extra: Record<string, unknown> = {}) => store.put('familyPerson', { id, name, embedding: [1, 0], ...extra })
  return { directory, data, firstId, secondId, store, paths, addAsset, addFace, addPerson }
}

/** 等待持久化任务结束，不调用可能启动自动分析的状态接口。 */
async function waitJobs(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('重建测试任务未结束。')
}

test('重建进行及中断期间保留重扫前宝宝结果，人工排除优先且新匹配完成后替换旧结果', async () => {
  const f = await fixture(), included = await f.addAsset('included.jpg'), candidate = await f.addAsset('candidate.jpg'), removed = await f.addAsset('removed.jpg')
  f.addPerson('old-person')
  const oldFace = f.addFace(included, 0, 'old-person'); f.addFace(candidate, 0, 'old-person'); f.addFace(removed, 0, 'old-person')
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [{ assetId: included.id, faceId: oldFace.id }], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  for (const [asset, state] of [[included, 'included'], [candidate, 'candidate'], [removed, 'included']] as const) f.store.put('familyDecision', { id: `${baby.id}:${asset.id}`, babyId: baby.id, assetId: asset.id, origin: 'recognition', state, score: 0.8, updatedAt: 'before-rebuild' } satisfies BabyDecision)
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const first = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { began(); await gate; throw new Error('合成中断前解码失败') } })
  let second: MediaCatalog | undefined
  try {
    await first.rebuildFaceIndex(f.firstId); await started
    const query = { libraryId: f.firstId, babyId: baby.id, includeCandidates: true }
    assert.equal(first.queryMedia(query).total, 3, '后台清理自动归属不能使浏览结果消失')
    assert.ok(first.queryMedia(query).items.every(asset => asset.babyDecisions?.some(decision => decision.rebuildPending)))
    assert.ok(first.queryMedia(query).items.every(asset => !asset.babyIds.includes(baby.id)), '旧结果不冒充已确认归属或自动水印资格')
    assert.equal((await first.familyState(f.firstId)).faceRebuilds?.[0].state, 'running')
    first.setBabyMembership(baby.id, [removed.id], false)
    assert.equal(first.queryMedia(query).total, 2)
    const closing = first.close(); release(); await closing
    const rebuild = f.store.get<{ epoch: string; backupPath: string }>('familyRebuild', f.firstId)!, backupBytes = await readFile(rebuild.backupPath)
    second = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path) { return [detection(0.1, basename(path) === 'candidate.jpg' ? [0, 1] : [1, 0])] } })
    const state = await second.familyState(f.firstId)
    assert.equal(state.faceRebuilds?.[0].state, 'interrupted'); assert.equal(state.babyMatching?.[0].state, 'error')
    assert.equal(second.queryMedia(query).total, 2); assert.equal(second.queryMedia({ ...query, includeCandidates: false, candidates: true }).total, 1)
    await second.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
    assert.equal(second.queryMedia(query).total, 1, '新匹配判定不相似后移至待核对，不继续冒充旧疑似')
    assert.equal(second.queryMedia(query).items[0].id, included.id)
    assert.ok(!second.queryMedia(query).items[0].babyDecisions?.[0].rebuildPending)
    assert.equal((await second.familyState(f.firstId)).faceRebuilds?.length, 0)
    assert.equal(f.store.get<BabyDecision>('familyDecision', `${baby.id}:${removed.id}`)!.origin, 'manual')
    assert.deepEqual(await readFile(rebuild.backupPath), backupBytes, '兼容浏览及继续重建不改写旧备份')
    assert.equal((await readdir(join(f.data, 'face-index-backups'))).length, 1)
    assert.equal(f.store.get<{ epoch: string }>('familyRebuild', f.firstId)!.epoch, rebuild.epoch)
  } finally { release(); await first.close(); await second?.close(); f.store.close() }
})

test('检测阶段处理中断后只继续剩余媒体，累计进度和整库总量保持一致', async () => {
  const f = await fixture(); await f.addAsset('first.jpg'); await f.addAsset('second.jpg'); await f.addAsset('third.jpg')
  const [finished, inFlight, pending] = f.store.list<MediaAsset>('familyAsset')
  f.addPerson('named', '宝宝'); const reference = f.addFace(finished, 0, 'named'); f.addFace(inFlight, 0, 'named'); f.addFace(pending, 0, 'named')
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [{ assetId: finished.id, faceId: reference.id }], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const first = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path) { if (basename(path) === finished.filename) return [detection()]; began(); await gate; return [detection()] } })
  let second: MediaCatalog | undefined
  try {
    await first.rebuildFaceIndex(f.firstId); await started
    const cached = f.store.list<Face>('familyFace')[0]
    const closing = first.close(); release(); await closing
    const previous = f.store.get<{ epoch: string; phase: string }>('familyRebuild', f.firstId)!
    assert.equal(previous.phase, 'detecting'); assert.equal(f.store.get<MediaAsset>('familyAsset', pending.id)!.faceState, 'pending')
    const calls: string[] = []
    second = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path) { calls.push(basename(path)); return [detection()] } })
    const status = (await second.familyState(f.firstId)).faceRebuilds![0]
    assert.equal(status.processed, 2); assert.equal(status.total, 3); assert.equal(status.state, 'interrupted')
    second.analyzeFaces(f.firstId); await waitJobs(f.store)
    assert.deepEqual(calls, [pending.filename]); assert.equal(f.store.get<Face>('familyFace', cached.id)!.id, cached.id)
    assert.equal(f.store.get<{ epoch: string }>('familyRebuild', f.firstId)!.epoch, previous.epoch)
    assert.equal((await readdir(join(f.data, 'face-index-backups'))).length, 1)
  } finally { release(); await first.close(); await second?.close(); f.store.close() }
})

test('旧宝宝结果快照只读内部备份，拒绝外部路径；范围、人工决定和同步不混用旧结果', async () => {
  const f = await fixture(), target = await f.addAsset('target.jpg'), foreign = await f.addAsset('foreign.jpg', [f.secondId])
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: false, referenceFaces: [], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  for (const asset of [target, foreign]) f.store.put('familyDecision', { id: `${baby.id}:${asset.id}`, babyId: baby.id, assetId: asset.id, origin: 'recognition', state: 'included', updatedAt: 'original' } satisfies BabyDecision)
  await mkdir(join(f.data, 'face-index-backups'))
  const backupPath = join(f.data, 'face-index-backups', 'legacy.sqlite'), outsidePath = join(f.directory, 'outside.sqlite')
  f.store.backup(backupPath); f.store.backup(outsidePath)
  const bytes = await readFile(backupPath)
  assert.equal(readRebuildBabySnapshot(f.data, backupPath).length, 2)
  assert.throws(() => readRebuildBabySnapshot(f.data, outsidePath), /应用数据目录/)
  f.store.put('familyRebuild', { id: f.firstId, epoch: 'legacy-epoch', assetIds: [target.id], annotations: [], phase: 'detecting', backupPath, updatedAt: 'legacy' })
  f.store.put('familyDecision', { id: `${baby.id}:${target.id}`, babyId: baby.id, assetId: target.id, origin: 'recognition', state: 'unconfirmed', updatedAt: 'legacy' } satisfies BabyDecision)
  const catalog = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { throw new Error('浏览不检测') } })
  try {
    const revision = f.store.browseRevision
    assert.equal(catalog.queryMedia({ babyId: baby.id, libraryId: f.firstId }).items[0].babyDecisions?.[0].rebuildPending, true)
    assert.ok(!catalog.queryMedia({ babyId: baby.id, libraryId: f.secondId }).items[0].babyDecisions?.[0].rebuildPending)
    const sync = catalog.sync({ babies: [], decisions: [] })
    assert.equal(sync.decisions.length, 0); assert.ok(sync.assets.every(asset => !asset.babyDecisions?.some(decision => decision.rebuildPending)))
    assert.equal(f.store.browseRevision, revision, '读取快照和浏览不批量恢复真实归属')
    catalog.setBabyMembership(baby.id, [target.id], false)
    assert.equal(catalog.queryMedia({ babyId: baby.id, libraryId: f.firstId, includeCandidates: true }).total, 0)
    assert.deepEqual(await readFile(backupPath), bytes)
    f.store.put('familyRebuild', { id: f.firstId, epoch: 'invalid-epoch', assetIds: [target.id], annotations: [], phase: 'detecting', backupPath: outsidePath, updatedAt: 'invalid' })
    const status = (await catalog.familyState(f.firstId)).faceRebuilds![0]
    assert.equal(status.snapshotAvailable, false); assert.equal(status.state, 'interrupted')
    assert.ok(!JSON.stringify(status).includes('outside.sqlite'))
  } finally { await catalog.close(); f.store.close() }
})

test('先生成完整备份再清旧头像，重新检测原媒体并保持人工信息和其他库人脸', async () => {
  const f = await fixture(), target = await f.addAsset('target.jpg'), shared = await f.addAsset('shared.jpg', [f.firstId, f.secondId]), foreign = await f.addAsset('foreign.jpg', [f.secondId])
  f.addPerson('obsolete-auto'); f.addPerson('shared-person'); f.addPerson('foreign-person')
  f.addPerson('orphan-named', '旧无脸姓名', { embedding: [0, 1] }); f.addPerson('orphan-auto', '', { embedding: [0, 1] })
  f.addPerson('orphan-manual-alias', '', { embedding: [0, 1], mergedIntoId: 'orphan-named', mergeOrigin: 'manual' })
  const oldTarget = f.addFace(target, 0, 'obsolete-auto'), oldShared = f.addFace(shared, 0, 'shared-person'), oldForeign = f.addFace(foreign, 0, 'foreign-person')
  f.store.put('familyDate', { id: target.id, assetId: target.id, date: target.date, updatedAt: 'date-preserved' })
  const baby: BabyProfile = { id: randomUUID(), name: '测试宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [], avatarAssetId: target.id, updatedAt: 'baby-preserved' }
  f.store.put('familyBaby', baby)
  const manual: BabyDecision = { id: `${baby.id}:${target.id}`, babyId: baby.id, assetId: target.id, origin: 'manual', state: 'excluded', updatedAt: 'manual-preserved' }
  f.store.put('familyDecision', manual)
  let release!: () => void, began!: () => void
  const detectionStarted = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve }), calls: string[] = []
  const catalog = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path) { calls.push(basename(path)); began(); await gate; return [detection(0.1, [0, 1])] } })
  try {
    await catalog.rebuildFaceIndex(f.firstId); await detectionStarted
    const backups = await readdir(join(f.data, 'face-index-backups')); assert.equal(backups.length, 1)
    const backup = new DatabaseSync(join(f.data, 'face-index-backups', backups[0]), { readOnly: true })
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok')
      assert.equal(backup.prepare("SELECT COUNT(*) AS total FROM records WHERE kind='familyFace'").get()!.total, 3)
      assert.deepEqual(JSON.parse(String(backup.prepare("SELECT value FROM records WHERE kind='familyAsset' AND id=?").get(target.id)!.value)), target)
    } finally { backup.close() }
    assert.equal(f.store.get('familyFace', oldTarget.id), undefined); assert.equal(f.store.get('familyFace', oldShared.id), undefined)
    assert.deepEqual(f.store.get('familyFace', oldForeign.id), oldForeign)
    assert.equal(f.store.get('familyPerson', 'obsolete-auto'), undefined)
    assert.equal(f.store.get('familyPerson', 'orphan-auto'), undefined)
    assert.deepEqual(f.store.get<{ embedding: number[] }>('familyPerson', 'orphan-named')!.embedding, [])
    assert.deepEqual(f.store.get<{ embedding: number[] }>('familyPerson', 'orphan-manual-alias')!.embedding, [])
    assert.throws(() => catalog.scanMedia(f.firstId), /正在重建/)
    assert.throws(() => catalog.supplementFaces(f.firstId), /正在重建|同类任务/)
    release(); await waitJobs(f.store)
    assert.deepEqual(calls.sort(), ['shared.jpg', 'target.jpg'])
    const newFaces = f.store.list<Face>('familyFace').filter(face => face.assetId !== foreign.id)
    assert.equal(newFaces.length, 2); assert.ok(newFaces.every(face => face.id !== oldTarget.id && face.id !== oldShared.id && face.embedding[1] === 1))
    assert.ok(newFaces.every(face => face.personId !== 'orphan-named'), '无现存脸的旧命名记录保留姓名但旧向量不参与重新归组')
    assert.deepEqual(f.store.get('familyPerson', 'orphan-named'), { id: 'orphan-named', name: '旧无脸姓名', embedding: [] })
    assert.deepEqual(f.store.get('familyFace', oldForeign.id), oldForeign)
    assert.deepEqual(f.store.get('familyAsset', foreign.id), foreign)
    assert.deepEqual(f.store.get('familyBaby', baby.id), baby); assert.deepEqual(f.store.get('familyDecision', manual.id), manual)
    assert.deepEqual(f.store.get('familyDate', target.id), { id: target.id, assetId: target.id, date: target.date, updatedAt: 'date-preserved' })
    for (const asset of [target, shared, foreign]) {
      for (const location of asset.locations) assert.equal((await readFile(location.path)).toString(), `synthetic original ${asset.filename}`)
      assert.equal((await readFile(asset.thumbnailPath)).toString(), '保留缩略图')
      const saved = f.store.get<typeof asset>('familyAsset', asset.id)!
      for (const key of ['date', 'dateSource', 'dateConfirmed', 'captureDate', 'creationDate', 'favorite', 'thumbnailPath', 'locations'] as const) assert.deepEqual(saved[key], asset[key])
    }
    assert.equal(f.store.get<{ phase: string }>('familyRebuild', f.firstId)!.phase, 'done')
    assert.match(f.store.list<FamilyJob>('familyJob').at(-1)!.label, /重建完成/)
  } finally { release(); await catalog.close(); f.store.close() }
})

test('检测顺序变化只按唯一框重叠还原宝宝参考和命名人物，不使用旧向量', async () => {
  const f = await fixture(), asset = await f.addAsset('reference.jpg')
  f.addPerson('named', '宝宝名字'); f.addPerson('other')
  const oldReference = f.addFace(asset, 0, 'named', detection(0.1, [0.7, 0.7])), oldOther = f.addFace(asset, 1, 'other', detection(0.6, [0.7, -0.7]))
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [{ assetId: asset.id, faceId: oldReference.id }], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  const catalog = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { return [detection(0.6, [0, 1]), detection(0.1, [1, 0])] } })
  try {
    await catalog.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
    const savedBaby = f.store.get<BabyProfile>('familyBaby', baby.id)!, restored = f.store.get<Face>('familyFace', savedBaby.referenceFaces[0].faceId)!
    assert.notEqual(restored.id, oldReference.id); assert.notEqual(restored.id, oldOther.id)
    assert.equal(restored.x, 0.1); assert.deepEqual(restored.embedding, [1, 0]); assert.equal(restored.personId, 'named')
    assert.equal(f.store.get<{ name: string }>('familyPerson', 'named')!.name, '宝宝名字')
    const other = f.store.list<Face>('familyFace').find(face => face.x === 0.6)!
    assert.notEqual(other.personId, 'named'); assert.deepEqual(other.embedding, [0, 1])
    assert.doesNotThrow(() => catalog.matchBaby(baby.id, f.firstId))
  } finally { await catalog.close(); f.store.close() }
})

test('框变化不明确时旧宝宝参考保持失效，单项失败保留原因并继续检测其他原媒体', async () => {
  const f = await fixture(), reference = await f.addAsset('reference.jpg'), bad = await f.addAsset('bad.jpg'), good = await f.addAsset('good.jpg')
  f.addPerson('old-person'); const oldFace = f.addFace(reference, 0, 'old-person')
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [{ assetId: reference.id, faceId: oldFace.id }], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  const catalog = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path) { if (basename(path) === 'bad.jpg') throw new Error('合成解码失败'); return [detection(0.6, [0, 1])] } })
  try {
    await catalog.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
    assert.deepEqual(f.store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces, baby.referenceFaces)
    assert.equal(f.store.get('familyFace', oldFace.id), undefined)
    assert.throws(() => catalog.matchBaby(baby.id, f.firstId), /参考人脸已失效/)
    assert.equal(f.store.get<MediaAsset>('familyAsset', reference.id)!.faceState, 'done'); assert.equal(f.store.get<MediaAsset>('familyAsset', good.id)!.faceState, 'done')
    assert.equal(f.store.get<MediaAsset>('familyAsset', bad.id)!.faceState, 'error'); assert.match(f.store.get<MediaAsset>('familyAsset', bad.id)!.faceError!, /合成解码失败/)
    const job = f.store.list<FamilyJob>('familyJob').at(-1)!; assert.equal(job.skipped, 1); assert.equal(job.processed, 2)
    assert.match(catalog.getJobWarnings(job.id, 1, f.firstId).items[0], /bad\.jpg.*合成解码失败/)
    assert.ok(f.store.get<{ annotations: unknown[] }>('familyRebuild', f.firstId)!.annotations.length > 0, '失效引用的几何书签持久保留供恢复')
  } finally { await catalog.close(); f.store.close() }
})

test('模型不可用、任务冲突或备份失败均不清旧头像索引', async () => {
  for (const reason of ['model', 'busy', 'backup'] as const) {
    const f = await fixture(), asset = await f.addAsset('retained.jpg'); f.addPerson('retained'); const oldFace = f.addFace(asset, 0, 'retained')
    const catalog = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: reason !== 'model', error: '模型不可用' } }, async detect() { throw new Error('禁止在前置失败时检测') } })
    try {
      if (reason === 'busy') f.store.put('familyJob', { id: 'busy-task', kind: 'import', state: 'running', processed: 0, total: 0, label: '占用任务', error: '' })
      if (reason === 'backup') {
        f.store.backup = () => { throw new Error('模拟备份空间不足') }
        await catalog.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
        assert.match(f.store.list<FamilyJob>('familyJob').at(-1)!.error, /备份空间不足/)
      } else await assert.rejects(catalog.rebuildFaceIndex(f.firstId), reason === 'model' ? /模型不可用/ : /本地处理正在进行/)
      assert.deepEqual(f.store.get('familyFace', oldFace.id), oldFace); assert.deepEqual(f.store.get('familyAsset', asset.id), asset)
      assert.deepEqual(f.store.get('familyPerson', 'retained'), { id: 'retained', name: '', embedding: [1, 0] })
      assert.equal((await readFile(asset.locations[0].path)).toString(), 'synthetic original retained.jpg')
    } finally { await catalog.close(); f.store.close() }
  }
})

test('重建中断后沿用持久化新特征和几何书签，恢复归组不重复清除或检测', async () => {
  const f = await fixture(), asset = await f.addAsset('resume.jpg'); f.addPerson('named', '保留名字'); const old = f.addFace(asset, 0, 'named')
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [{ assetId: asset.id, faceId: old.id }], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const first = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { began(); await gate; return [detection(0.1, [0, 1])] } })
  let second: MediaCatalog | undefined
  try {
    await first.rebuildFaceIndex(f.firstId); await started
    const closing = first.close(); release(); await closing
    assert.equal(f.store.list<FamilyJob>('familyJob').at(-1)!.state, 'error')
    const cached = f.store.list<Face>('familyFace')[0], saved = f.store.get<{ epoch: string; phase: string }>('familyRebuild', f.firstId)!
    assert.notEqual(cached.id, old.id); assert.equal(saved.phase, 'grouping')
    let calls = 0
    second = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { calls++; throw new Error('恢复不能重新检测已完成照片') } })
    await second.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
    const restored = f.store.get<Face>('familyFace', cached.id)!
    assert.equal(calls, 0); assert.equal(restored.personId, 'named'); assert.deepEqual(restored.embedding, [0, 1])
    assert.equal(f.store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces[0].faceId, restored.id)
    assert.equal(f.store.get<{ epoch: string; phase: string }>('familyRebuild', f.firstId)!.epoch, saved.epoch)
    assert.equal(f.store.get<{ phase: string }>('familyRebuild', f.firstId)!.phase, 'done')
    assert.equal((await readdir(join(f.data, 'face-index-backups'))).length, 1)
    assert.doesNotThrow(() => second!.matchBaby(baby.id, f.firstId))
  } finally { release(); await first.close(); await second?.close(); f.store.close() }
})

test('同帧写入失败整体回滚，明确重试重新检测整帧并按几何恢复参考', async () => {
  const f = await fixture(), asset = await f.addAsset('atomic.jpg'); f.addPerson('named', '保留名字'); f.addPerson('other')
  const old = f.addFace(asset, 0, 'named'); f.addFace(asset, 1, 'other', detection(0.6, [0, 1]))
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [{ assetId: asset.id, faceId: old.id }], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  let writes = 0, calls = 0
  const originalPut = f.store.put.bind(f.store)
  f.store.put = (kind, value) => { if (kind === 'familyFace' && ++writes === 2) throw new Error('合成一帧第二个人脸写入失败'); originalPut(kind, value) }
  const catalog = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { calls++; return calls === 1 ? [detection(), detection(0.6, [0, 1])] : [detection(0.6, [0, 1]), detection()] } })
  try {
    await catalog.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
    assert.equal(f.store.list<Face>('familyFace').length, 0)
    assert.deepEqual(f.store.get<{ faceFrames: string[] }>('familyAsset', asset.id)!.faceFrames, [])
    assert.equal(f.store.get<MediaAsset>('familyAsset', asset.id)!.faceState, 'error')
    assert.deepEqual(f.store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces, baby.referenceFaces)
    catalog.analyzeFaces(f.firstId, true); await waitJobs(f.store)
    assert.equal(calls, 2); assert.equal(f.store.list<Face>('familyFace').length, 2)
    const reference = f.store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces[0], restored = f.store.get<Face>('familyFace', reference.faceId)!
    assert.equal(restored.x, 0.1); assert.equal(restored.personId, 'named'); assert.notEqual(restored.id, old.id)
    assert.deepEqual(f.store.get<{ faceFrames: string[] }>('familyAsset', asset.id)!.faceFrames, ['photo'])
    assert.equal((await readdir(join(f.data, 'face-index-backups'))).length, 1)
  } finally { await catalog.close(); f.store.close() }
})

test('宝宝回匹分批让出线程，中断后仍在归组阶段并用已检测特征完成余下回匹', async () => {
  const f = await fixture(), assets = []
  for (let index = 0; index < 130; index++) assets.push(await f.addAsset(`tail-${index}.jpg`))
  f.addPerson('old-baby'); const oldReference = f.addFace(assets[0], 0, 'old-baby')
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2023-01-01', autoMatch: true, referenceFaces: [{ assetId: assets[0].id, faceId: oldReference.id }], updatedAt: 'original' }
  f.store.put('familyBaby', baby)
  let firstCalls = 0, closing: Promise<void> | undefined, stopped = false
  const first = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { firstCalls++; return [detection()] } })
  const originalPut = f.store.put.bind(f.store)
  f.store.put = (kind, value) => {
    originalPut(kind, value)
    if (kind === 'familyJob' && !stopped && 'label' in value && String(value.label).startsWith('重新回匹') && String(value.label).endsWith('128/130')) { stopped = true; closing = first.close() }
  }
  let second: MediaCatalog | undefined
  try {
    await first.rebuildFaceIndex(f.firstId); await waitJobs(f.store); await closing
    assert.equal(firstCalls, 130); assert.equal(stopped, true)
    assert.equal(f.store.list<FamilyJob>('familyJob').at(-1)!.state, 'error')
    assert.match(f.store.list<FamilyJob>('familyJob').at(-1)!.error, /回匹已中断/)
    const rebuild = f.store.get<{ epoch: string; phase: string }>('familyRebuild', f.firstId)!
    assert.equal(rebuild.phase, 'grouping')
    assert.equal(f.store.list<BabyDecision>('familyDecision').filter(decision => decision.state === 'included').length, 128)
    assert.ok(assets.every(asset => f.store.get<MediaAsset>('familyAsset', asset.id)!.faceState === 'done'))
    f.store.put = originalPut
    let secondCalls = 0
    second = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { secondCalls++; throw new Error('宝宝回匹恢复不能重新检测') } })
    await second.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
    assert.equal(secondCalls, 0)
    assert.equal(f.store.list<BabyDecision>('familyDecision').filter(decision => decision.state === 'included').length, 130)
    assert.equal(f.store.get<{ epoch: string; phase: string }>('familyRebuild', f.firstId)!.epoch, rebuild.epoch)
    assert.equal(f.store.get<{ phase: string }>('familyRebuild', f.firstId)!.phase, 'done')
    assert.equal((await readdir(join(f.data, 'face-index-backups'))).length, 1)
  } finally { f.store.put = originalPut; await first.close(); await second?.close(); f.store.close() }
})

test('范围外人脸依赖的人工别名链保持全部原记录字节，不把外部样本升级为人工锚点', async () => {
  const f = await fixture(), target = await f.addAsset('target-root.jpg'), foreign = await f.addAsset('foreign-alias.jpg', [f.secondId])
  f.addPerson('shared-root', '共同名字', { embedding: [0.6, 0.8], preserved: { note: '原根记录' } })
  f.addPerson('external-manual-alias', '', { embedding: [0.8, -0.6], mergedIntoId: 'shared-root', mergeOrigin: 'manual', preserved: { note: '人工锚点' } })
  f.addPerson('exclusive-manual-alias', '', { embedding: [-0.6, 0.8], mergedIntoId: 'shared-root', mergeOrigin: 'manual' })
  f.addFace(target, 0, 'shared-root', detection(0.1, [0.6, 0.8]))
  const outsideFace = f.addFace(foreign, 0, 'external-manual-alias', detection(0.1, [1, 0]))
  const raw = (id: string) => String(f.store.db.prepare("SELECT value FROM records WHERE kind='familyPerson' AND id=?").get(id)!.value)
  const beforeRoot = raw('shared-root'), beforeAlias = raw('external-manual-alias')
  const catalog = new MediaCatalog(f.store, f.data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { return [detection(0.1, [0.6, 0.8])] } })
  try {
    await catalog.rebuildFaceIndex(f.firstId); await waitJobs(f.store)
    assert.equal(raw('shared-root'), beforeRoot); assert.equal(raw('external-manual-alias'), beforeAlias)
    assert.deepEqual(f.store.get('familyFace', outsideFace.id), outsideFace)
    assert.deepEqual(f.store.get<{ embedding: number[] }>('familyPerson', 'exclusive-manual-alias')!.embedding, [], '当前库独占的失效锚点清空，不复制外部自动样本')
    assert.equal(f.store.list<FamilyJob>('familyJob').at(-1)!.state, 'done')
  } finally { await catalog.close(); f.store.close() }
})
