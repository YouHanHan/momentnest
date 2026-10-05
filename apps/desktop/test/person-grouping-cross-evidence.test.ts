import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPersonMerges } from '../src/service/person-grouping-plan.ts'
import type { RepairPersonGroup } from '../src/service/person-grouping-plan.ts'

const vector = (degrees: number): number[] => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]
const similarity = (left: number[], right: number[]): number => left.reduce((sum, value, index) => sum + value * right[index], 0)

/** 只构造合成身份与独立媒体，不读取模型、真实图库或数据库。 */
function group(id: string, angle: number, samples: number[], options: Partial<RepairPersonGroup> = {}): RepairPersonGroup {
  return {
    id, name: '', embedding: vector(angle),
    samples: samples.map((pose, index) => ({ id: `${id}-face-${index}`, assetId: `${id}-photo-${index}`, embedding: vector(pose) })),
    frames: new Set(samples.map((_, index) => `${id}-photo-${index}:photo`)), assetCount: samples.length,
    ...options,
  }
}

test('迟到桥接照片以双方多照片证据连接 0 度与 65 度的旧碎组', async () => {
  const first = group('first', 0, [0, 0]), later = group('later', 65, [65, 40, 30])
  assert.ok(similarity(first.embedding, later.embedding) < 0.65)
  const plan = await planPersonMerges([first, later], similarity)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'first', targetId: 'later' }])
  assert.ok(plan.merges[0].similarity >= 0.65)
  assert.equal(plan.ambiguous, 0); assert.equal(plan.conflicts, 0)
})

test('全部原锚点的支持低于 0.363 时，相同跨组照片也不能合并', async () => {
  const first = group('first', 0, [0, 0, 0]), weak = group('weak', Math.acos(0.1) * 180 / Math.PI, [0, 0])
  assert.ok(similarity(first.embedding, weak.embedding) < 0.363)
  const plan = await planPersonMerges([first, weak], similarity)
  assert.deepEqual(plan.merges, [])
})

test('多照片支持需同时覆盖双方至少两项媒体，重复视频帧不能补足', async () => {
  for (const repeatSource of [true, false]) {
    const source = group('source', 0, [0, 0]), target = group('target', 65, [40, 30, 65])
    const repeated = repeatSource ? source : target
    repeated.samples = repeated.samples.map((face, index) => ({ ...face, assetId: 'one-video', frameTime: index }))
    repeated.frames = new Set(repeated.samples.map(face => `one-video:${face.frameTime}`))
    const plan = await planPersonMerges([source, target], similarity)
    assert.deepEqual(plan.merges, [], repeatSource ? '来源重复帧不增加独立媒体数' : '目标重复帧不增加独立媒体数')
  }
})

test('只在一项目标媒体获得支持时不算双向复现', async () => {
  const source = group('source', 0, [0, 0]), target = group('target', 65, [40, 110, 115])
  const plan = await planPersonMerges([source, target], similarity)
  assert.deepEqual(plan.merges, [], '两项来源媒体命中同一目标，仍只提供一项目标支持')
})

test('同照片或同视频帧始终否决多照片补充证据', async () => {
  for (const frame of ['shared:photo', 'shared-video:2']) {
    const source = group('source', 0, [0, 0]), target = group('target', 65, [40, 30, 65])
    source.frames.add(frame); target.frames.add(frame)
    const plan = await planPersonMerges([source, target], similarity)
    assert.deepEqual(plan.merges, []); assert.equal(plan.conflicts, 1)
  }
})

test('合入组的全部帧继续阻止同一方案中的间接共现合并', async () => {
  const root = group('root', 0, [0, 0, 0, 0]), bridge = group('bridge', 65, [65, 40, 30]), last = group('last', 0, [0, 0])
  bridge.frames.add('shared:photo'); last.frames.add('shared:photo')
  const plan = await planPersonMerges([root, bridge, last], similarity)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'bridge', targetId: 'root' }])
  assert.equal(plan.conflicts, 1)
})

