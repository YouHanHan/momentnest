import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import { hashFile } from '../src/service/files.ts'
import { readMetadata, videoFrameTimes } from '../src/service/media-tools.ts'
import type { BabyDecision, BabyProfile, FamilyJob, MediaAsset } from '../src/shared/family.ts'

const detected = () => [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.95, embedding: [1, 0] }]

/** 测试只建立合成媒体和独立数据库，等待已发起任务结束。 */
async function waitJobs(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('合成图库人物任务未完成。')
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-supplement-')), data = join(directory, 'state')
  await mkdir(data)
  const store = new Store(join(data, 'synthetic.sqlite'))
  const library = async (name: string, enabled = true) => {
    const path = join(directory, name), id = randomUUID()
    await mkdir(path); store.put('library', { id, path, name, enabled })
    return { id, path }
  }
  return { data, store, library }
}

/** 种入旧版本无脸缓存，实际文件内容和可用位置仍接受服务校验。 */
async function oldPhoto(store: Store, library: { id: string; path: string }, filename: string, color: string, extra: Record<string, unknown> = {}) {
  const path = join(library.path, filename)
  await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).jpeg().toFile(path)
  return seedAsset(store, library, path, 'photo', extra)
}

async function seedAsset(store: Store, library: { id: string; path: string }, path: string, kind: 'photo' | 'video', extra: Record<string, unknown> = {}) {
  const identity = await hashFile(path), id = `${identity.hash}-${identity.size}`
  const asset = { id, hash: identity.hash, size: identity.size, filename: basename(path), kind, date: null, dateSource: 'unknown', dateConfirmed: false, captureDate: null, creationDate: null, width: 80, height: 60, duration: 0, available: true, locations: [{ id: randomUUID(), path, relativePath: basename(path), mtime: identity.mtime, label: library.id, libraryId: library.id, source: 'folder', available: true }], babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'done', faceFrames: kind === 'photo' ? ['photo'] : ['3'], updatedAt: new Date().toISOString(), ...extra }
  store.put('familyAsset', asset)
  return asset
}

