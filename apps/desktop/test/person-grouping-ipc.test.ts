import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { groupingIds, id, matchScope, optionalMatchScope, query } from '../src/main/family-validation.ts'

test('未分组人脸筛选只接受布尔值，与指定人物的筛选互斥', () => {
  const ungrouped = { libraryId: 'library-one', ungroupedFaces: true, page: 1, limit: 50, kind: 'photo', order: 'desc' }
  assert.deepEqual(query(ungrouped), ungrouped)
  assert.deepEqual(query({ ungroupedFaces: false, personId: 'person-one' }), { ungroupedFaces: false, personId: 'person-one' })
  assert.deepEqual(query({}), {})
  for (const value of ['true', 'false', 1, 0, null, {}, [], NaN]) assert.throws(() => query({ ungroupedFaces: value }), /开关参数无效/)
  assert.throws(() => query({ ungroupedFaces: true, personId: 'person-one' }))
  assert.throws(() => query({ libraryId: '../../outside', ungroupedFaces: true }), /记录标识无效/)
})

test('整理标识拒绝路径和完整方案对象，查询投影不会透传识别特征', () => {
  assert.equal(id('grouping-plan-one'), 'grouping-plan-one')
  assert.equal(id('library-one'), 'library-one')
  for (const value of ['', 'a'.repeat(81), '../outside', 'C:/Private', 'C:\\Private', 'plan\u0000one', null, undefined, true, 1, [], { id: 'plan-one', merges: [] }]) assert.throws(() => id(value), /记录标识无效/)
  const result = query({ libraryId: 'library-one', ungroupedFaces: true, embedding: [1, 0], trustedEmbeddings: [[1, 0]], merges: [{ sourceId: 'untrusted', targetId: 'person-one' }], path: '../outside' })
  assert.deepEqual(result, { libraryId: 'library-one', ungroupedFaces: true })
  assert.equal(JSON.stringify(result).includes('embedding'), false)
})

test('人物整理预加载能力仅传标识，主进程校验后交由对应工作线程方法', () => {
  // 静态核对真实接线；Node 测试不导入 Electron 主进程，也不构造替代 IPC 实现。
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('../src/service/worker.ts', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../src/shared/desktop-api.ts', import.meta.url), 'utf8')
  assert.match(preload, /preparePersonGrouping:\s*\(?(\w+)\)?\s*=>\s*ipcRenderer\.invoke\('family:prepare-person-grouping',\s*\1\)/)
  assert.match(preload, /applyPersonGrouping:\s*\((\w+)\s*,\s*(\w+)\s*,\s*(\w+)\)\s*=>\s*ipcRenderer\.invoke\('family:apply-person-grouping',\s*\1\s*,\s*\2\s*,\s*\3\)/)
  assert.match(main, /handle\('family:prepare-person-grouping',\s*\(?(\w+)\)?\s*=>\s*receiver!\.call(?:<[^>]+>)?\('preparePersonGrouping',\s*identifier\(\1\)\)\)/)
  assert.match(main, /handle\('family:apply-person-grouping',\s*\((\w+)\s*,\s*(\w+)\s*,\s*(\w+)\)\s*=>\s*receiver!\.call(?:<[^>]+>)?\('applyPersonGrouping',\s*identifier\(\1\)\s*,\s*identifier\(\2\)\s*,\s*familyValidation\.groupingIds\(\3\)\)\)/)
  assert.match(worker, /case 'preparePersonGrouping':\s*return receiver\.family\.preparePersonGrouping\(String\(a\[0\]\)\)/)
  assert.match(worker, /case 'applyPersonGrouping':\s*return receiver\.family\.applyPersonGrouping\(String\(a\[0\]\),\s*String\(a\[1\]\),a\[2\] as string\[\]\|undefined\)/)
  assert.match(api, /preparePersonGrouping\(libraryId:\s*string\):\s*Promise<PersonGroupingPreview>/)
  assert.match(api, /applyPersonGrouping\(planId:\s*string,\s*libraryId:\s*string,\s*sourceIds\?:\s*string\[\]\):\s*Promise<number>/)
  assert.match(preload, /undoPersonGrouping:.*'family:undo-person-grouping'/)
  assert.match(main, /'family:undo-person-grouping'.*identifier\(token\),identifier\(libraryId\)/)
  assert.match(worker, /case 'undoPersonGrouping':.*String\(a\[0\]\),String\(a\[1\]\)/)
})

test('逐项整理仅接收预览来源标识，宝宝查找范围必须明确且相互一致', () => {
  assert.equal(groupingIds(undefined), undefined); assert.deepEqual(groupingIds([]), [])
  assert.deepEqual(groupingIds(['source-one', 'source-one', 'source-two']), ['source-one', 'source-two'])
  for (const value of [null, true, {}, [{ sourceId: 'source-one' }], ['../outside'], Array(10001).fill('source-one')]) assert.throws(() => groupingIds(value))
  assert.equal(matchScope(undefined, 'library-one'), 'library'); assert.equal(matchScope(undefined, undefined), 'all')
  assert.equal(matchScope('all', undefined), 'all'); assert.equal(matchScope('library', 'library-one'), 'library')
  assert.deepEqual(query({ babyId: 'baby-one', scope: 'all' }), { babyId: 'baby-one', scope: 'all' })
  assert.deepEqual(query({ babyId: 'baby-one', scope: 'library', libraryId: 'library-one' }), { babyId: 'baby-one', scope: 'library', libraryId: 'library-one' })
  assert.throws(() => query({ scope: 'all' }), /宝宝标识/)
  assert.throws(() => query({ babyId: 'baby-one', scope: 'all', libraryId: 'library-one' }), /全部授权目录/)
  assert.equal(optionalMatchScope(undefined), undefined); assert.equal(optionalMatchScope('all'), 'all'); assert.equal(optionalMatchScope('library'), 'library')
  for (const value of [null, true, {}, [], 'cloud', '../all']) assert.throws(() => optionalMatchScope(value))
  for (const [scope, libraryId] of [['all', 'library-one'], ['library', undefined], ['cloud', undefined], [null, undefined], ['library', '../outside']]) assert.throws(() => matchScope(scope, libraryId))
})

test('公开整理方案只使用人物展示数据，类型中不开放本地特征和缓存路径', () => {
  const shared = readFileSync(new URL('../src/shared/family.ts', import.meta.url), 'utf8')
  for (const name of ['PersonGroupingPreview', 'PersonProfile', 'MediaFace']) {
    const body = shared.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1]
    assert.ok(body, `必须存在公开类型 ${name}`)
    assert.doesNotMatch(body, /\b(?:embedding|trustedEmbeddings|samples|thumbnailPath|faceFrames)\b/)
  }
  assert.match(shared, /source:\s*PersonProfile;\s*target:\s*PersonProfile;\s*similarity:\s*number/)
})
