import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import { hashFile, mediaKind } from '../src/service/files.ts'
import type { FamilyJob } from '../src/shared/family.ts'
import type { Receipt } from '../src/service/types.ts'

const engine = { async ready() { return { ready: true, error: '' } }, async detect() { return [] } }
const sample = async (path: string, color: string): Promise<void> => {
  await sharp({ create: { width: 48, height: 36, channels: 3, background: color } }).jpeg().toFile(path)
}
const waitJobs = async (catalog: MediaCatalog): Promise<void> => {
  for (let index = 0; index < 600; index++) {
    if (!(await catalog.familyState()).jobs.some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('相册任务未在测试时限内完成。')
}

test('新图库扫描与导入预扫描固定用途，历史未分类任务保持原记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-purpose-')), source = join(directory, 'source'), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([source, library, data].map(path => mkdir(path)))
  await sample(join(source, 'source.jpg'), '#884466'); await sample(join(library, 'library.jpg'), '#447788')
  const store = new Store(join(data, 'state.sqlite')), rootId = randomUUID(), libraryId = randomUUID()
  store.put('root', { id: rootId, path: source, enabled: true }); store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  const legacy: FamilyJob = { id: randomUUID(), libraryId, kind: 'scan', state: 'error', processed: 1, total: 1, label: '历史未分类扫描', error: '历史中断' }
  store.put('familyJob', legacy)
  const original = store.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get('familyJob', legacy.id)!.value
  const catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  try {
    catalog.scanMedia(libraryId)
    const scanning = store.list<FamilyJob>('familyJob').find(job => job.state === 'running')!
    assert.equal(scanning.scanPurpose, 'library'); assert.equal(scanning.libraryId, libraryId)
    await waitJobs(catalog)
    catalog.prepareImport(rootId, 'copy', libraryId)
    const preparing = store.list<FamilyJob>('familyJob').find(job => job.state === 'running')!
    assert.equal(preparing.scanPurpose, 'import-preview'); assert.equal(preparing.libraryId, libraryId)
    await waitJobs(catalog)
    const jobs = (await catalog.familyState(libraryId)).jobs
    assert.equal(jobs.find(job => job.id === scanning.id)!.scanPurpose, 'library')
    assert.equal(jobs.find(job => job.id === preparing.id)!.scanPurpose, 'import-preview')
    assert.equal(jobs.find(job => job.id === legacy.id)!.scanPurpose, undefined)
    assert.equal(store.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get('familyJob', legacy.id)!.value, original, '不能为历史任务猜测用途或批量改写记录')
  } finally { await catalog.close(); store.close() }
})

test('复制归档中间一张来源变化时记录原因并继续保存后续媒体', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-import-continue-')), source = join(directory, 'source'), archive = join(directory, 'archive'), data = join(directory, 'data')
  await Promise.all([source, archive, data].map(path => mkdir(path)))
  const first = join(source, '01-first.jpg'), changed = join(source, '02-changed.jpg'), last = join(source, '03-last.jpg')
  await sample(first, '#993344'); await sample(changed, '#446699'); await sample(last, '#33aa66')
  const originalHashes = await Promise.all([first, last].map(hashFile)), rootId = randomUUID(), libraryId = randomUUID()
  const store = new Store(join(data, 'state.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('root', { id: rootId, path: source, enabled: true }); store.put('library', { id: libraryId, path: archive, name: '归档', enabled: true })
  try {
    const plan = catalog.prepareImport(rootId, 'copy', libraryId); await waitJobs(catalog)
    assert.deepEqual((await catalog.familyState()).importPlans![0].preview.map(item => item.filename), ['01-first.jpg', '02-changed.jpg', '03-last.jpg'])
    const changedBytes = Buffer.concat([await readFile(changed), Buffer.from('changed-after-preview')]); await writeFile(changed, changedBytes)
    catalog.executeImport(plan.id); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs.find(job => job.kind === 'import')!
    assert.equal(job.state, 'done'); assert.equal(job.processed, 2); assert.equal(job.skipped, 1); assert.equal(job.total, 3)
    const report = catalog.getJobWarnings(job.id, 1, libraryId)
    assert.equal(report.total, 1); assert.match(report.items[0], /02-changed\.jpg.*源文件已变化/)
    const receipts = store.list<Receipt>('file')
    assert.deepEqual(receipts.map(item => item.filename).sort(), ['01-first.jpg', '03-last.jpg'])
    for (const receipt of receipts) assert.equal((await hashFile(join(archive, receipt.relativePath))).hash, receipt.hash)
    assert.deepEqual(await Promise.all([first, last].map(hashFile)), originalHashes)
    assert.deepEqual(await readFile(changed), changedBytes, '已跳过的来源媒体仍完整保留')
    assert.equal(catalog.queryMedia({ libraryId }).total, 2)
  } finally { await catalog.close(); store.close() }
})

test('超过 20 个扫描问题全部分页保留，同名子目录原因可辨且重启可读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-warning-report-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path)))
  for (let index = 0; index < 25; index++) { const child = join(library, `folder-${String(index).padStart(2, '0')}`); await mkdir(child); await writeFile(join(child, 'empty.jpg'), Buffer.alloc(0)) }
  await sample(join(library, 'valid.jpg'), '#446688')
  const database = join(data, 'state.sqlite'), libraryId = randomUUID()
  let store = new Store(database), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  try {
    catalog.scanMedia(libraryId); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs[0]
    assert.equal(job.state, 'done'); assert.equal(job.processed, 1); assert.equal(job.skipped, 25); assert.equal(job.total, 26)
    assert.equal(job.warnings?.length, 20); assert.equal(job.warningReportId, job.id)
    const first = catalog.getJobWarnings(job.id, 1, libraryId), second = catalog.getJobWarnings(job.id, 2, libraryId)
    assert.equal(first.limit, 20); assert.equal(first.total, 25); assert.equal(first.items.length, 20); assert.equal(second.items.length, 5)
    const all = [...first.items, ...second.items]
    assert.equal(new Set(all).size, 25); assert.ok(all.every(warning => /folder-\d+.*empty\.jpg.*空/.test(warning)))
    assert.deepEqual(catalog.getJobWarnings(job.id, 3, libraryId).items, [])
    assert.throws(() => catalog.getJobWarnings(job.id, 1, randomUUID()), /不属于当前照片库/)
    assert.throws(() => catalog.getJobWarnings(job.id), /不属于当前照片库/)
    assert.throws(() => catalog.getJobWarnings(job.id, 0, libraryId), /页码无效/)
    assert.throws(() => catalog.getJobWarnings(randomUUID(), 1, libraryId), /不存在/)
    assert.equal(catalog.queryMedia({ libraryId }).total, 1)
    await catalog.close(); store.close()
    store = new Store(database); catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
    assert.deepEqual(catalog.getJobWarnings(job.id, 2, libraryId), second)
  } finally { await catalog.close(); store.close() }
})

