import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebuildPersonGroups } from '../src/service/person-index-rebuild.ts'
import type { PersonRebuildInput, PersonRebuildProgress, RebuildAsset, RebuildBabyReference, RebuildFace, RebuildPerson } from '../src/service/person-index-rebuild.ts'

const vector = (degrees: number): number[] => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]
const person = (id: string, angle = 0, extra: Partial<RebuildPerson> = {}): RebuildPerson => ({ id, name: '', embedding: vector(angle), ...extra })
const face = (id: string, angle = 0, extra: Partial<RebuildFace> = {}): RebuildFace => ({ id, assetId: id, x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: 0.95, embedding: vector(angle), ...extra })
const input = (faces: RebuildFace[], people: RebuildPerson[] = [], assets?: RebuildAsset[]): PersonRebuildInput => ({ faces, people, assets: assets ?? [...new Set(faces.map(item => item.assetId))].map(id => ({ id, kind: 'photo' })) })
const rootCount = (people: RebuildPerson[]): number => people.filter(item => !item.mergedIntoId).length

/** 深冻结合成输入，验证维护算法不修改原对象或数组。 */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

test('迟到桥接样本在回访中恢复弱相似人脸，不再为灰区建立重复人物', async () => {
  const source = input([
    face('anchor', 0, { score: 0.99 }), face('late', 65, { score: 0.98 }),
    face('bridge', 40, { score: 0.97 }), face('ordinary', 30, { score: 0.96 })
  ])
  const snapshot = structuredClone(source), result = await rebuildPersonGroups(freeze(source))
  assert.deepEqual(source, snapshot)
  assert.equal(rootCount(result.people), 1)
  assert.equal(new Set(result.faces.map(item => item.personId)).size, 1)
  assert.equal(result.summary.assignedFaces, 4)
  assert.equal(result.summary.recoveredFaces, 1)
  assert.equal(result.summary.revisitPasses, 1)
  assert.equal(result.summary.ambiguousFaces, 0)
  assert.deepEqual(result.people[0].embedding, vector(0))
})

test('仅有最低支持而缺少强证据的灰区保持待归组，回访不创建新人', async () => {
  const result = await rebuildPersonGroups(input([face('anchor', 0, { score: 0.99 }), face('gray', 65, { score: 0.98 })]))
  assert.equal(rootCount(result.people), 1)
  assert.equal(result.summary.newGroups, 1)
  assert.equal(result.summary.ambiguousFaces, 1)
  assert.equal(result.summary.revisitPasses, 1)
  assert.ok(!result.faces[1].personId)
})

test('同照片和视频同帧不同脸互斥，视频不同帧继续复用人物', async () => {
  for (const kind of ['photo', 'video'] as const) {
    const result = await rebuildPersonGroups(input([
      face('first', 0, { assetId: 'one', score: 0.99, frameTime: 1 }),
      face('second', 0, { assetId: 'one', score: 0.98, frameTime: kind === 'photo' ? 2 : 1 })
    ], [], [{ id: 'one', kind }]))
    assert.equal(rootCount(result.people), 2)
    assert.notEqual(result.faces[0].personId, result.faces[1].personId)
    assert.equal(result.summary.conflictedFaces, 1)
  }
  const result = await rebuildPersonGroups(input([
    face('earlier', 0, { assetId: 'video', frameTime: 1 }), face('later', 15, { assetId: 'video', frameTime: 2 })
  ], [], [{ id: 'video', kind: 'video' }]))
  assert.equal(rootCount(result.people), 1)
})

