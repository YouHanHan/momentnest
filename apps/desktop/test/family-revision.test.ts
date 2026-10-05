import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import { hashFile } from '../src/service/files.ts'
import { mediaContentHash } from '../src/service/media-content.ts'
import { readMetadata } from '../src/service/media-tools.ts'
import type { BabyProfile } from '../src/shared/family.ts'

const detector = { async ready() { return { ready: true, error: '' } }, async detect() { return [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.99, embedding: [1, 0] }] } }

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-revision-')), library = join(directory, 'library'), data = join(directory, 'data')
  await Promise.all([library, data].map(path => mkdir(path)))
  const store = new Store(join(data, 'state.sqlite')), libraryId = randomUUID(), catalog = new MediaCatalog(store, data, 'receiver', undefined, detector)
  store.put('library', { id: libraryId, path: library, name: '测试图库', enabled: true })
  return { directory, library, data, store, libraryId, catalog }
}

async function wait(catalog: MediaCatalog) {
  for (let index = 0; index < 600; index++) {
    if (!(await catalog.familyState()).jobs.some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('测试任务未完成。')
}

async function sample(path: string, color = '#884466') {
  await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toFile(path)
}

/** 插入真实 EXIF 段而不重编码 JPEG，验证日期编辑而非图像替换。 */
async function editExif(path: string, orientation = 1) {
  const helper = path + '.exif.bak'
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).withExif({ IFD2: { DateTimeOriginal: '2024:07:24 12:00:00' } }).withMetadata({ orientation }).jpeg().toFile(helper)
  const data = await readFile(helper)
  let offset = 2, exif: Buffer | undefined
  while (offset < data.length && data[offset + 1] !== 0xda) {
    const length = data.readUInt16BE(offset + 2)
    if (data[offset + 1] === 0xe1 && data.subarray(offset + 4, offset + 10).equals(Buffer.from('Exif\0\0'))) { exif = data.subarray(offset, offset + length + 2); break }
    offset += length + 2
  }
  assert.ok(exif)
  const original = await readFile(path)
  await writeFile(path, Buffer.concat([original.subarray(0, 2), exif, original.subarray(2)]))
}

async function reference(catalog: MediaCatalog, libraryId: string) {
  catalog.analyzeFaces(libraryId); await wait(catalog)
  const asset = catalog.queryMedia({ libraryId }).items[0]
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [], updatedAt: new Date().toISOString() }
  catalog.saveBaby(baby); catalog.setBabyMembership(baby.id, [asset.id], true); catalog.setBabyReference(baby.id, asset.id, asset.faces[0].id)
  catalog.setFavorite(asset.id, true)
  return { asset, baby }
}

test('仅补日期自动恢复收藏、人工宝宝归属和原参考人脸，完整指纹仍使用新内容', async () => {
  const { library, store, libraryId, catalog } = await setup(), path = join(library, 'photo.jpg')
  try {
    await sample(path); catalog.scanMedia(libraryId); await wait(catalog)
    const { asset: old, baby } = await reference(catalog, libraryId), original = await readFile(path)
    await editExif(path)
    assert.notEqual((await hashFile(path)).hash, old.hash)
    catalog.scanMedia(libraryId); await wait(catalog)
    const page = catalog.queryMedia({ libraryId }), current = page.items[0]
    assert.equal(page.total, 1); assert.notEqual(current.id, old.id); assert.equal(current.available, true)
    assert.equal(current.hash, (await hashFile(path)).hash); assert.equal(current.date, '2024-07-24'); assert.equal(current.dateSource, 'capture')
    assert.equal(current.favorite, true); assert.equal(current.babyDecisions![0].origin, 'manual'); assert.equal(current.babyDecisions![0].state, 'included')
    assert.equal(current.faces[0].id, old.faces[0].id); assert.equal(current.faces[0].personId, old.faces[0].personId)
    assert.deepEqual(store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces, [{ assetId: current.id, faceId: old.faces[0].id }])
    assert.equal(store.get<any>('familyAsset', old.id).supersededById, current.id)
    assert.deepEqual((await sharp(original).raw().toBuffer()), (await sharp(path).raw().toBuffer()))
    const stored = store.get<any>('familyAsset', current.id)
    catalog.scanMedia(libraryId); await wait(catalog)
    assert.deepEqual(store.get('familyAsset', current.id), stored, '重复扫描不能反复迁移或重写业务记录')
    assert.equal(await catalog.mediaPath(current.id, false, libraryId), path)
  } finally { await catalog.close(); store.close() }
})