test('预扫描完整报告关联计划，旧任务只返回实际保留的摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-plan-report-')), source = join(directory, 'source'), data = join(directory, 'data')
  await Promise.all([source, data].map(path => mkdir(path))); await writeFile(join(source, 'empty.mp4'), Buffer.alloc(0)); await sample(join(source, 'valid.jpg'), '#557799')
  const store = new Store(join(data, 'state.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine), rootId = randomUUID()
  store.put('root', { id: rootId, path: source, enabled: true })
  try {
    const plan = catalog.prepareImport(rootId, 'index'); await waitJobs(catalog)
    const ready = (await catalog.familyState()).importPlans!.find(item => item.id === plan.id)!, job = (await catalog.familyState()).jobs[0]
    assert.equal(ready.warningReportId, job.id); assert.equal(job.processed, 1); assert.equal(job.total, 2)
    assert.match(catalog.getJobWarnings(ready.warningReportId!).items[0], /empty\.mp4.*空/)
    const legacy: FamilyJob = { id: randomUUID(), kind: 'scan', state: 'done', processed: 2, total: 30, skipped: 28, label: '旧任务', error: '', warnings: ['旧原因一', '旧原因二'] }
    store.put('familyJob', legacy)
    assert.deepEqual(catalog.getJobWarnings(legacy.id, 1, 'current-library'), { items: legacy.warnings, total: 2, page: 1, limit: 20 })
  } finally { await catalog.close(); store.close() }
})

test('JPEG 常见后缀正常索引，完整文件数与重复内容合并数量区分', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-jpeg-alias-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path)))
  const original = join(library, 'original.jpg'); await sample(original, '#447799')
  await copyFile(original, join(library, 'renamed.jfif')); await copyFile(original, join(library, 'other.jpe'))
  const store = new Store(join(data, 'state.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine), libraryId = randomUUID()
  store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  try {
    assert.equal(mediaKind('upper.JFIF'), 'photo'); assert.equal(mediaKind('alias.jpe'), 'photo')
    catalog.scanMedia(libraryId); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs[0]
    assert.equal(job.state, 'done'); assert.equal(job.processed, 3); assert.equal(job.total, 3); assert.equal(job.duplicates, 2)
    assert.equal(job.sourceFiles, 3); assert.equal(job.uniqueMedia, 1)
    const page = catalog.queryMedia({ libraryId })
    assert.equal(page.total, 1); assert.equal(page.items[0].locations.length, 3)
  } finally { await catalog.close(); store.close() }
})