test('命名与人工保护根保持独立，自动碎组可成为其多照片提案来源', async () => {
  const named = group('named', 0, [0, 0], { name: '合成命名人物' }), manual = group('manual', 65, [40, 30, 65], { protected: true })
  assert.deepEqual((await planPersonMerges([named, manual], similarity)).merges, [])
  const automatic = group('automatic', 65, [40, 30, 65])
  const plan = await planPersonMerges([automatic, named], similarity)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'automatic', targetId: 'named' }])
})

test('跨照片支持均达到 0.5 但最强证据不到 0.65 时保留', async () => {
  const pose = Math.acos(0.6) * 180 / Math.PI
  const root = group('root', 0, [0, 0, 0]), source = group('source', 65, [pose, pose])
  assert.ok(similarity(root.samples[0].embedding, source.samples[0].embedding) >= 0.5)
  const plan = await planPersonMerges([root, source], similarity)
  assert.deepEqual(plan.merges, [])
})

test('两个多照片候选的最强证据差距不足时来源保持歧义', async () => {
  const left = group('left', 0, [0, 0], { name: '合成左目标' }), right = group('right', 5, [5, 5], { name: '合成右目标' })
  const source = group('source', 65, [40, 30])
  const plan = await planPersonMerges([left, right, source], similarity)
  assert.deepEqual(plan.merges, []); assert.equal(plan.ambiguous, 1)
})

test('多次整理继续保留全部自动原锚点，后续强样本不能绕过早期来源', async () => {
  const root = group('root', 0, [0, 0, 0, 0]), prior = group('prior', 65, [65, 40, 30])
  const first = await planPersonMerges([root, prior], similarity)
  assert.equal(first.merges.length, 1)
  const component = { ...root, anchors: [prior.embedding], samples: [...root.samples, ...prior.samples], frames: new Set([...root.frames, ...prior.frames]), assetCount: 7 }
  const drift = group('drift', -30, [0, 0])
  assert.ok(similarity(root.embedding, drift.embedding) >= 0.65)
  assert.ok(similarity(prior.embedding, drift.embedding) < 0.363)
  for (const name of ['', '合成保留目标']) {
    const next = await planPersonMerges([component, { ...drift, name }], similarity)
    assert.deepEqual(next.merges, [], '自动组件成为来源或目标都必须保留旧锚点限制')
  }
})

test('人工参考能提供可信强证据，但不会被追加为自动原锚点约束', async () => {
  const pose = Math.acos(0.6) * 180 / Math.PI
  const root = group('root', 0, [0, 0], { protected: true, trustedEmbeddings: [vector(pose)] }), source = group('source', 65, [pose, pose])
  const supported = await planPersonMerges([root, source], similarity)
  assert.equal(supported.merges.length, 1)
  assert.equal(supported.merges[0].targetId, 'root')
  assert.ok(supported.merges[0].similarity > 0.99)

  const trusted = group('trusted', 0, [0, 0], { protected: true, trustedEmbeddings: [vector(90)] })
  const first = group('first', 40, [40, 40, 40]), second = group('second', 0, [0, 0])
  const plan = await planPersonMerges([trusted, first, second], similarity)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [
    { sourceId: 'first', targetId: 'trusted' }, { sourceId: 'second', targetId: 'trusted' },
  ])
})

test('多照片提案保持确定次序，不修改输入或公开特征', async () => {
  const records = [group('first', 0, [0, 0]), group('later', 65, [65, 40, 30], { trustedEmbeddings: [vector(50)] })]
  const snapshot = structuredClone(records)
  const first = await planPersonMerges(records, similarity), reversed = await planPersonMerges([...records].reverse(), similarity)
  assert.deepEqual(first, reversed); assert.deepEqual(records, snapshot)
  assert.doesNotMatch(JSON.stringify(first), /embedding|samples|frames/)
})
