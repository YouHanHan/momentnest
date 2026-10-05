import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'

// 验证一万条合成索引的浏览路径，不访问个人媒体或运行真实识别。
async function fixture(count: number, ready = async () => ({ ready: true, error: '' })) {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-initial-load-'))
  const store = new Store(join(directory, 'state.sqlite'))
  store.put('library', { id: 'library', name: '合成图库', path: directory, enabled: true })
  store.transaction(() => {
    for (let index = 0; index < count; index++) {
      const hash = index.toString(16).padStart(64, '0'), id = `${hash}-1024`
      store.put('familyAsset', { id, hash, size: 1024, filename: `${index}.jpg`, kind: 'photo', date: '2024-01-01', dateSource: 'capture', dateConfirmed: true, faces: [], favorite: false, faceState: 'done', locations: [{ id: `location-${index}`, libraryId: 'library', path: join(directory, `${index}.jpg`), relativePath: `${index}.jpg`, available: true, source: 'folder', mtime: 1 }] })
    }
  })
  const catalog = new MediaCatalog(store, directory, 'receiver', undefined, { ready, async detect() { assert.fail('浏览不能运行人脸检测') } })
  return { store, catalog }
}

test('人脸模型仍在初始化时立即返回已有图库，后续状态反映就绪且只初始化一次', async () => {
  let release!: (status: { ready: boolean; error: string }) => void, calls = 0
  const pending = new Promise<{ ready: boolean; error: string }>(resolve => { release = resolve })
  const { store, catalog } = await fixture(100, () => { calls++; return pending })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const state = await Promise.race([catalog.familyState('library'), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('图库状态被模型加载阻塞')), 1000) })])
    clearTimeout(timer)
    assert.equal(state.photoCount, 100); assert.equal(state.modelReady, false)
    assert.equal(catalog.queryMedia({ libraryId: 'library' }).total, 100)
    release({ ready: true, error: '' })
    assert.equal((await catalog.familyState('library')).modelReady, true)
    assert.equal(calls, 1)
  } finally { clearTimeout(timer); release({ ready: false, error: '测试结束' }); await catalog.close(); store.close() }
})

test('一万项同条件分页复用整库筛选排序，查询返回独立对象且日期及授权变更使缓存失效', async context => {
  const { store, catalog } = await fixture(10000)
  const original = (catalog as any).decorationContext.bind(catalog)
  let projections = 0
  context.mock.method(catalog as any, 'decorationContext', (...args: unknown[]) => { projections++; return original(...args) })
  try {
    const query = { libraryId: 'library', limit: 50, order: 'desc' as const }
    const started = performance.now(), first = catalog.queryMedia(query), firstMilliseconds = performance.now() - started
    const second = catalog.queryMedia({ ...query, page: 2 })
    assert.equal(first.total, 10000); assert.equal(second.items.length, 50)
    assert.equal(projections, 1)
    assert.equal(new Set([...first.items, ...second.items].map(asset => asset.id)).size, 100)
    first.items[0].filename = '界面修改不得污染缓存'
    assert.notEqual(catalog.queryMedia(query).items[0].filename, first.items[0].filename)
    const warm = performance.now()
    for (let page = 3; page <= 22; page++) assert.equal(catalog.queryMedia({ ...query, page }).items.length, 50)
    context.diagnostic(`合成 10000 项：首批 ${firstMilliseconds.toFixed(1)} ms，后续 20 页 ${(performance.now() - warm).toFixed(1)} ms`)
    assert.equal(projections, 1)
    catalog.setMediaDate(second.items[0].id, '2025-01-01')
    assert.equal(catalog.queryMedia(query).items[0].id, second.items[0].id)
    assert.equal(projections, 2)
    store.put('library', { id: 'library', name: '合成图库', path: '', enabled: false })
    assert.ok(catalog.queryMedia(query).items.every(asset => !asset.available))
    assert.equal(projections, 3)
  } finally { context.mock.restoreAll(); await catalog.close(); store.close() }
})