test('用户明确选择的多年龄宝宝参考提供可信锚点，自动样本不升级', async () => {
  const source = input([
    face('young-reference', 0, { score: 0.99 }), face('older-reference', 85, { score: 0.98 }),
    face('older-photo', 100, { score: 0.97 }), face('unsupported', 155, { score: 0.96 })
  ])
  const babies: RebuildBabyReference[] = [{ id: 'baby', referenceFaces: [{ assetId: 'young-reference', faceId: 'young-reference' }, { assetId: 'older-reference', faceId: 'older-reference' }] }]
  const result = await rebuildPersonGroups({ ...source, babies })
  const referenceRoot = result.faces[0].personId
  assert.equal(result.faces[1].personId, referenceRoot)
  assert.equal(result.faces[2].personId, referenceRoot)
  assert.ok(!result.faces[3].personId, '弱相似场景仍留待归组')
  assert.equal(result.summary.referenceFaces, 2)
  assert.equal(result.summary.manualFaces, 2)
  assert.equal(rootCount(result.people), 1)
  assert.ok(result.people.every(item => item.name === ''))
  const alias = result.people.find(item => item.mergedIntoId === referenceRoot)
  assert.equal(alias?.mergeOrigin, 'manual')
  assert.deepEqual(alias?.embedding, vector(85))
  const repeated = await rebuildPersonGroups({ faces: result.faces, people: result.people, assets: source.assets, babies })
  assert.deepEqual(repeated.people, result.people, '重复引用已保存的人工锚点不能产生额外别名')
  assert.deepEqual(repeated.faces, result.faces)
})

test('宝宝参考优先沿用唯一命名人物，保留名字且不合并两个已有人工根', async () => {
  const source = input([face('named-reference', 0, { personId: 'known' }), face('other-reference', 85), face('age-photo', 100)], [person('known', 0, { name: '用户自定名字' })])
  const babies: RebuildBabyReference[] = [{ id: 'baby', referenceFaces: [{ assetId: 'named-reference', faceId: 'named-reference' }, { assetId: 'other-reference', faceId: 'other-reference' }] }]
  const result = await rebuildPersonGroups({ ...source, babies })
  assert.equal(result.people.find(item => item.id === 'known')?.name, '用户自定名字')
  assert.ok(result.faces.every(item => item.personId === 'known'))
  const conflicting = input([face('left-reference', 0, { personId: 'left' }), face('right-reference', 0, { personId: 'right' })], [person('left', 0, { name: '左' }), person('right', 0, { name: '右' })])
  await assert.rejects(rebuildPersonGroups({ ...conflicting, babies: [{ id: 'baby', referenceFaces: conflicting.faces.map(item => ({ assetId: item.assetId, faceId: item.id })) }] }), /多个已有人工/)
})

test('跨宝宝共用参考和同图不同脸的强标签矛盾必须停止', async () => {
  const source = input([face('one'), face('two', 85, { assetId: 'one' })])
  const shared = { assetId: 'one', faceId: 'one' }
  await assert.rejects(rebuildPersonGroups({ ...source, babies: [{ id: 'a', referenceFaces: [shared] }, { id: 'b', referenceFaces: [shared] }] }), /两个宝宝同时/)
  await assert.rejects(rebuildPersonGroups({ ...source, babies: [{ id: 'a', referenceFaces: [shared, { assetId: 'one', faceId: 'two' }] }] }), /同图或同帧/)
  await assert.rejects(rebuildPersonGroups({ ...source, babies: [{ id: 'a', referenceFaces: [{ assetId: 'wrong', faceId: 'one' }] }] }), /未对应有效/)
})

test('补检、低分、非法向量和非法框保留缓存，不作为自动身份样本', async () => {
  const source = input([
    face('review', 0, { reviewRequired: true }), face('low', 0, { score: 0.49 }), face('invalid-vector', 0, { embedding: [0, 0] }),
    face('bad-box', 0, { width: 2 }), face('valid', 0)
  ])
  const snapshot = structuredClone(source), result = await rebuildPersonGroups(freeze(source))
  assert.deepEqual(source, snapshot)
  assert.equal(result.summary.reviewRequiredFaces, 1)
  assert.equal(result.summary.lowScoreFaces, 1)
  assert.equal(result.summary.invalidVectors, 1)
  assert.equal(result.summary.invalidFaces, 2)
  assert.equal(result.summary.assignedFaces, 1)
  for (let index = 0; index < 4; index++) assert.deepEqual(result.faces[index], source.faces[index])
})