test('旧无脸补检限定授权范围、实际人脸记录与策略版本，保留人工归属并只生成疑似', async () => {
  const { data, store, library } = await fixture(), first = await library('first'), second = await library('second'), disabled = await library('disabled', false)
  const candidate = await oldPhoto(store, first, 'candidate.jpg', '#992233')
  const excluded = await oldPhoto(store, first, 'excluded.jpg', '#336699')
  const empty = await oldPhoto(store, first, 'empty.jpg', '#aa7733')
  await oldPhoto(store, first, 'already-supplemented.jpg', '#995577', { faceSupplementVersion: 1 })
  const failed = await oldPhoto(store, first, 'failed-cache.jpg', '#337744', { faceState: 'error' })
  const normal = await oldPhoto(store, first, 'normal.jpg', '#5566bb')
  const other = await oldPhoto(store, second, 'other.jpg', '#ccaa33')
  await oldPhoto(store, disabled, 'disabled.jpg', '#44aaaa')
  const normalFace = { ...detected()[0], id: 'normal-face', assetId: normal.id, personId: 'normal-person' }
  store.put('familyFace', normalFace); store.put('familyPerson', { id: 'normal-person', name: '已命名人物', embedding: [1, 0] })
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: true, referenceFaces: [{ assetId: normal.id, faceId: normalFace.id }], updatedAt: new Date().toISOString() }
  store.put('familyBaby', baby)
  const manualBaby = { ...baby, id: randomUUID(), name: '手动宝宝', autoMatch: false }
  store.put('familyBaby', manualBaby)
  const calls: string[] = []
  const catalog = new MediaCatalog(store, data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path: string) { calls.push(basename(path)); return basename(path) === 'empty.jpg' ? [] : detected() } })
  try {
    catalog.setBabyMembership(baby.id, [excluded.id], false)
    const before = await catalog.familyState(first.id)
    assert.equal(before.analysis?.noFaces, 4); assert.equal(before.analysis?.supplementPending, 3)
    assert.equal(catalog.matchBaby(baby.id, first.id).coverage.supplementPending, 3)
    catalog.supplementFaces(first.id)
    assert.throws(() => catalog.supplementFaces(first.id), /同类任务正在进行/)
    assert.throws(() => catalog.analyzeFaces(first.id), /同类任务正在进行/)
    await waitJobs(store)
    assert.deepEqual(calls.sort(), ['candidate.jpg', 'empty.jpg', 'excluded.jpg'])
    assert.deepEqual(store.get('familyFace', normalFace.id), normalFace, '已有清晰人脸、人物和参考保持原样')
    assert.deepEqual(store.get<BabyProfile>('familyBaby', baby.id)?.referenceFaces, baby.referenceFaces)
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${candidate.id}`)?.state, 'candidate')
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${candidate.id}`)?.score, 1)
    assert.equal(store.get<BabyDecision>('familyDecision', `${manualBaby.id}:${candidate.id}`)?.state, 'candidate', '关闭自动加入时手动补检仍展示疑似')
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${excluded.id}`)?.origin, 'manual')
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${excluded.id}`)?.state, 'excluded')
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${normal.id}`)?.state, 'included', '普通强匹配继续自动加入')
    const found = catalog.queryMedia({ libraryId: first.id, search: 'candidate' }).items[0].faces[0]
    assert.equal(found.reviewRequired, true); assert.equal(found.personId, undefined)
    assert.deepEqual([found.x, found.y, found.width, found.height], [0.1, 0.2, 0.3, 0.4])
    assert.equal(store.list('familyPerson').length, 1, '补检不会自动创建或合入人物')
    assert.equal(store.get<any>('familyAsset', empty.id)?.faceSupplementVersion, 1)
    assert.deepEqual(store.get<any>('familyAsset', empty.id)?.faceFrames, ['photo', 'supplement:1:photo'])
    assert.equal(store.get<any>('familyAsset', failed.id)?.faceState, 'error')
    const after = await catalog.familyState(first.id)
    assert.equal(after.analysis?.noFaces, 2); assert.equal(after.analysis?.supplementPending, 0)
    assert.equal(catalog.matchBaby(baby.id, first.id).coverage.supplementPending, 0)
    const jobs = store.list('familyJob').length
    catalog.supplementFaces(first.id); assert.equal(store.list('familyJob').length, jobs, '完成后无脸也不会反复补检')
    assert.equal((await catalog.familyState()).analysis?.supplementPending, 1)
    catalog.supplementFaces(); await waitJobs(store)
    assert.equal(calls.filter(name => name === 'other.jpg').length, 1)
    assert.equal(store.get<any>('familyAsset', other.id)?.faceSupplementVersion, 1)
    assert.equal(calls.includes('disabled.jpg'), false, '全部范围仍排除已撤销授权的目录')
    assert.equal((await hashFile(join(first.path, 'candidate.jpg'))).hash, candidate.hash)
    assert.ok(!JSON.stringify(catalog.queryMedia({ libraryId: first.id })).includes('faceSupplementVersion'))
  } finally { await catalog.close(); store.close() }
})

test('普通新照片旋转兜底只产生未归组候选，无脸照片完成策略后复用缓存', async () => {
  const { data, store, library } = await fixture(), current = await library('photos')
  const normal = await oldPhoto(store, current, 'normal.jpg', '#992244')
  const fallback = await oldPhoto(store, current, 'fallback.jpg', '#44bb88', { faceState: 'pending', faceFrames: [] })
  const empty = await oldPhoto(store, current, 'empty.jpg', '#6677aa', { faceState: 'pending', faceFrames: [] })
  store.put('familyFace', { ...detected()[0], id: 'reference', assetId: normal.id, personId: 'known' })
  store.put('familyPerson', { id: 'known', name: '', embedding: [1, 0] })
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: true, referenceFaces: [{ assetId: normal.id, faceId: 'reference' }], updatedAt: new Date().toISOString() }
  store.put('familyBaby', baby)
  let calls = 0
  const catalog = new MediaCatalog(store, data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path: string) { calls++; return basename(path) === 'empty.jpg' ? [] : [{ ...detected()[0], reviewRequired: true }] } })
  try {
    catalog.analyzeFaces(current.id); await waitJobs(store)
    assert.equal(calls, 2)
    assert.equal(catalog.queryMedia({ libraryId: current.id, search: 'fallback' }).items[0].faces[0].personId, undefined)
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${fallback.id}`)?.state, 'candidate')
    assert.equal(store.get<any>('familyAsset', empty.id)?.faceSupplementVersion, 1)
    assert.equal((await catalog.familyState(current.id)).analysis?.supplementPending, 0)
    catalog.supplementFaces(current.id); catalog.analyzeFaces(current.id); await waitJobs(store)
    assert.equal(calls, 2)
  } finally { await catalog.close(); store.close() }
})

