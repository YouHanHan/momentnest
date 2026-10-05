import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// 直接使用生产 SQL 核对真实 SQLite 的 Unicode 分段语义。
const source = readFileSync(new URL('../lib/local_store.dart', import.meta.url), 'utf8')
const sql = source.match(/'(SELECT substr\(value, \?, \?\) AS value FROM preferences WHERE key=\?)'/)?.[1]
const size = source.match(/const chunkCharacters = (\d+) \* (\d+);/)
assert.ok(sql && size, '没有找到生产分段查询')
const chunkCharacters = Number(size[1]) * Number(size[2])
const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
const save = db.prepare('INSERT OR REPLACE INTO preferences (key,value) VALUES (?,?)')
const query = db.prepare(sql)
let maxReturnedBytes = 0
const samples = [
  { filename: '宝宝👶.jpg', text: 'a'.repeat(3 * 1024 * 1024) },
  '宝宝👶'.repeat(50000),
  '👶'.repeat(chunkCharacters + 9),
  'a'.repeat(chunkCharacters - 2),
  [], false, null,
]
for (const sample of samples) {
  const original = JSON.stringify(sample)
  save.run('fixture', original)
  db.exec('BEGIN')
  let restored = ''
  for (let offset = 1; ; offset += chunkCharacters) {
    const { value } = query.get(offset, chunkCharacters, 'fixture')
    maxReturnedBytes = Math.max(maxReturnedBytes, Buffer.byteLength(value, 'utf8'))
    restored += value
    if ([...value].length < chunkCharacters) break
  }
  db.exec('COMMIT')
  assert.equal(restored, original)
  assert.deepEqual(JSON.parse(restored), sample)
  assert.equal(db.prepare('SELECT value FROM preferences WHERE key=?').get('fixture').value, original)
}
assert.equal(query.get(1, chunkCharacters, 'missing'), undefined)
assert.ok(maxReturnedBytes <= 256 * 1024)
db.close()
console.log(JSON.stringify({ passed: samples.length + 1, maxReturnedBytes }))