test('命名人物及人工别名保留，未获得新向量的空锚点不参与匹配', async () => {
  const people = [person('root', 0, { name: '已命名' }), person('manual', 90, { mergedIntoId: 'root', mergeOrigin: 'manual' }), person('empty', 0, { name: '无可用新脸', embedding: [] })]
  const source = input([face('known', 105, { personId: 'manual' }), face('next', 130), face('review', 0, { personId: 'root', reviewRequired: true, embedding: [0, 0] })], people)
  const result = await rebuildPersonGroups(source)
  for (const original of people) assert.deepEqual(result.people.find(item => item.id === original.id), original)
  assert.equal(result.faces[0].personId, 'manual')
  assert.equal(result.faces[1].personId, 'root')
  assert.equal(result.faces[2].personId, 'root')
  assert.equal(result.summary.protectedGroups, 2)
  assert.equal(result.summary.preservedFaces, 2)
})

test('失效的人工根和别名锚点仅从已还原人工身份的新检测人脸恢复', async () => {
  const source = input([
    face('fresh-root', 0, { personId: 'root', score: 0.99 }),
    face('fresh-alias', 85, { personId: 'manual', score: 0.98 }), face('next-age', 100, { score: 0.97 })
  ], [person('root', 0, { name: '用户姓名', embedding: [] }), person('manual', 0, { embedding: [], mergedIntoId: 'root', mergeOrigin: 'manual' })])
  const snapshot = structuredClone(source), result = await rebuildPersonGroups(freeze(source))
  assert.deepEqual(source, snapshot)
  assert.equal(result.faces[2].personId, 'root')
  assert.deepEqual(result.people.find(item => item.id === 'root')?.embedding, vector(0))
  assert.deepEqual(result.people.find(item => item.id === 'manual')?.embedding, vector(85))
  const aliasOnly = await rebuildPersonGroups(input([face('fresh-alias', 85, { personId: 'manual' }), face('incoming', 95)], source.people as RebuildPerson[]))
  assert.deepEqual(aliasOnly.people.find(item => item.id === 'root')?.embedding, vector(85))
  assert.equal(aliasOnly.faces[1].personId, 'root')
})

test('范围外的人脸记录及人物链完全保留，目标库自动旧组可以被重建', async () => {
  const source = input([
    face('external', 0, { personId: 'old-auto-alias' }), face('external-review', 0, { reviewRequired: true }),
    face('target', 20, { personId: 'old-target' }), face('new-target', 170)
  ], [person('old-external', 0), person('old-auto-alias', 0, { mergedIntoId: 'old-external', mergeOrigin: 'automatic' }), person('old-target', 90)])
  const snapshot = structuredClone(source), result = await rebuildPersonGroups({ ...freeze(source), editableAssetIds: ['target', 'new-target'] })
  assert.deepEqual(source, snapshot)
  assert.deepEqual(result.faces[0], source.faces[0])
  assert.deepEqual(result.faces[1], source.faces[1])
  assert.deepEqual(result.people.find(item => item.id === 'old-auto-alias'), source.people[1])
  assert.deepEqual(result.people.find(item => item.id === 'old-external'), source.people[0])
  assert.equal(result.faces[2].personId, 'old-external')
  assert.equal(result.people.some(item => item.id === 'old-target'), false)
  assert.equal(result.summary.externalGroups, 1)
})

