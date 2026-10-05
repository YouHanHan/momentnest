import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/service/store.ts'

interface Metadata { id: string; score: number; detail?: { label: string }; embedding?: unknown }
const face = (id: string, embedding: unknown = [1, 0]) => ({ id, score: 0.95, detail: { label: '合成人脸' }, embedding })

/** 所有缓存回归使用独立合成数据库，避免改动用户索引。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-face-metadata-')), path = join(directory, 'synthetic.sqlite')
  return { path, store: new Store(path) }
}

test('检测新增、更新和移除人脸只更新对应缓存，任务进度不重复校验整库向量', async () => {
  const { store } = await fixture()
  let reads = 0
  const prepare = store.db.prepare.bind(store.db)
  store.db.prepare = source => { if (source.includes('json_remove') && source.includes("kind='familyFace'")) reads++; return prepare(source) }
  try {
    store.put('familyFace', face('b'))
    assert.equal(store.listFaceMetadata<Metadata>(true)[0].embeddingValid, true)
    assert.equal(reads, 1)
    store.put('familyFace', face('a'))
    store.put('familyFace', face('b', [0, 0]))
    store.put('familyJob', { id: 'synthetic-job', processed: 2, total: 10000 })
    assert.deepEqual(store.listFaceMetadata<Metadata>(true).map(value => [value.id, value.embeddingValid]), [['a', true], ['b', false]])
    store.remove('familyFace', 'a')
    assert.deepEqual(store.listFaceMetadata<Metadata>(true).map(value => value.id), ['b'])
    assert.equal(reads, 1, '整理过程逐项保存后仍不得重新读取全部人脸')
  } finally { store.close() }
})

test('人脸元数据不暴露向量，返回对象的修改不能污染后续查询', async () => {
  const { store } = await fixture()
  try {
    store.put('familyFace', face('synthetic'))
    const first = store.listFaceMetadata<Metadata>(true)[0]
    assert.equal('embedding' in first, false)
    first.score = 0; first.detail!.label = '外部修改'
    const second = store.listFaceMetadata<Metadata>(true)[0]
    assert.equal(second.score, 0.95); assert.equal(second.detail!.label, '合成人脸')
    assert.equal(second.embeddingValid, true)
    assert.equal(store.listFaceMetadata<Metadata>()[0].embeddingValid, false)
  } finally { store.close() }
})

test('缓存新增向量与原数据库有效性检查一致，拒绝空值、零向量及非有限值', async () => {
  const { store } = await fixture()
  try {
    store.listFaceMetadata(true)
    const examples = [[1, 0], [], [0, 0], [NaN, 1], [Infinity, 1], [null, 1], ['1', 0], [true, 0], null, {}]
    store.transaction(() => examples.forEach((embedding, index) => store.put('familyFace', face(String(index), embedding))))
    const incremental = store.listFaceMetadata<Metadata>(true)
    assert.deepEqual(incremental.map(value => value.embeddingValid), [true, false, false, false, false, false, false, false, false, false])
    // 绕过 Store 的无内容变更使查询重新按数据库规则计算，再比对完整投影。
    store.db.prepare("UPDATE records SET value=value WHERE kind='familyFace'").run()
    assert.deepEqual(store.listFaceMetadata<Metadata>(true), incremental)
  } finally { store.close() }
})

test('另一连接提交和本连接直接写入后，查询返回最新的人脸与有效性', async () => {
  const { store, path } = await fixture(), external = new DatabaseSync(path)
  try {
    store.put('familyFace', face('synthetic'))
    assert.equal(store.listFaceMetadata<Metadata>(true)[0].embeddingValid, true)
    external.prepare("UPDATE records SET value=? WHERE kind='familyFace' AND id=?").run(JSON.stringify(face('synthetic', [0, 0])), 'synthetic')
    // 外部提交后再保存本机进度，也不能掩盖已经变化的数据库版本。
    store.put('familyJob', { id: 'synthetic-job', processed: 3 })
    assert.equal(store.listFaceMetadata<Metadata>(true)[0].embeddingValid, false)
    store.db.prepare("UPDATE records SET value=? WHERE kind='familyFace' AND id=?").run(JSON.stringify(face('synthetic', [1, 0])), 'synthetic')
    store.put('familyJob', { id: 'synthetic-job', processed: 4 })
    assert.equal(store.listFaceMetadata<Metadata>(true)[0].embeddingValid, true)
  } finally { external.close(); store.close() }
})

test('事务中可见最新人脸，回滚后不会保留新增、删除或失效向量的缓存', async () => {
  const { store } = await fixture()
  try {
    store.put('familyFace', face('original'))
    store.put('familyFace', face('retained'))
    const initial = store.listFaceMetadata<Metadata>(true)
    assert.throws(() => store.transaction(() => {
      store.put('familyFace', face('original', [0, 0]))
      store.put('familyFace', face('added'))
      store.remove('familyFace', 'retained')
      assert.deepEqual(store.listFaceMetadata<Metadata>(true).map(value => [value.id, value.embeddingValid]), [['added', true], ['original', false]])
      throw new Error('合成事务回滚')
    }), /合成事务回滚/)
    assert.deepEqual(store.listFaceMetadata<Metadata>(true), initial)
  } finally { store.close() }
})
