import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPersonMerges } from '../src/service/person-grouping-plan.ts'
import type { RepairPersonGroup } from '../src/service/person-grouping-plan.ts'
import { representativeFaces } from '../src/service/face-grouping.ts'

const vector = (degrees: number): number[] => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]
const similarity = (left: number[], right: number[]): number => left.reduce((sum, value, index) => sum + value * right[index], 0)

/** 合成独立缓存记录，不读取图库、模型或数据库。 */
function group(id: string, angle = 0, options: Partial<RepairPersonGroup> = {}): RepairPersonGroup {
  const embedding = vector(angle)
  return { id, name: '', embedding, samples: [{ id: `${id}-face`, assetId: id, embedding }], frames: new Set([`${id}:photo`]), assetCount: 1, ...options }
}

test('1005 个旧碎组以强证据收敛到五个命名人物，过程中让出事件循环', async () => {
  const anchor = (person: number): number[] => Array.from({ length: 5 }, (_, index) => index === person ? 1 : 0)
  const groups: RepairPersonGroup[] = Array.from({ length: 5 }, (_, index) => group(`named-${index}`, 0, { name: `人物${index}`, embedding: anchor(index), samples: [] }))
  for (let index = 0; index < 1000; index++) {
    const embedding = anchor(index % 5)
    groups.push(group(`fragment-${String(index).padStart(4, '0')}`, 0, { embedding, samples: [{ id: `sample-${index}`, assetId: `asset-${index}`, embedding }] }))
  }
  let yielded = false
  const timer = setTimeout(() => { yielded = true }, 0)
  const plan = await planPersonMerges(groups, similarity)
  clearTimeout(timer)
  assert.equal(yielded, true, '大量缓存整理不能持续占用工作线程')
  assert.equal(plan.merges.length, 1000)
  assert.equal(plan.ambiguous, 0); assert.equal(plan.conflicts, 0)
  for (const merge of plan.merges) {
    assert.equal(merge.targetId, `named-${Number(merge.sourceId.slice(-4)) % 5}`)
    assert.equal(merge.similarity, 1)
  }
  assert.equal(JSON.stringify(plan).includes('embedding'), false, '提案不得输出本地特征向量')
})

test('命名组优先且永不作为自动来源，两个相似命名目标的来源保持歧义', async () => {
  const named = group('named', 0, { name: '妈妈', assetCount: 1 }), large = group('large', 0, { assetCount: 90 })
  const first = await planPersonMerges([large, named], similarity)
  assert.deepEqual(first.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'large', targetId: 'named' }])
  const plan = await planPersonMerges([group('left', -10, { name: '人物一' }), group('right', 10, { name: '人物二' }), group('uncertain', 0)], similarity)
  assert.deepEqual(plan.merges, []); assert.equal(plan.ambiguous, 1); assert.equal(plan.conflicts, 0)
})

test('人工保护的未命名组优先保留为根，不成为自动合并来源', async () => {
  const manual = group('manual', 0, { protected: true }), large = group('large', 0, { assetCount: 100 })
  const plan = await planPersonMerges([large, manual], similarity)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'large', targetId: 'manual' }])
  assert.equal(manual.protected, true); assert.equal(manual.name, '')
  const separate = await planPersonMerges([manual, group('other-manual', 0, { protected: true, assetCount: 200 })], similarity)
  assert.deepEqual(separate.merges, [], '两个受保护根即使高度相似，也需要人工确认')
})

test('歧义来源不扩增候选根，后来有足够目标差距的来源仍能合并', async () => {
  const records = [group('left', -18, { name: '左侧人物' }), group('right', 18, { name: '右侧人物' }), group('ambiguous', 0, { assetCount: 3 }), group('clear', -18, { assetCount: 2 })]
  const plan = await planPersonMerges(records, similarity)
  assert.equal(plan.ambiguous, 1)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'clear', targetId: 'left' }], '歧义原组若被当成新根，会再次阻挡清晰来源')
})

test('两个强匹配目标差距不足时保留，差距明确时选择证据较强的目标', async () => {
  const targets = [group('left', 0, { name: '人物一' }), group('right', 26, { name: '人物二' })]
  const uncertain = await planPersonMerges([...targets, group('source', 6)], similarity)
  assert.ok(similarity(vector(6), vector(0)) - similarity(vector(6), vector(26)) < 0.06)
  assert.deepEqual(uncertain.merges, []); assert.equal(uncertain.ambiguous, 1)
  const clear = await planPersonMerges([...targets, group('source', 5)], similarity)
  assert.ok(similarity(vector(5), vector(0)) - similarity(vector(5), vector(26)) > 0.06)
  assert.equal(clear.ambiguous, 0); assert.equal(clear.merges[0]?.targetId, 'left')
})

test('同照片和同视频帧拒绝；组件累积的共现也阻止 A-B-C 间接合并', async () => {
  for (const shared of ['photo:photo', 'video:4']) {
    const plan = await planPersonMerges([group('first', 0, { assetCount: 3, frames: new Set([shared]) }), group('second', 0, { frames: new Set([shared]) })], similarity)
    assert.deepEqual(plan.merges, []); assert.equal(plan.conflicts, 1)
  }
  const records = [group('a', 0, { assetCount: 3, frames: new Set(['a:photo']) }), group('b', 0, { assetCount: 2, frames: new Set(['b:photo']) }), group('c', 0, { frames: new Set(['b:photo', 'c:photo']) })]
  const plan = await planPersonMerges(records, similarity)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'b', targetId: 'a' }])
  assert.equal(plan.conflicts, 1, '目标必须包含此前合入组的全部帧')
})