test('范围外依赖的空人工根与别名不可被新锚点覆写，宝宝参考单独保存新可信别名', async () => {
  const people = [person('external-root', 0, { name: '外部人工名字', embedding: [] }), person('external-alias', 0, { embedding: [], mergedIntoId: 'external-root', mergeOrigin: 'manual' })]
  const source = input([
    face('outside', 0, { personId: 'external-alias' }),
    face('fresh-restored', 0, { personId: 'external-root', score: 0.99 }), face('older-reference', 85, { score: 0.98 }), face('older-photo', 100)
  ], people)
  const scope = ['fresh-restored', 'older-reference', 'older-photo']
  const first = await rebuildPersonGroups({ ...source, editableAssetIds: scope })
  for (const original of people) assert.deepEqual(first.people.find(item => item.id === original.id), original)
  assert.deepEqual(first.faces[0], source.faces[0])
  const babies: RebuildBabyReference[] = [{ id: 'baby', referenceFaces: [{ assetId: 'fresh-restored', faceId: 'fresh-restored' }, { assetId: 'older-reference', faceId: 'older-reference' }] }]
  const result = await rebuildPersonGroups({ ...freeze(source), editableAssetIds: scope, babies })
  for (const original of people) assert.deepEqual(result.people.find(item => item.id === original.id), original)
  assert.deepEqual(result.faces[0], source.faces[0])
  assert.equal(result.faces[3].personId, 'external-root')
  const aliases = result.people.filter(item => !people.some(original => original.id === item.id) && item.mergeOrigin === 'manual')
  assert.equal(aliases.length, 2, '空的既有锚点需要为每张新参考单独保留可信别名')
  assert.ok(aliases.every(item => item.mergedIntoId === 'external-root'))
})

test('循环、悬空、重复和矛盾的人物别名拒绝重建', async () => {
  const cases = [
    [person('a', 0, { mergedIntoId: 'b' }), person('b', 0, { mergedIntoId: 'a' })],
    [person('a', 0, { mergedIntoId: 'missing' })], [person('same'), person('same')],
    [person('root'), person('alias', 0, { name: '命名', mergedIntoId: 'root', mergeOrigin: 'automatic' })],
    [person('manual', 0, { mergedIntoId: 'automatic', mergeOrigin: 'manual' }), person('automatic', 0, { mergedIntoId: 'root', mergeOrigin: 'automatic' }), person('root')]
  ]
  for (const people of cases) await assert.rejects(rebuildPersonGroups(input([], freeze(people))), /重建已停止/)
  await assert.rejects(rebuildPersonGroups(input([face('unknown', 0, { personId: 'missing' })])), /所属人物不存在/)
})

test('输入遍历次序和重复调用不影响稳定人物 ID，合成数据不访问图库', async () => {
  const source = input([face('z', 0), face('a', 15), face('different', 145)], [person('old')])
  const first = await rebuildPersonGroups(freeze(source)), second = await rebuildPersonGroups(source)
  const reversed = await rebuildPersonGroups({ ...source, faces: [...source.faces].reverse(), people: [...source.people].reverse(), assets: [...source.assets].reverse() })
  assert.deepEqual(first, second)
  assert.deepEqual(first.people, reversed.people)
  assert.deepEqual(first.faces.map(item => [item.id, item.personId]).sort(), reversed.faces.map(item => [item.id, item.personId]).sort())
  const repeated = await rebuildPersonGroups({ faces: first.faces, people: first.people, assets: source.assets })
  assert.deepEqual(first.people, repeated.people)
})

test('大批量 512 维合成数据提供有界进度并让出事件循环', async () => {
  const faces = Array.from({ length: 1024 }, (_, index) => {
    const embedding = Array<number>(512).fill(0)
    embedding[index % 16] = 1
    return face(`face-${String(index).padStart(4, '0')}`, 0, { embedding })
  })
  const progress: PersonRebuildProgress[] = []
  let yielded = false
  const timer = setTimeout(() => { yielded = true }, 0)
  const result = await rebuildPersonGroups(input(faces), item => { progress.push(item) })
  clearTimeout(timer)
  assert.equal(yielded, true)
  assert.equal(rootCount(result.people), 16)
  assert.equal(result.summary.assignedFaces, 1024)
  assert.equal(result.summary.ambiguousFaces, 0)
  assert.deepEqual(progress.filter(item => item.phase === 'initial').map(item => item.processed), [128, 256, 384, 512, 640, 768, 896, 1024, 1024])
  assert.equal(progress.at(-1)?.phase, 'complete')
  assert.ok(progress.every(item => item.assignedFaces >= 0 && item.ungroupedFaces >= 0 && item.processed <= item.total))
})