test('逐项跳过机制仍在来源授权被停用时停止批次，保留已保存媒体', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-import-authorization-')), source = join(directory, 'source'), archive = join(directory, 'archive'), data = join(directory, 'data')
  await Promise.all([source, archive, data].map(path => mkdir(path)))
  const first = join(source, '01-first.jpg'), second = join(source, '02-second.jpg')
  await sample(first, '#773344'); await sample(second, '#33aa77')
  const sourceHashes = await Promise.all([first, second].map(hashFile)), store = new Store(join(data, 'state.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine), rootId = randomUUID(), libraryId = randomUUID()
  const root = { id: rootId, path: source, enabled: true }
  store.put('root', root); store.put('library', { id: libraryId, path: archive, name: '归档', enabled: true })
  try {
    const plan = catalog.prepareImport(rootId, 'copy', libraryId); await waitJobs(catalog)
    const put = store.put.bind(store)
    context.mock.method(store, 'put', (kind: string, value: { id: string }) => {
      put(kind, value)
      const job = value as FamilyJob
      if (kind === 'familyJob' && job.kind === 'import' && job.state === 'running' && job.processed === 1) put('root', { ...root, enabled: false })
    })
    catalog.executeImport(plan.id); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs.find(item => item.kind === 'import')!
    assert.equal(job.state, 'error'); assert.equal(job.processed, 1); assert.match(job.error, /停用/); assert.equal(job.skipped ?? 0, 0)
    const receipts = store.list<Receipt>('file')
    assert.equal(receipts.length, 1); assert.equal((await hashFile(join(archive, receipts[0].relativePath))).hash, receipts[0].hash)
    assert.deepEqual(await Promise.all([first, second].map(hashFile)), sourceHashes)
  } finally { context.mock.restoreAll(); await catalog.close(); store.close() }
})

test('人物分析失败只跳过当前媒体，成功与跳过数量合计为批次总量', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-face-counts-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path)))
  await sample(join(library, '01-first.jpg'), '#883344'); await sample(join(library, '02-failed.jpg'), '#338866'); await sample(join(library, '03-last.jpg'), '#446699')
  const detector = { async ready() { return { ready: true, error: '' } }, async detect(path: string) { if (basename(path) === '02-failed.jpg') throw Object.assign(new Error('synthetic access failure'), { code: 'EACCES' }); return [] } }
  const store = new Store(join(data, 'state.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, detector), libraryId = randomUUID()
  store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  try {
    catalog.scanMedia(libraryId); await waitJobs(catalog); catalog.analyzeFaces(libraryId); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs.find(item => item.kind === 'faces')!
    assert.equal(job.state, 'done'); assert.equal(job.processed, 2); assert.equal(job.skipped, 1); assert.equal(job.total, 3); assert.equal(job.processed + job.skipped!, job.total)
    assert.match(catalog.getJobWarnings(job.id, 1, libraryId).items[0], /02-failed\.jpg.*没有读取或写入权限/)
    assert.equal(catalog.queryMedia({ libraryId, search: 'failed' }).items[0].faceState, 'error')
    assert.equal(catalog.queryMedia({ libraryId, search: 'last' }).items[0].faceState, 'done')
  } finally { await catalog.close(); store.close() }
})

test('人物模型尚未就绪时保留预定总量，未处理照片不会冒充成功或跳过', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-face-unavailable-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path))); await sample(join(library, 'first.jpg'), '#336688'); await sample(join(library, 'second.jpg'), '#775533')
  const detector = { async ready() { return { ready: false, error: '测试模型尚未就绪' } }, async detect() { assert.fail('模型未就绪时不能运行检测') } }
  const store = new Store(join(data, 'state.sqlite')), catalog = new MediaCatalog(store, data, 'receiver', undefined, detector), libraryId = randomUUID()
  store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  try {
    catalog.scanMedia(libraryId); await waitJobs(catalog); catalog.analyzeFaces(libraryId); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs.find(item => item.kind === 'faces')!
    assert.equal(job.state, 'error'); assert.equal(job.processed, 0); assert.equal(job.skipped ?? 0, 0); assert.equal(job.total, 2); assert.match(job.error, /模型尚未就绪/)
    assert.equal((await catalog.familyState(libraryId)).analysis!.pending, 2)
  } finally { await catalog.close(); store.close() }
})