test('同一视频不同帧可合并，所有别名只指向保留的根', async () => {
  const records = Array.from({ length: 4 }, (_, index) => group(`person-${index}`, 0, { assetCount: 5 - index, frames: new Set([`video:${index}`]), samples: [{ id: `face-${index}`, assetId: 'video', frameTime: index, embedding: vector(0) }] }))
  const plan = await planPersonMerges(records, similarity)
  assert.equal(plan.merges.length, 3)
  assert.ok(plan.merges.every(merge => merge.targetId === 'person-0'))
  assert.equal(plan.conflicts, 0)
})

test('跨次整理的自动组件无论成为来源还是目标，都保留先前别名的原始锚点限制', async () => {
  const firstRoot = group('a', 0, { assetCount: 2 }), firstSource = group('b', 30)
  const first = await planPersonMerges([firstRoot, firstSource], similarity)
  assert.deepEqual(first.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'b', targetId: 'a' }])
  const automaticComponent = group('a', 0, { assetCount: 2, anchors: [firstSource.embedding], samples: [...firstRoot.samples, ...firstSource.samples], frames: new Set([...firstRoot.frames, ...firstSource.frames]) })
  assert.ok(similarity(vector(-20), firstRoot.embedding) > 0.8)
  assert.ok(similarity(vector(-20), firstSource.embedding) < 0.65)
  for (const targetName of ['', '保留人物']) {
    const next = await planPersonMerges([automaticComponent, group('c', -20, { name: targetName })], similarity)
    assert.deepEqual(next.merges, [], targetName ? '旧自动组件作为来源时也不能忽略历史锚点' : '旧自动组件作为目标时不能忽略历史锚点')
    assert.equal(next.ambiguous, 0); assert.equal(next.conflicts, 0)
  }
})

test('合入历史自动组件后继续传递全部锚点，不让同一方案后续来源绕过旧别名', async () => {
  const root = group('root', 0, { assetCount: 5 })
  const priorComponent = group('prior', 10, { assetCount: 3, anchors: [vector(30)] })
  const drift = group('drift', -20)
  const plan = await planPersonMerges([root, priorComponent, drift], similarity)
  assert.deepEqual(plan.merges.map(({ sourceId, targetId }) => ({ sourceId, targetId })), [{ sourceId: 'prior', targetId: 'root' }])
  assert.equal(plan.ambiguous, 0); assert.equal(plan.conflicts, 0)
})

test('超过64个原组的组件仍保留全部锚点，有限样本不能绕过早期锚点支持', async () => {
  const dimensions = 68
  const embedding = (index: number, sign = 1): number[] => Array.from({ length: dimensions }, (_, coordinate) => coordinate === 0 ? Math.sqrt(0.75) : coordinate === index ? sign * 0.5 : 0)
  const anchor = Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0)
  const records = [group('root', 0, { assetCount: 100, embedding: anchor, samples: [] })]
  records.push(group('early', 0, { assetCount: 90, embedding: embedding(1), samples: [{ id: 'zz-early', assetId: 'early', embedding: embedding(1) }] }))
  for (let index = 2; index < 67; index++) records.push(group(`member-${index}`, 0, { assetCount: 90 - index, embedding: embedding(index), samples: [{ id: `aa-${String(index).padStart(2, '0')}`, assetId: `photo-${index}`, embedding: embedding(index) }] }))
  const samples = representativeFaces(records.flatMap(record => record.samples), anchor, similarity)
  assert.equal(samples.length, 8); assert.equal(samples.some(face => face.id === 'zz-early'), false, '早期原组的锚点已经不在有限样本中')
  records.push(group('drift', 0, { embedding: embedding(1, -1), samples: [{ id: 'tempting-sample', assetId: 'drift', embedding: embedding(1) }] }))
  const plan = await planPersonMerges(records, similarity)
  assert.equal(plan.merges.length, records.length - 2)
  assert.ok(plan.merges.every(merge => merge.targetId === 'root' && merge.sourceId !== 'drift'), '来源对早期原始锚点只有0.5支持，不能靠样本或根锚点强匹配加入')
  assert.equal(plan.ambiguous, 0); assert.equal(plan.conflicts, 0)
})

test('低于强证据或最低原始锚点支持时保留，并拒绝非有限相似度', async () => {
  const weak = await planPersonMerges([group('root', 0, { assetCount: 2 }), group('weak', 40)], similarity)
  assert.deepEqual(weak.merges, [])
  const sample = await planPersonMerges([group('root', 0, { assetCount: 2, samples: [{ id: 'alternate', assetId: 'alternate', embedding: vector(60) }] }), group('unsupported', 60)], similarity)
  assert.deepEqual(sample.merges, [], '样本完全一致不能绕过原始锚点仅0.5的支持')
  assert.deepEqual((await planPersonMerges([group('one'), group('two')], () => NaN)).merges, [])
})

test('处理顺序确定，不修改输入顺序、样本、向量或共现集合', async () => {
  const records = [group('z', 4, { assetCount: 2, anchors: [vector(10)] }), group('a', 0, { assetCount: 2 }), group('b', 2)]
  const snapshot = structuredClone(records)
  const first = await planPersonMerges(records, similarity), second = await planPersonMerges([...records].reverse(), similarity)
  assert.deepEqual(first, second)
  assert.ok(first.merges.every(merge => merge.targetId === 'a'), '相同规模时保留稳定ID最前的根')
  assert.deepEqual(records, snapshot)
})
