import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { hashFile } from '../src/service/files.ts'
import type { Receipt } from '../src/service/types.ts'

const engine = { async ready() { return { ready: false, error: '合成测试不运行识别' } }, async detect() { return [] } }

async function until(ready: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000
  while (!await ready()) {
    if (Date.now() > deadline) throw new Error('合成扫描未在时限内完成。')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitScan(catalog: MediaCatalog): Promise<void> {
  await until(async () => !(await catalog.familyState()).jobs.some(job => job.state === 'running'))
  assert.equal((await catalog.familyState()).jobs.find(job => job.kind === 'scan')?.state, 'done')
}

for (const duplicate of [false, true]) {
  test(`目录枚举后收到${duplicate ? '同内容副本' : '新照片'}，扫描收尾保留已验证上传位置`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'momentnest-upload-scan-'))
    const data = join(directory, 'state'), library = join(directory, 'library')
    await Promise.all([data, library].map(path => mkdir(path)))
    const first = join(library, 'first.jpg'), uploaded = join(library, 'uploaded.jpg')
    await sharp({ create: { width: 32, height: 24, channels: 3, background: 'blue' } }).jpeg().toFile(first)
    const firstIdentity = await hashFile(first), store = new Store(join(data, 'receiver.sqlite')), libraryId = randomUUID()
    store.put('library', { id: libraryId, path: library, name: '合成接收库', enabled: true })
    let gated = false, entered = false, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const catalog = new MediaCatalog(store, data, 'test-receiver', undefined, engine, async (key, action) => {
      if (gated && key === `catalog:${firstIdentity.hash}:${firstIdentity.size}`) {
        entered = true
        await gate
      }
      return action()
    })
    try {
      catalog.scanMedia(libraryId)
      await waitScan(catalog)
      gated = true
      catalog.scanMedia(libraryId)
      await until(() => entered)
      await sharp({ create: { width: 32, height: 24, channels: 3, background: duplicate ? 'blue' : 'red' } }).jpeg().toFile(uploaded)
      const identity = await hashFile(uploaded)
      const receipt: Receipt = { id: randomUUID(), receiverId: 'test-receiver', libraryId, hash: identity.hash, size: identity.size, relativePath: 'uploaded.jpg', filename: '手机原图.jpg', savedAt: new Date().toISOString(), source: 'phone', kind: 'photo' }
      store.put('file', receipt)
      catalog.recordReceipt(receipt)
      await until(() => catalog.queryMedia({ libraryId }).items.some(asset => asset.locations.some(location => location.receiptId === receipt.id)))
      release()
      await waitScan(catalog)
      const asset = catalog.queryMedia({ libraryId }).items.find(item => item.id === `${identity.hash}-${identity.size}`)!
      assert.equal(asset.locations.find(location => location.receiptId === receipt.id)?.available, true)
      assert.equal(asset.available, true)
      assert.equal(catalog.queryMedia({ libraryId }).total, duplicate ? 1 : 2)
      assert.deepEqual(await readFile(await catalog.mediaPath(asset.id, false, libraryId)), await readFile(uploaded))
    } finally { release(); await catalog.close(); store.close() }
  })
}

test('扫描仍能标记扫描前存在但现已移出的旧位置，不删除原文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-scan-missing-'))
  const data = join(directory, 'state'), library = join(directory, 'library')
  await Promise.all([data, library].map(path => mkdir(path)))
  const photo = join(library, 'original.jpg'), preserved = join(directory, 'preserved.jpg')
  await sharp({ create: { width: 32, height: 24, channels: 3, background: 'green' } }).jpeg().toFile(photo)
  const original = await readFile(photo), store = new Store(join(data, 'receiver.sqlite')), libraryId = randomUUID()
  store.put('library', { id: libraryId, path: library, name: '合成接收库', enabled: true })
  const catalog = new MediaCatalog(store, data, 'test-receiver', undefined, engine)
  try {
    catalog.scanMedia(libraryId)
    await waitScan(catalog)
    assert.equal(catalog.queryMedia({ libraryId }).items[0].available, true)
    await rename(photo, preserved)
    catalog.scanMedia(libraryId)
    await waitScan(catalog)
    assert.equal(catalog.queryMedia({ libraryId }).items[0].available, false)
    assert.deepEqual(await readFile(preserved), original)
  } finally { await catalog.close(); store.close() }
})

for (const changed of [false, true]) {
  test(`旧手机位置误标不可用时${changed ? '内容不符不能恢复' : '完整校验后恢复显示'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'momentnest-recheck-upload-'))
    const data = join(directory, 'state'), library = join(directory, 'library')
    await Promise.all([data, library].map(path => mkdir(path)))
    const photo = join(library, 'original.jpg'), libraryId = randomUUID()
    await sharp({ create: { width: 32, height: 24, channels: 3, background: 'blue' } }).jpeg().toFile(photo)
    const original = await readFile(photo), identity = await hashFile(photo), assetId = `${identity.hash}-${identity.size}`
    const store = new Store(join(data, 'receiver.sqlite'))
    store.put('library', { id: libraryId, path: library, name: '合成接收库', enabled: true })
    let catalog = new MediaCatalog(store, data, 'test-receiver', undefined, engine)
    try {
      const receipt: Receipt = { id: randomUUID(), receiverId: 'test-receiver', libraryId, hash: identity.hash, size: identity.size, relativePath: 'original.jpg', filename: '手机原图.jpg', savedAt: new Date().toISOString(), source: 'phone', kind: 'photo' }
      store.put('file', receipt)
      catalog.recordReceipt(receipt)
      await until(() => catalog.queryMedia({ libraryId }).total === 1)
      await catalog.close()
      const stored = store.get<any>('familyAsset', assetId)!
      store.put('familyAsset', { ...stored, locations: stored.locations.map((location: any) => ({ ...location, available: false })) })
      catalog = new MediaCatalog(store, data, 'test-receiver', undefined, engine)
      assert.equal(catalog.queryMedia({ libraryId }).items[0].available, false)
      if (changed) {
        const altered = Buffer.from('合成文件内容变化')
        await writeFile(photo, altered)
        await assert.rejects(catalog.mediaPath(assetId, false, libraryId))
        assert.equal(store.get<any>('familyAsset', assetId)!.locations[0].unavailableReason, 'changed')
        assert.deepEqual(await readFile(photo), altered)
      } else {
        const thumbnail = await catalog.mediaPath(assetId, true, libraryId)
        assert.ok((await readFile(thumbnail)).length > 0)
        assert.equal(catalog.queryMedia({ libraryId }).items[0].available, true)
        assert.deepEqual(await readFile(await catalog.mediaPath(assetId, false, libraryId)), original)
      }
      assert.deepEqual(store.get('file', receipt.id), receipt)
    } finally { await catalog.close(); store.close() }
  })
}