test('扫描先统计完整文件数，有限并发保留重复位置、失败原因与来源原文件', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-estimate-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path)))
  const files = []
  for (let index = 0; index < 6; index++) { const path = join(library, `${index}.jpg`); await sample(path, `rgb(${index * 30},60,100)`); files.push(path) }
  const duplicate = join(library, 'duplicate.jpg'), empty = join(library, 'empty.jpg')
  await copyFile(files[0], duplicate); await writeFile(empty, Buffer.alloc(0)); files.push(duplicate, empty)
  const originals = await Promise.all(files.map(hashFile)), store = new Store(join(data, 'state.sqlite')), libraryId = randomUUID()
  store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  const catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  const phases: FamilyJob[] = [], put = store.put.bind(store)
  context.mock.method(store, 'put', (kind: string, value: { id: string }) => { if (kind === 'familyJob') phases.push(structuredClone(value as FamilyJob)); put(kind, value) })
  const indexFile = (catalog as any).indexFile.bind(catalog)
  let active = 0, maximum = 0
  context.mock.method(catalog as any, 'indexFile', async (...args: any[]) => {
    active++; maximum = Math.max(maximum, active)
    try { await new Promise(resolve => setTimeout(resolve, 15)); return await indexFile(...args) } finally { active-- }
  })
  try {
    catalog.scanMedia(libraryId); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs[0]
    assert.equal(maximum, 2); assert.equal(active, 0)
    assert.equal(phases.find(item => item.scanPhase === 'counting')?.processed, 0)
    const processing = phases.find(item => item.scanPhase === 'processing')!
    assert.equal(processing.scanTotal, 8); assert.equal(processing.processed, 0)
    assert.ok(Date.parse(processing.processingStartedAt!) >= Date.parse(processing.startedAt!))
    assert.equal(job.state, 'done'); assert.equal(job.scanTotal, 8); assert.equal(job.processed, 7); assert.equal(job.skipped, 1); assert.equal(job.duplicates, 1)
    const page = catalog.queryMedia({ libraryId })
    assert.equal(page.total, 6); assert.equal(page.items.find(asset => asset.hash === originals[0].hash)?.locations.length, 2)
    assert.match(catalog.getJobWarnings(job.id, 1, libraryId).items[0], /empty\.jpg.*空/)
    assert.deepEqual(await Promise.all(files.map(hashFile)), originals)
  } finally { await catalog.close(); store.close() }
})

test('无法完整统计目录时不提供预计总量，实际扫描仍保存失败原因', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-unknown-')), store = new Store(join(directory, 'state.sqlite')), libraryId = randomUUID()
  store.put('library', { id: libraryId, path: join(directory, 'unavailable'), name: '离线图库', enabled: true })
  const catalog = new MediaCatalog(store, directory, 'receiver', undefined, engine)
  try {
    catalog.scanMedia(libraryId); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs[0]
    assert.equal(job.scanTotal, undefined); assert.equal(job.processed, 0); assert.equal(job.skipped, 1)
    assert.equal(catalog.getJobWarnings(job.id, 1, libraryId).total, 1, '统计阶段不重复记录同一个失败原因')
  } finally { await catalog.close(); store.close() }
})

test('统计后新增文件导致总量失效，扫描继续保留新增媒体', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-growing-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path))); await sample(join(library, 'first.jpg'), '#446688')
  const store = new Store(join(data, 'state.sqlite')), libraryId = randomUUID(), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  const walk = (catalog as any).walk.bind(catalog)
  context.mock.method(catalog as any, 'walk', async (...args: any[]) => { await walk(...args); if (args[3]?.countOnly) await sample(join(library, 'new.jpg'), '#887744') })
  try {
    catalog.scanMedia(libraryId); await waitJobs(catalog)
    const job = (await catalog.familyState(libraryId)).jobs[0]
    assert.equal(job.state, 'done'); assert.equal(job.processed, 2); assert.equal(job.scanTotal, undefined)
    assert.equal(catalog.queryMedia({ libraryId }).total, 2)
  } finally { await catalog.close(); store.close() }
})

test('关闭并发扫描时等待在途文件完成，停止后不再写入已关闭的索引', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-close-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path)))
  for (let index = 0; index < 4; index++) await sample(join(library, `${index}.jpg`), `rgb(${index * 40},80,120)`)
  const store = new Store(join(data, 'state.sqlite')), libraryId = randomUUID(), catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '图库', enabled: true })
  const indexFile = (catalog as any).indexFile.bind(catalog)
  let release!: () => void, ready!: () => void, active = 0, settled = false, storeClosed = false
  const blocked = new Promise<void>(resolve => { release = resolve }), bothStarted = new Promise<void>(resolve => { ready = resolve })
  context.mock.method(catalog as any, 'indexFile', async (...args: any[]) => {
    active++; if (active === 2) ready()
    try { await blocked; return await indexFile(...args) } finally { active-- }
  })
  try {
    catalog.scanMedia(libraryId); await bothStarted
    const closing = catalog.close().then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false, '关闭需要等待已经开始的两个文件')
    release(); await closing
    assert.equal(active, 0)
    const job = store.list<FamilyJob>('familyJob')[0]
    assert.equal(job.state, 'error'); assert.ok(job.processed < 4)
    store.close(); storeClosed = true
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally { release(); await catalog.close(); if (!storeClosed) store.close() }
})