test('只改修改时间或恢复在线时完整校验相同字节，不标记丢失或新建媒体', async () => {
  const { library, store, libraryId, catalog } = await setup(), path = join(library, 'photo.jpg')
  try {
    await sample(path); catalog.scanMedia(libraryId); await wait(catalog)
    const old = catalog.queryMedia({ libraryId }).items[0], original = await readFile(path), info = await stat(path)
    await utimes(path, info.atime, new Date(info.mtimeMs + 5000))
    assert.equal(await catalog.mediaPath(old.id, false, libraryId), path)
    assert.equal(catalog.queryMedia({ libraryId }).total, 1); assert.equal(catalog.queryMedia({ libraryId }).items[0].available, true)
    const stored = store.get<any>('familyAsset', old.id); stored.locations[0].available = false; store.put('familyAsset', stored)
    await catalog.close()
    const reopened = new MediaCatalog(store, (catalog as any).dataDirectory, 'receiver', undefined, detector)
    try { assert.equal(await reopened.mediaPath(old.id, false, libraryId), path); assert.equal(reopened.queryMedia({ libraryId }).items[0].available, true) } finally { await reopened.close() }
    assert.deepEqual(await readFile(path), original)
  } finally { await catalog.close(); store.close() }
})

test('打开照片发现元数据变化时局部恢复索引，旧指纹不能返回新文件字节', async () => {
  const { library, store, libraryId, catalog } = await setup(), path = join(library, 'photo.jpg')
  try {
    await sample(path); catalog.scanMedia(libraryId); await wait(catalog)
    const old = catalog.queryMedia({ libraryId }).items[0]
    await editExif(path)
    await assert.rejects(catalog.mediaPath(old.id, false, libraryId), /信息已更新/)
    const current = catalog.queryMedia({ libraryId }).items[0]
    assert.equal(catalog.queryMedia({ libraryId }).total, 1); assert.equal(current.date, '2024-07-24')
    assert.equal(await catalog.mediaPath(current.id, false, libraryId), path)
  } finally { await catalog.close(); store.close() }
})

test('多次补日期与还原原字节复用完整指纹历史，不产生循环失效卡片', async () => {
  const { library, store, libraryId, catalog } = await setup(), path = join(library, 'photo.jpg')
  try {
    await sample(path); const original = await readFile(path)
    catalog.scanMedia(libraryId); await wait(catalog)
    const { asset: old, baby } = await reference(catalog, libraryId)
    await editExif(path); const edited = await readFile(path)
    for (const content of [edited, original, edited, original]) {
      await writeFile(path, content); catalog.scanMedia(libraryId); await wait(catalog)
      const page = catalog.queryMedia({ libraryId }), current = page.items[0]
      assert.equal(page.total, 1); assert.equal(current.available, true); assert.equal(current.favorite, true)
      const reference = store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces[0]
      assert.equal(reference.assetId, current.id); assert.equal(reference.faceId, old.faces[0].id)
    }
  } finally { await catalog.close(); store.close() }
})