test('补检单张失败不阻塞后续，失败重试保持补检策略并保留旧帧', async () => {
  const { data, store, library } = await fixture(), current = await library('photos')
  const failed = await oldPhoto(store, current, 'failed.jpg', '#88aa22')
  const next = await oldPhoto(store, current, 'next.jpg', '#338877')
  let failing = true
  const calls = new Map<string, number>()
  const catalog = new MediaCatalog(store, data, 'test', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path: string) { const name = basename(path); calls.set(name, (calls.get(name) ?? 0) + 1); if (name === 'failed.jpg' && failing) throw new Error('合成解码失败'); return detected() } })
  try {
    catalog.supplementFaces(current.id); await waitJobs(store)
    const record = store.get<any>('familyAsset', failed.id)
    assert.equal(record.faceState, 'error'); assert.equal(record.faceSupplementing, true); assert.equal(record.faceSupplementVersion, undefined)
    assert.deepEqual(record.faceFrames, ['photo'])
    assert.equal(store.get<any>('familyAsset', next.id)?.faceState, 'done')
    const job = store.listByInsertion<FamilyJob>('familyJob')[0]
    assert.equal(job.processed, 1); assert.equal(job.skipped, 1); assert.match(job.warnings![0], /failed.jpg.*合成解码失败/)
    failing = false
    catalog.analyzeFaces(current.id, true); assert.throws(() => catalog.analyzeFaces(current.id, true), /同类任务正在进行/); await waitJobs(store)
    assert.equal(calls.get('failed.jpg'), 2); assert.equal(calls.get('next.jpg'), 1)
    assert.equal(store.get<any>('familyAsset', failed.id)?.faceSupplementing, false)
    assert.equal(store.get<any>('familyAsset', failed.id)?.faceSupplementVersion, 1)
    assert.equal(catalog.queryMedia({ libraryId: current.id, search: 'failed' }).items[0].faces[0].reviewRequired, true)
  } finally { await catalog.close(); store.close() }
})

