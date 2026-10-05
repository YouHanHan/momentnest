import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import type { BabyProfile, FamilyJob, MediaAsset } from '../src/shared/family.ts'

const vector = (degrees: number) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]
/** 合成缓存覆盖状态和不同角度；所有测试使用独立目录，不加载个人图库。 */
async function fixture(count = 80) {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-baby-match-progress-')), first = join(directory, 'first'), second = join(directory, 'second')
  await mkdir(first); await mkdir(second)
  const store = new Store(join(directory, 'state.sqlite')), firstId = randomUUID(), secondId = randomUUID(), assets: MediaAsset[] = [], detections: string[] = []
  store.put('library', { id: firstId, name: '合成当前库', path: first, enabled: true }); store.put('library', { id: secondId, name: '合成其他库', path: second, enabled: true })
  store.put('workspace', { id: 'current-library', libraryId: firstId })
  for (let index = 0; index < count; index++) {
    const hash = createHash('sha256').update(`synthetic:${index}`).digest('hex'), id = `${hash}-1`, libraryId = index === count - 1 ? secondId : firstId, path = join(libraryId === firstId ? first : second, `${index}.jpg`)
    await writeFile(path, 'x')
    const location = { id: `${index}`, libraryId, source: 'folder' as const, label: '合成库', path, relativePath: `${index}.jpg`, mtime: (await stat(path)).mtimeMs, available: true }
    const asset: MediaAsset = { id, hash, size: 1, filename: `${index}.jpg`, kind: 'photo', date: '2025-05-01', dateSource: 'capture', dateConfirmed: true, captureDate: '2025-05-01', creationDate: null, width: 80, height: 60, duration: 0, available: true, locations: [location], babyIds: [], personIds: [], favorite: false, faces: [], faceState: index === count - 4 ? 'pending' : index === count - 3 ? 'error' : 'done' }
    assets.push(asset); store.put('familyAsset', { ...asset, updatedAt: 'synthetic' })
    if (index < count - 4 || index === count - 1) store.put('familyFace', { id: `face-${index}`, assetId: id, x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: 0.95, embedding: vector(index % 3 === 1 ? 60 : index % 3 === 2 ? 130 : 0) })
  }
  const baby: BabyProfile = { id: randomUUID(), name: '合成宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [{ assetId: assets[0].id, faceId: 'face-0' }], updatedAt: 'synthetic' }
  store.put('familyBaby', baby)
  const catalog = new MediaCatalog(store, directory, 'synthetic', undefined, { async ready() { return { ready: true, error: '' } }, async detect(path: string) { detections.push(path); return [] } })
  return { directory, store, catalog, assets, baby, firstId, secondId, detections }
}
async function waitJobs(store: Store) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error('合成匹配未完成。')
}

test('宝宝缓存匹配立即返回进度，范围与完整覆盖一致，不调用检测并保留人工决定', async () => {
  const f = await fixture()
  try {
    f.catalog.setBabyMembership(f.baby.id, [f.assets[40].id], false)
    const result = f.catalog.matchBaby(f.baby.id, f.firstId)
    assert.equal(result.state, 'running'); assert.equal(result.total, 79); assert.equal(result.processed, 16)
    assert.deepEqual(result.coverage, { total: 79, done: 77, pending: 1, error: 1, noFaces: 1, supplementPending: 1 })
    f.catalog.setBabyMembership(f.baby.id, [f.assets[60].id], false)
    await waitJobs(f.store)
    const state = await f.catalog.familyState(f.firstId), status = state.babyMatching![0]
    assert.equal(status.state, 'done'); assert.equal(status.processed, 79); assert.equal(status.scope, 'library'); assert.equal(status.libraryId, f.firstId)
    assert.equal(f.catalog.queryMedia({ babyId: f.baby.id, libraryId: f.secondId, includeCandidates: true }).total, 0)
    assert.equal(f.catalog.queryMedia({ babyId: f.baby.id, libraryId: f.firstId, includeCandidates: true }).items.some(asset => [f.assets[40].id, f.assets[60].id].includes(asset.id)), false)
    assert.deepEqual(f.detections, []); assert.ok(status.addedCandidates > 30)
    const all = f.catalog.matchBaby(f.baby.id, undefined, 'all'); assert.equal(all.total, 80); await waitJobs(f.store)
    assert.equal(f.catalog.queryMedia({ babyId: f.baby.id, libraryId: f.secondId, includeCandidates: true }).total, 1)
    const allTotal = f.catalog.queryMedia({ babyId: f.baby.id, scope: 'all', includeCandidates: true }).total
    f.store.put('library', { id: f.secondId, name: '停用其他库', path: join(f.directory, 'second'), enabled: false })
    assert.equal(f.catalog.queryMedia({ babyId: f.baby.id, scope: 'all', includeCandidates: true }).total, allTotal - 1, '全局宝宝结果与匹配范围使用相同有效授权条件')
    assert.throws(() => f.catalog.queryMedia({ babyId: f.baby.id, libraryId: f.firstId, scope: 'all' }), /全部授权目录/)
    assert.throws(() => f.catalog.queryMedia({ scope: 'all' }), /宝宝标识/)
    assert.throws(() => f.catalog.matchBaby(f.baby.id, f.firstId, 'all'), /全部授权目录/)
    assert.throws(() => f.catalog.matchBaby(f.baby.id, undefined, 'library'), /文本|标识/)
  } finally { await f.catalog.close(); f.store.close() }
})