test('真实像素替换与方向变化不迁移旧参考，不把同名同尺寸当作原图', async () => {
  for (const change of ['pixels', 'orientation']) {
    const { library, store, libraryId, catalog } = await setup(), path = join(library, 'photo.jpg')
    try {
      await sample(path); catalog.scanMedia(libraryId); await wait(catalog)
      const { asset: old, baby } = await reference(catalog, libraryId)
      if (change === 'pixels') await sample(path, '#1188aa'); else await editExif(path, 6)
      catalog.scanMedia(libraryId); await wait(catalog)
      const items = catalog.queryMedia({ libraryId }).items, current = items.find(asset => asset.id !== old.id)!, previous = items.find(asset => asset.id === old.id)!
      assert.equal(items.length, 2); assert.equal(current.favorite, false); assert.equal(current.faces.length, 0)
      assert.equal(previous.available, false); assert.equal(previous.locations[0].unavailableReason, 'changed')
      assert.deepEqual(store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces, [{ assetId: old.id, faceId: old.faces[0].id }])
      assert.equal(store.get<any>('familyAsset', old.id).supersededById, undefined)
    } finally { await catalog.close(); store.close() }
  }
})

test('旧版没有内容签名时恢复校验过的备份，假备份不允许迁移', async () => {
  for (const trustworthy of [true, false]) {
    const { library, data, store, libraryId, catalog } = await setup(), path = join(library, 'photo.jpg')
    let reopened: MediaCatalog | undefined
    try {
      await sample(path); catalog.scanMedia(libraryId); await wait(catalog)
      const { asset: old, baby } = await reference(catalog, libraryId)
      const backupDirectory = join(library, '.date-metadata-backup'); await mkdir(backupDirectory)
      const backup = join(backupDirectory, `photo.jpg.${old.hash.slice(0, 12)}.bak`)
      if (trustworthy) await copyFile(path, backup); else await sample(backup, '#0099ff')
      const legacy = store.get<any>('familyAsset', old.id); delete legacy.contentSignature; store.put('familyAsset', legacy)
      await editExif(path); await catalog.close()
      reopened = new MediaCatalog(store, data, 'receiver', undefined, detector)
      reopened.scanMedia(libraryId); await wait(reopened)
      const page = reopened.queryMedia({ libraryId }), current = page.items.find(asset => asset.id !== old.id)!
      assert.equal(page.total, trustworthy ? 1 : 2)
      assert.equal(current.favorite, trustworthy)
      assert.equal(store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces[0].assetId, trustworthy ? current.id : old.id)
      assert.ok(await stat(backup), '恢复只读备份，不删除或修改媒体')
    } finally { await reopened?.close(); await catalog.close(); store.close() }
  }
})

test('旧原始副本仍可用时保留独立完整指纹、参考和上传回执', async () => {
  const { library, store, libraryId, catalog } = await setup(), first = join(library, 'first.jpg'), duplicate = join(library, 'duplicate.jpg')
  try {
    await sample(first); await copyFile(first, duplicate); catalog.scanMedia(libraryId); await wait(catalog)
    const { asset: old, baby } = await reference(catalog, libraryId)
    const receipt = { id: randomUUID(), libraryId, relativePath: 'first.jpg', filename: 'first.jpg', hash: old.hash, size: old.size, source: 'phone', savedAt: new Date().toISOString() }
    store.put('file', receipt)
    await editExif(first); catalog.scanMedia(libraryId); await wait(catalog)
    const items = catalog.queryMedia({ libraryId }).items, previous = items.find(asset => asset.id === old.id)!, current = items.find(asset => asset.id !== old.id)!
    assert.equal(items.length, 2); assert.equal(previous.available, true); assert.equal(current.favorite, true)
    assert.equal(store.get<any>('familyAsset', old.id).supersededById, undefined)
    assert.equal(store.get<BabyProfile>('familyBaby', baby.id)!.referenceFaces[0].assetId, old.id)
    assert.deepEqual(store.get('file', receipt.id), receipt); assert.equal(current.locations[0].receiptId, undefined)
    assert.equal((await hashFile(duplicate)).hash, old.hash)
  } finally { await catalog.close(); store.close() }
})

