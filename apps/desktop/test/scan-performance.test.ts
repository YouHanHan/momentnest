import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { hashFile } from '../src/service/files.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { thumbnail } from '../src/service/media-tools.ts'
import { Store } from '../src/service/store.ts'
import type { FamilyJob } from '../src/shared/family.ts'

/** 等待索引和识别实际完成，避免状态查询触发额外自动任务。 */
async function waitJobs(store: Store): Promise<void> {
  for (let index = 0; index < 600; index++) {
    if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('独立性能回归任务未完成。')
}

test('大于读块的合成文件仍使用全部字节计算指纹，并保留文件身份校验', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-hash-block-')), path = join(directory, 'synthetic.bin')
  const bytes = Buffer.alloc(1024 * 1024 + 17)
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + (index >>> 16)) & 255
  await writeFile(path, bytes)
  const result = await hashFile(path)
  assert.equal(result.hash, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(result.size, bytes.length)
  await assert.rejects(hashFile(directory), /不是普通文件/)
})

test('未变化的媒体重扫不改写资产，保持相同大小和修改时间的内容变化仍重新索引', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-rescan-write-')), data = join(directory, 'data'), library = join(directory, 'photos'), libraryId = randomUUID()
  await Promise.all([data, library].map(path => mkdir(path)))
  const image = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#557799' } }).withExif({ IFD2: { DateTimeOriginal: '2024:08:12 10:20:00' } }).jpeg().toBuffer()
  const bytes = Buffer.concat([image, Buffer.from([7, 9])]), path = join(library, 'synthetic.jpg'), modifiedAt = new Date('2024-08-13T00:00:00Z')
  await writeFile(path, bytes); await utimes(path, modifiedAt, modifiedAt)
  const store = new Store(join(data, 'state.sqlite')), engine = { async ready() { return { ready: true, error: '' } }, async detect() { return [] } }
  const catalog = new MediaCatalog(store, data, 'synthetic', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '合成重扫库', enabled: true })
  try {
    catalog.scanMedia(libraryId); await waitJobs(store)
    const first = catalog.queryMedia({ libraryId }).items[0], record = store.get('familyAsset', first.id), revision = store.browseRevision
    catalog.scanMedia(libraryId); await waitJobs(store)
    assert.deepEqual(store.get('familyAsset', first.id), record, '重复扫描应保留未变化资产的记录与更新时间')
    assert.equal(store.browseRevision, revision, '任务进度不能让未变化媒体的浏览缓存失效')
    bytes[bytes.length - 1] = 10
    await writeFile(path, bytes); await utimes(path, modifiedAt, modifiedAt)
    catalog.scanMedia(libraryId); await waitJobs(store)
    const page = catalog.queryMedia({ libraryId }), changed = page.items.find(asset => asset.id !== first.id)!
    assert.equal(page.total, 2); assert.ok(changed)
    assert.ok(page.items.find(asset => asset.id === first.id)!.locations.every(location => !location.available), '原内容记录保留，但已变化的位置不能冒充原文件')
    assert.equal(changed.hash, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(changed.size, first.size); assert.equal(changed.locations[0].mtime, first.locations[0].mtime)
    assert.deepEqual(await readFile(path), bytes)
  } finally { await catalog.close(); store.close() }
})

test('扫描先完成完整索引，可视照片按需生成相同缩略图，重复扫描保留日期收藏和人脸缓存', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-lazy-')), data = join(directory, 'data'), library = join(directory, 'photos'), libraryId = randomUUID()
  await Promise.all([data, library].map(path => mkdir(path)))
  const bytes = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#7799aa' } }).withExif({ IFD2: { DateTimeOriginal: '2024:08:12 10:20:00' } }).jpeg().toBuffer()
  const original = join(library, 'first.jpg'), duplicate = join(library, 'duplicate.jpg')
  await writeFile(original, bytes); await writeFile(duplicate, bytes)
  const store = new Store(join(data, 'state.sqlite'))
  let detections = 0
  const engine = { async ready() { return { ready: true, error: '' } }, async detect() { detections++; return [{ id: 'face-0', x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: 0.95, embedding: [1, 0] }] } }
  const catalog = new MediaCatalog(store, data, 'synthetic', undefined, engine)
  store.put('library', { id: libraryId, path: library, name: '合成测试库', enabled: true })
  try {
    catalog.scanMedia(libraryId); await waitJobs(store)
    const page = catalog.queryMedia({ libraryId }), asset = page.items[0]
    assert.equal(page.total, 1); assert.equal(asset.locations.length, 2)
    assert.equal(asset.date, '2024-08-12'); assert.equal(asset.dateSource, 'capture')
    assert.equal(store.get<{ thumbnailPath?: string }>('familyAsset', asset.id)!.thumbnailPath, undefined, '索引完成不能等待未展示照片的缩略图')
    assert.equal(detections, 0)
    const scan = store.list<FamilyJob>('familyJob').find(job => job.kind === 'scan')!
    assert.equal(scan.processed, 2); assert.equal(scan.duplicates, 1); assert.equal(scan.uniqueMedia, 1)
    const pending = catalog.mediaPath(asset.id, true, libraryId), concurrent = catalog.mediaPath(asset.id, true, libraryId)
    catalog.setFavorite(asset.id, true); catalog.setMediaDate(asset.id, '2024-08-10')
    const output = await pending, expected = join(directory, 'expected.jpg')
    assert.equal(await concurrent, output)
    const duringRead = catalog.queryMedia({ libraryId }).items[0]
    assert.equal(duringRead.favorite, true, '缩略图完成不能覆盖读取期间修改的收藏')
    assert.equal(duringRead.date, '2024-08-10', '缩略图完成不能覆盖读取期间确认的日期')
    await thumbnail(original, 'photo', expected)
    assert.deepEqual(await readFile(output), await readFile(expected))
    assert.equal(await catalog.mediaPath(asset.id, true, libraryId), output)
    catalog.setFavorite(asset.id, true)
    catalog.analyzeFaces(libraryId); await waitJobs(store)
    const faces = store.list('familyFace'), people = store.list('familyPerson')
    assert.equal(detections, 1)
    catalog.setMediaDate(asset.id, '2024-08-10')
    catalog.scanMedia(libraryId); await waitJobs(store)
    catalog.analyzeFaces(libraryId); await waitJobs(store)
    const after = catalog.queryMedia({ libraryId }).items[0]
    assert.equal(after.favorite, true); assert.equal(after.date, '2024-08-10'); assert.equal(after.dateSource, 'manual')
    assert.equal(after.locations.length, 2); assert.equal(after.faceState, 'done')
    assert.equal(detections, 1)
    assert.deepEqual(store.list('familyFace'), faces); assert.deepEqual(store.list('familyPerson'), people)
    assert.deepEqual(await readFile(original), bytes); assert.deepEqual(await readFile(duplicate), bytes)
    assert.deepEqual(await readFile(output), await readFile(expected))
  } finally { await catalog.close(); store.close() }
})