test('视频补检保持原稀疏缓存，局部失败重启后只检查未完成帧并保留人工参考', async () => {
  const { data, store, library } = await fixture(), current = await library('videos'), path = join(current.path, 'synthetic.mp4')
  await new Promise<void>((resolve, reject) => execFile(ffmpegPath!, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=red:s=80x60:r=1:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-n', path], { windowsHide: true }, error => error ? reject(error) : resolve()))
  const video = await seedAsset(store, current, path, 'video')
  let calls = 0, failing = true
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { calls++; if (calls === 2 && failing) throw new Error('合成第二帧失败'); return detected() } }
  let catalog = new MediaCatalog(store, data, 'test', undefined, engine)
  try {
    catalog.supplementFaces(current.id); await waitJobs(store)
    const partial = store.get<any>('familyAsset', video.id)
    assert.equal(partial.duration, 6, '旧缓存时长未知时，先用本地工具恢复时长再抽样')
    assert.equal(partial.faceState, 'error'); assert.deepEqual(partial.faceFrames, ['3', 'supplement:1:1'])
    const firstFace = catalog.queryMedia({ libraryId: current.id }).items[0].faces[0]
    assert.equal(firstFace.frameTime, 1); assert.equal(firstFace.reviewRequired, true)
    const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: false, referenceFaces: [], updatedAt: new Date().toISOString() }
    catalog.saveBaby(baby); catalog.setBabyReference(baby.id, video.id, firstFace.id)
    await catalog.close()
    // 模拟进程在补检中断退出时尚未把媒体状态改成失败。
    store.put('familyAsset', { ...partial, faceState: 'pending' })
    failing = false; catalog = new MediaCatalog(store, data, 'test', undefined, engine)
    assert.equal(store.get<any>('familyAsset', video.id)?.faceState, 'error')
    catalog.analyzeFaces(current.id, true); await waitJobs(store)
    assert.equal(calls, 4, '第一帧已完成，下次只重试第二帧和检查第三帧')
    const result = catalog.queryMedia({ libraryId: current.id }).items[0]
    assert.deepEqual(result.faces.map(face => face.frameTime).sort(), [1, 3, 5])
    assert.equal(result.faces.find(face => face.frameTime === 1)?.id, firstFace.id)
    assert.deepEqual(store.get<any>('familyAsset', video.id)?.faceFrames, ['3', 'supplement:1:1', 'supplement:1:3', 'supplement:1:5'])
    assert.deepEqual(store.get<BabyProfile>('familyBaby', baby.id)?.referenceFaces, [{ assetId: video.id, faceId: firstFace.id }])
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${video.id}`)?.origin, 'manual')
    assert.equal((await hashFile(path)).hash, video.hash)
  } finally { await catalog.close(); store.close() }
})

test('视频时长持续未知时保留起始帧与疑似并记录覆盖失败，时长恢复后可继续补检', async () => {
  const { data, store, library } = await fixture(), current = await library('unknown-duration'), path = join(current.path, 'synthetic.mp4')
  await new Promise<void>((resolve, reject) => execFile(ffmpegPath!, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=80x60:r=1:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'matroska', '-live', '1', '-n', path], { windowsHide: true }, error => error ? reject(error) : resolve()))
  assert.equal((await readMetadata(path, 'video')).duration, 0, '合成原始视频保留未知时长条件')
  const video = await seedAsset(store, current, path, 'video'), reference = await oldPhoto(store, current, 'reference.jpg', '#5599aa')
  store.put('familyFace', { ...detected()[0], id: 'known-reference', assetId: reference.id })
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: false, referenceFaces: [{ assetId: reference.id, faceId: 'known-reference' }], updatedAt: new Date().toISOString() }
  store.put('familyBaby', baby)
  let calls = 0
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { calls++; return detected() } }
  let catalog = new MediaCatalog(store, data, 'test', undefined, engine)
  try {
    catalog.supplementFaces(current.id); await waitJobs(store)
    const incomplete = store.get<any>('familyAsset', video.id)
    assert.equal(calls, 1, incomplete.faceError); assert.equal(incomplete.faceState, 'error'); assert.equal(incomplete.faceSupplementing, true)
    assert.equal(incomplete.faceSupplementVersion, undefined); assert.match(incomplete.faceError, /时长仍未知.*覆盖不完整.*仅重试失败项/)
    assert.deepEqual(incomplete.faceFrames, ['3', 'supplement:1:0'])
    const startFace = catalog.queryMedia({ libraryId: current.id, search: 'synthetic' }).items[0].faces[0]
    assert.equal(startFace.frameTime, 0); assert.equal(startFace.reviewRequired, true)
    assert.equal(store.get<BabyDecision>('familyDecision', `${baby.id}:${video.id}`)?.state, 'candidate')
    const job = store.listByInsertion<FamilyJob>('familyJob')[0]
    assert.equal(job.processed, 0); assert.equal(job.skipped, 1); assert.match(job.warnings![0], /覆盖不完整/)
    catalog.analyzeFaces(current.id, true); await waitJobs(store)
    assert.equal(calls, 1, '时长未恢复时重复重试复用起始帧，不重复检测')
    assert.equal(store.get<any>('familyAsset', video.id)?.faceSupplementVersion, undefined)
    await catalog.close()
    store.put('familyAsset', { ...store.get<any>('familyAsset', video.id), duration: 6 })
    catalog = new MediaCatalog(store, data, 'test', undefined, engine)
    catalog.analyzeFaces(current.id, true); await waitJobs(store)
    assert.equal(calls, 4)
    const completed = store.get<any>('familyAsset', video.id)
    assert.equal(completed.faceState, 'done'); assert.equal(completed.faceSupplementVersion, 1); assert.equal(completed.faceSupplementing, false)
    assert.deepEqual(completed.faceFrames, ['3', 'supplement:1:0', 'supplement:1:1', 'supplement:1:3', 'supplement:1:5'])
    assert.equal(catalog.queryMedia({ libraryId: current.id, search: 'synthetic' }).items[0].faces.find(face => face.frameTime === 0)?.id, startFace.id)
    assert.equal((await hashFile(path)).hash, video.hash)
  } finally { await catalog.close(); store.close() }
})

test('视频有限抽样保持每约两秒、短视频至少三帧、长视频至多四十八帧及未知时长界限', () => {
  assert.deepEqual(videoFrameTimes(6, true), [1, 3, 5])
  assert.equal(videoFrameTimes(1, true).length, 3)
  const long = videoFrameTimes(3600, true)
  assert.equal(long.length, 48); assert.ok(long[0] >= 0 && long.at(-1)! < 3600)
  assert.equal(videoFrameTimes(3600).length, 8)
  assert.deepEqual(videoFrameTimes(0, true), [0]); assert.deepEqual(videoFrameTimes(Number.NaN, true), [0])
})