test('手动确认日期优先于新 EXIF，已有新记录的人工排除不能被旧自动判断覆盖', async () => {
  const { library, data, store, libraryId, catalog } = await setup(), path = join(library, 'photo.jpg')
  let reopened: MediaCatalog | undefined
  try {
    await sample(path); catalog.scanMedia(libraryId); await wait(catalog)
    const { asset: old, baby } = await reference(catalog, libraryId)
    catalog.setMediaDate(old.id, '2024-07-20')
    await editExif(path)
    const identity = await hashFile(path), id = `${identity.hash}-${identity.size}`, metadata = await readMetadata(path, 'photo')
    store.put('familyAsset', { ...store.get<any>('familyAsset', old.id), ...metadata, id, hash: identity.hash, size: identity.size, locations: [], favorite: false, faceState: 'pending', dateConfirmed: true })
    store.put('familyDecision', { id: `${baby.id}:${id}`, babyId: baby.id, assetId: id, origin: 'manual', state: 'excluded', updatedAt: '9999-01-01T00:00:00Z' })
    await catalog.close(); reopened = new MediaCatalog(store, data, 'receiver', undefined, detector)
    reopened.scanMedia(libraryId); await wait(reopened)
    const current = reopened.queryMedia({ libraryId }).items[0]
    assert.equal(current.date, '2024-07-20'); assert.equal(current.dateSource, 'manual')
    assert.equal(current.babyDecisions![0].state, 'excluded'); assert.equal(current.babyDecisions![0].origin, 'manual')
  } finally { await reopened?.close(); await catalog.close(); store.close() }
})

test('JPG 后缀的 WEBP 按真实结构读拍摄日期，日期段不改变内容签名', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-webp-date-')), path = join(directory, 'photo.jpg')
  await sharp({ create: { width: 32, height: 24, channels: 3, background: '#884466' } }).withExif({ IFD2: { DateTimeOriginal: '2024:07:24 12:00:00' } }).webp().toFile(path)
  const metadata = await readMetadata(path, 'photo')
  assert.equal(metadata.captureDate, '2024-07-24'); assert.equal(metadata.dateSource, 'capture'); assert.equal(metadata.width, 32)
  assert.ok(await mediaContentHash(path, 'photo'))
  await writeFile(path, Buffer.from('RIFF\xff\xff\xff\xffWEBP'))
  assert.equal(await mediaContentHash(path, 'photo'), undefined, '截断容器不能作为身份依据')
})

test('视频只改 QuickTime 创建时间复用原参考，媒体字节变化使签名失效', async () => {
  const { library, store, libraryId, catalog } = await setup(), path = join(library, 'video.mp4')
  try {
    await new Promise<void>((resolve, reject) => execFile(ffmpegPath!, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=1', '-c:v', 'libx264', path], { windowsHide: true }, error => error ? reject(error) : resolve()))
    catalog.scanMedia(libraryId); await wait(catalog)
    const old = catalog.queryMedia({ libraryId }).items[0], signature = await mediaContentHash(path, 'video'), original = await readFile(path), changed = Buffer.from(original)
    const offset = changed.indexOf(Buffer.from('mvhd')) + 4
    assert.ok(offset > 4); assert.equal(changed[offset], 0)
    changed.writeUInt32BE(Math.floor(Date.parse('2024-07-24T12:00:00Z') / 1000) + 2082844800, offset + 4)
    await writeFile(path, changed)
    assert.equal(await mediaContentHash(path, 'video'), signature)
    catalog.setFavorite(old.id, true); catalog.scanMedia(libraryId); await wait(catalog)
    const current = catalog.queryMedia({ libraryId }).items[0]
    assert.equal(catalog.queryMedia({ libraryId }).total, 1); assert.equal(current.favorite, true); assert.equal(current.date, '2024-07-24')
    const payload = changed.indexOf(Buffer.from('mdat')) + 4; assert.ok(payload > 4); changed[payload] ^= 1
    await writeFile(path, changed)
    assert.notEqual(await mediaContentHash(path, 'video'), signature)
  } finally { await catalog.close(); store.close() }
})