test('参考变化停止旧分块，手工确认与参考标记分开且覆盖包含失效参考', async () => {
  const f = await fixture(100)
  try {
    f.catalog.matchBaby(f.baby.id, f.firstId)
    assert.throws(() => f.catalog.saveBaby({ ...f.baby, referenceFaces: [{ assetId: f.assets[2].id, faceId: 'face-2' }, { assetId: f.assets[3].id, faceId: 'missing-face' }] }), /新参考人脸不存在/)
    f.catalog.saveBaby({ ...f.baby, referenceFaces: [{ assetId: f.assets[2].id, faceId: 'face-2' }] })
    await waitJobs(f.store)
    const status = (await f.catalog.familyState(f.firstId)).babyMatching![0]
    assert.equal(status.state, 'done'); assert.equal(status.validReferences, 1); assert.equal(status.processed, 99)
    assert.equal(f.catalog.queryMedia({ libraryId: f.firstId, babyId: f.baby.id, includeCandidates: true }).items.some(asset => asset.id === f.assets[0].id), false, '旧参考分块不得迟到重新加入')
    const asset = f.catalog.queryMedia({ libraryId: f.firstId, search: '2.jpg' }).items.find(asset => asset.id === f.assets[2].id)!
    assert.deepEqual(asset.babyReferenceIds, [f.baby.id]); assert.equal(asset.babyDecisions![0].state, 'candidate'); assert.equal(asset.babyDecisions![0].origin, 'recognition')
    f.catalog.setBabyMembership(f.baby.id, [asset.id], true)
    assert.equal(f.catalog.queryMedia({ libraryId: f.firstId, search: '2.jpg' }).items.find(item => item.id === asset.id)!.babyDecisions![0].origin, 'manual')
    const current = f.store.get<BabyProfile>('familyBaby', f.baby.id)!; f.store.put('familyBaby', { ...current, referenceFaces: [...current.referenceFaces, { assetId: f.assets[3].id, faceId: 'missing-face' }] })
    const invalid = f.catalog.matchBaby(f.baby.id, f.firstId); assert.equal(invalid.invalidReferences, 1); await waitJobs(f.store)
    assert.ok(!JSON.stringify(f.catalog.queryMedia({ libraryId: f.firstId })).includes('embedding'))
  } finally { await f.catalog.close(); f.store.close() }
})

test('二十个宝宝参考明确拒绝新增，重复同一参考保留全部旧参考', async () => {
  const f = await fixture(25)
  try {
    const references = f.assets.slice(0, 20).map((asset, index) => ({ assetId: asset.id, faceId: `face-${index}` }))
    f.catalog.saveBaby({ ...f.baby, referenceFaces: references }); await waitJobs(f.store)
    assert.throws(() => f.catalog.setBabyReference(f.baby.id, f.assets[20].id, 'face-20'), /最多保留 20.*移除/)
    assert.deepEqual(f.store.get<BabyProfile>('familyBaby', f.baby.id)!.referenceFaces, references)
    f.catalog.setBabyReference(f.baby.id, f.assets[0].id, 'face-0'); await waitJobs(f.store)
    assert.deepEqual(f.store.get<BabyProfile>('familyBaby', f.baby.id)!.referenceFaces, references)
  } finally { await f.catalog.close(); f.store.close() }
})

test('移除全部目录的最后参考分块清除识别结果，两个库的人工加入和排除继续保留', async () => {
  const f = await fixture()
  try {
    f.catalog.setBabyMembership(f.baby.id, [f.assets[0].id], true)
    f.catalog.setBabyMembership(f.baby.id, [f.assets[40].id], false)
    f.catalog.matchBaby(f.baby.id, undefined, 'all'); await waitJobs(f.store)
    assert.equal(f.catalog.queryMedia({ babyId: f.baby.id, libraryId: f.secondId, includeCandidates: true }).total, 1)
    const existing = f.store.get<BabyProfile>('familyBaby', f.baby.id)!
    assert.throws(() => f.catalog.saveBaby({ ...existing, referenceFaces: [] }, 'cloud' as any), /范围无效/)
    assert.deepEqual(f.store.get<BabyProfile>('familyBaby', f.baby.id)!.referenceFaces, existing.referenceFaces, '非法范围不能先保存档案')
    f.catalog.saveBaby({ ...existing, referenceFaces: [] }, 'all'); await waitJobs(f.store)
    assert.deepEqual(f.catalog.queryMedia({ babyId: f.baby.id, scope: 'all', includeCandidates: true }).items.map(asset => asset.id), [f.assets[0].id])
    assert.equal(f.catalog.queryMedia({ babyId: f.baby.id, libraryId: f.secondId, includeCandidates: true }).total, 0)
    assert.equal(f.store.get<any>('familyDecision', `${f.baby.id}:${f.assets[0].id}`).origin, 'manual')
    assert.equal(f.store.get<any>('familyDecision', `${f.baby.id}:${f.assets[40].id}`).state, 'excluded')
    const status = (await f.catalog.familyState(f.firstId)).babyMatching![0]
    assert.equal(status.scope, 'all'); assert.equal(status.state, 'done'); assert.equal(status.validReferences, 0); assert.equal(status.included, 1); assert.equal(status.candidates, 0)
    assert.deepEqual(f.detections, []); assert.equal(f.store.list('familyAsset').length, 80); assert.equal(f.store.list('familyFace').length, 77)
  } finally { await f.catalog.close(); f.store.close() }
})

