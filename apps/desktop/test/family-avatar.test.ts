import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baby as validatedBaby } from '../src/main/family-validation.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import type { BabyDecision, BabyProfile, MediaAsset } from '../src/shared/family.ts'

const mediaId = (number: number): string => number.toString(16).padStart(64, '0') + '-1'
const profile = (): BabyProfile => ({ id: randomUUID(), name: '测试宝宝', birthday: '2024-01-01', autoMatch: false, referenceFaces: [], updatedAt: new Date().toISOString() })

/** 合成索引与独立 SQLite 验证头像记录，不读取或改变个人媒体。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-baby-avatar-')), database = join(directory, 'avatar.sqlite')
  const store = new Store(database), libraryId = randomUUID(), disabledLibraryId = randomUUID(), rootId = randomUUID(), disabledRootId = randomUUID()
  store.put('library', { id: libraryId, path: directory, name: '合成照片库', enabled: true })
  store.put('library', { id: disabledLibraryId, path: directory, name: '未授权照片库', enabled: false })
  store.put('root', { id: rootId, path: directory, enabled: true })
  store.put('root', { id: disabledRootId, path: directory, enabled: false })
  const assets = [
    { number: 1, kind: 'photo', libraryId, available: true },
    { number: 2, kind: 'photo', libraryId, available: true },
    { number: 3, kind: 'video', libraryId, available: true },
    { number: 4, kind: 'photo', libraryId, available: false },
    { number: 5, kind: 'photo', libraryId: disabledLibraryId, available: true },
    { number: 6, kind: 'photo', rootId, available: true },
    { number: 7, kind: 'photo', rootId: disabledRootId, available: true },
  ] as const
  for (const item of assets) {
    const filename = `${item.number}.${item.kind === 'photo' ? 'jpg' : 'mp4'}`
    const asset: MediaAsset = {
      id: mediaId(item.number), hash: item.number.toString(16).padStart(64, '0'), size: 1, filename, kind: item.kind,
      date: '2024-02-01', dateSource: 'capture', dateConfirmed: true, captureDate: '2024-02-01', creationDate: null,
      width: 80, height: 60, duration: 0, available: item.available, babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'pending',
      locations: [{ id: randomUUID(), path: join(directory, filename), source: 'folder', label: '合成位置', available: item.available, ...('libraryId' in item ? { libraryId: item.libraryId } : {}) }],
    }
    store.put('familyAsset', { ...asset, locations: asset.locations.map(location => ({ ...location, ...('rootId' in item ? { rootId: item.rootId } : {}), relativePath: filename, mtime: 0 })), updatedAt: new Date().toISOString() })
  }
  const calls = { ready: 0, detect: 0 }
  const engine = {
    async ready() { calls.ready++; return { ready: true, error: '' } },
    async detect() { calls.detect++; throw new Error('头像编辑不应启动人脸分析。') },
  }
  const catalog = new MediaCatalog(store, directory, 'avatar-test-receiver', undefined, engine)
  return { directory, database, store, catalog, engine, calls, libraryId }
}

test('宝宝头像 IPC 只接受可选记录标识，省略或 undefined 恢复默认头像', () => {
  const source = profile(), avatarAssetId = mediaId(1)
  assert.equal(validatedBaby({ ...source, avatarAssetId }).avatarAssetId, avatarAssetId)
  assert.ok(!Object.hasOwn(validatedBaby(source), 'avatarAssetId'))
  assert.ok(!Object.hasOwn(validatedBaby({ ...source, avatarAssetId: undefined }), 'avatarAssetId'))
  for (const value of ['', null, 1, {}, [], 'C:/Private/photo.jpg', '../photo.jpg', 'data:image/jpeg;base64,abc', 'x'.repeat(81)]) {
    assert.throws(() => validatedBaby({ ...source, avatarAssetId: value }), /记录标识无效/)
  }
  const checked = validatedBaby({ ...source, avatarAssetId, avatarPath: 'C:/Private/photo.jpg', avatarData: 'private-bytes' })
  assert.ok(!Object.hasOwn(checked, 'avatarPath')); assert.ok(!Object.hasOwn(checked, 'avatarData'))
})

test('独立照片头像持久重读，默认头像恢复只更新宝宝记录', async () => {
  const data = await fixture(), source = profile()
  let store = data.store, catalog = data.catalog
  try {
    const assets = store.list('familyAsset')
    catalog.saveBaby({ ...source, avatarAssetId: mediaId(1) })
    assert.equal(store.get<BabyProfile>('familyBaby', source.id)!.avatarAssetId, mediaId(1))
    assert.deepEqual(store.list('familyAsset'), assets)
    await catalog.close(); store.close()
    store = new Store(data.database); catalog = new MediaCatalog(store, data.directory, 'avatar-test-receiver', undefined, data.engine)
    const persisted = (await catalog.familyState()).babies.find(baby => baby.id === source.id)!
    assert.equal(persisted.avatarAssetId, mediaId(1))
    catalog.saveBaby({ ...persisted, avatarAssetId: undefined })
    assert.ok(!Object.hasOwn(store.get<BabyProfile>('familyBaby', source.id)!, 'avatarAssetId'))
    assert.deepEqual(store.list('familyAsset'), assets)
    assert.equal(data.calls.detect, 0)
  } finally { await catalog.close(); store.close() }
})

test('新头像拒绝视频、无授权与不可用位置，已有离线头像仍能编辑档案', async () => {
  const { store, catalog, libraryId } = await fixture(), source = profile()
  try {
    catalog.saveBaby({ ...source, avatarAssetId: mediaId(1) })
    const saved = store.get<BabyProfile>('familyBaby', source.id)!
    assert.throws(() => catalog.saveBaby({ ...saved, avatarAssetId: mediaId(3) }), /只能使用照片/)
    for (const id of [mediaId(4), mediaId(5), mediaId(7)]) assert.throws(() => catalog.saveBaby({ ...saved, avatarAssetId: id }), /不可用或未授权/)
    assert.throws(() => catalog.saveBaby({ ...saved, avatarAssetId: mediaId(8) }), /项目不存在/)
    assert.throws(() => catalog.saveBaby({ ...saved, avatarAssetId: '../photo.jpg' }), /媒体标识无效/)
    assert.deepEqual(store.get<BabyProfile>('familyBaby', source.id), saved, '拒绝的选择不能覆盖原头像或档案')
    const rootBaby = profile()
    catalog.saveBaby({ ...rootBaby, avatarAssetId: mediaId(6) })
    assert.equal(store.get<BabyProfile>('familyBaby', rootBaby.id)!.avatarAssetId, mediaId(6), '启用的授权来源位置同样可用')
    store.put('library', { id: libraryId, path: 'unavailable-test-volume', name: '离线照片库', enabled: false })
    catalog.saveBaby({ ...saved, name: '改名后宝宝', birthday: '2023-02-02' })
    assert.equal(store.get<BabyProfile>('familyBaby', source.id)!.avatarAssetId, mediaId(1))
    assert.equal(store.get<BabyProfile>('familyBaby', source.id)!.name, '改名后宝宝')
    assert.throws(() => catalog.saveBaby({ ...saved, avatarAssetId: mediaId(2) }), /不可用或未授权/)
    catalog.saveBaby({ ...saved, avatarAssetId: undefined })
    assert.ok(!Object.hasOwn(store.get<BabyProfile>('familyBaby', source.id)!, 'avatarAssetId'))
  } finally { await catalog.close(); store.close() }
})

test('保存头像、昵称和出生日期保持参考与相册决定，不启动自动分析', async () => {
  const { store, catalog, calls, libraryId } = await fixture(), source = { ...profile(), autoMatch: true, referenceFaces: [{ assetId: mediaId(1), faceId: 'avatar-reference-face' }] }
  try {
    store.put('familyFace', { id: 'avatar-reference-face', assetId: mediaId(1), x: 0.1, y: 0.1, width: 0.3, height: 0.3, score: 0.95, embedding: [1, 0] })
    store.put('familyBaby', source)
    const decisions: BabyDecision[] = [
      { id: `${source.id}:${mediaId(1)}`, babyId: source.id, assetId: mediaId(1), state: 'included', origin: 'manual', updatedAt: '2026-01-01T00:00:00Z' },
      { id: `${source.id}:${mediaId(2)}`, babyId: source.id, assetId: mediaId(2), state: 'candidate', origin: 'recognition', score: 0.58, updatedAt: '2026-01-01T00:00:00Z' },
    ]
    for (const decision of decisions) store.put('familyDecision', decision)
    await catalog.familyState()
    store.put('workspace', { id: 'current-library', libraryId })
    const originalAssets = store.list('familyAsset'), originalFaces = store.list('familyFace'), originalJobs = store.list('familyJob')
    catalog.saveBaby({ ...source, avatarAssetId: mediaId(2) })
    const withAvatar = store.get<BabyProfile>('familyBaby', source.id)!
    catalog.saveBaby({ ...withAvatar, name: '新的宝宝昵称', birthday: '2023-02-02' })
    catalog.saveBaby({ ...store.get<BabyProfile>('familyBaby', source.id)!, avatarAssetId: undefined })
    assert.deepEqual(store.get<BabyProfile>('familyBaby', source.id)!.referenceFaces, source.referenceFaces)
    assert.deepEqual(store.list('familyDecision'), decisions, '头像与档案显示修改不能重算识别候选或改变人工归属')
    assert.deepEqual(store.list('familyAsset'), originalAssets)
    assert.deepEqual(store.list('familyFace'), originalFaces)
    assert.deepEqual(store.list('familyJob'), originalJobs, '模型已就绪、当前库有待分析内容也不因头像编辑创建任务')
    assert.equal(calls.detect, 0)
  } finally { await catalog.close(); store.close() }
})

test('同步保留桌面本地头像，拒绝跨端覆盖并只输出共享档案白名单', async () => {
  const { store, catalog } = await fixture(), source = profile(), incomingId = randomUUID()
  try {
    catalog.saveBaby({ ...source, avatarAssetId: mediaId(1) })
    const existing = store.get<BabyProfile>('familyBaby', source.id)!, time = new Date(Date.now() + 1000).toISOString()
    const result = catalog.sync({ babies: [{ ...existing, name: '手机改名', avatarAssetId: mediaId(2), updatedAt: time }, { ...profile(), id: incomingId, avatarAssetId: mediaId(2), updatedAt: time }], decisions: [] })
    const retained = store.get<BabyProfile>('familyBaby', source.id)!
    assert.equal(retained.name, '手机改名')
    assert.equal(retained.avatarAssetId, mediaId(1), '手机新档案只更新共享字段，桌面头像保持原选择')
    assert.ok(!Object.hasOwn(store.get<BabyProfile>('familyBaby', incomingId)!, 'avatarAssetId'), '新同步档案不接受手机注入的桌面头像')
    assert.deepEqual(retained.referenceFaces, existing.referenceFaces)
    for (const baby of result.babies) {
      assert.deepEqual(Object.keys(baby).sort(), ['id', 'name', 'birthday', 'autoMatch', 'referenceFaces', 'updatedAt'].sort())
      assert.ok(!Object.hasOwn(baby, 'avatarAssetId'))
      assert.deepEqual(baby.referenceFaces, [])
    }
    assert.equal(store.list('familyJob').length, 0)
  } finally { await catalog.close(); store.close() }
})