test('仅重试失败的人脸分析不读取未处理或已完成媒体，缓存完成项不重复', async () => {
  const f = await fixture(8)
  try {
    f.catalog.analyzeFaces(f.firstId, true); await waitJobs(f.store)
    assert.equal(f.detections.length, 1); assert.ok(f.detections[0].endsWith('5.jpg'))
    assert.equal(f.catalog.queryMedia({ libraryId: f.firstId, search: '4.jpg' }).items[0].faceState, 'pending')
    f.catalog.analyzeFaces(f.firstId, true); await waitJobs(f.store); assert.equal(f.detections.length, 1)
    assert.throws(() => f.catalog.analyzeFaces(f.firstId, 'yes' as any), /参数无效/)
  } finally { await f.catalog.close(); f.store.close() }
})

test('真实接收工作线程立即序列化匹配进度，后续 IPC 可查询完成结果且不启动检测', async () => {
  const f = await fixture(96)
  await f.catalog.close(); f.store.close()
  await copyFile(join(f.directory, 'state.sqlite'), join(f.directory, 'receiver.sqlite'))
  const worker = new Worker(new URL('../src/service/worker.ts', import.meta.url), { workerData: { dataDirectory: f.directory, modelDirectory: join(f.directory, 'no-models'), host: '127.0.0.1', port: 0 }, execArgv: ['--experimental-transform-types'] })
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>(); let nextId = 0, workerReady = false
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('合成接收线程启动超时。')), 10000)
    worker.on('error', error => { clearTimeout(timer); reject(error) })
    worker.on('message', message => { if (message.ready) { clearTimeout(timer); workerReady = true; resolve() } else if (message.fatal) { clearTimeout(timer); reject(new Error(message.fatal)) } else { const request = pending.get(message.id); if (request) { clearTimeout(request.timer); pending.delete(message.id); if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value) } } })
  })
  const call = (method: string, ...args: unknown[]) => new Promise<any>((resolve, reject) => { const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('合成 IPC 响应超时。')) }, 5000); pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, method, args }) })
  try {
    await ready
    const result = await call('matchBaby', f.baby.id, f.firstId, 'library')
    assert.equal(result.state, 'running'); assert.equal(result.processed, 16); assert.equal(result.total, 95)
    assert.ok(!JSON.stringify(result).includes('embedding')); assert.ok(!('then' in result), '工作线程不能向主进程传递 Promise 对象')
    let finished = false
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = await call('familyState', f.firstId)
      if (state.babyMatching[0].state === 'done') { assert.equal(state.babyMatching[0].processed, 95); assert.equal(state.jobs.filter((job: FamilyJob) => job.kind === 'faces').length, 0); finished = true; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.ok(finished, '工作线程匹配未结束。')
    const beforeMutation = await call('familyState', f.firstId)
    const membershipMutation = await call('setBabyMembership', f.baby.id, [f.assets[95].id], true)
    assert.equal(membershipMutation.before, beforeMutation.browseRevision)
    assert.equal(membershipMutation.after, (await call('familyState', f.firstId)).browseRevision)
    const favoriteMutation = await call('setFavorite', f.assets[0].id, true)
    assert.equal(favoriteMutation.before, membershipMutation.after)
    assert.equal(favoriteMutation.after, (await call('familyState', f.firstId)).browseRevision)
    await call('saveBaby', { ...f.baby, referenceFaces: [] }, 'all')
    finished = false
    for (let attempt = 0; attempt < 200; attempt++) { const state = await call('familyState', f.firstId); if (state.babyMatching[0].state === 'done' && state.babyMatching[0].scope === 'all') { assert.equal(state.babyMatching[0].validReferences, 0); finished = true; break }; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.ok(finished, '工作线程全局参考清理未结束。')
    const remaining = await call('queryMedia', { babyId: f.baby.id, scope: 'all', includeCandidates: true })
    assert.equal(remaining.total, 1); assert.equal(remaining.items[0].id, f.assets[95].id); assert.equal(remaining.items[0].babyDecisions[0].origin, 'manual')
  } finally { if (workerReady) await call('close').catch(() => {}); await worker.terminate() }
})
