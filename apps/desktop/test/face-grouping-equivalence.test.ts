import test from 'node:test'
import assert from 'node:assert/strict'
import { matchingPerson, personAnchorThreshold, personMatchThreshold } from '../src/service/face-grouping.ts'
import type { PersonFaceGroup, PersonMatchDecision } from '../src/service/face-grouping.ts'
import { faceSimilarity } from '../src/service/media-catalog.ts'

type Similarity = (left: number[], right: number[]) => number

/** 保留优化前的全量比较作为参照，核对剪枝不会改变归组决策。 */
function fullMatch(embedding: number[], groups: PersonFaceGroup[], excluded: Set<string>, similarity: Similarity): PersonMatchDecision {
  const candidates = groups.filter(group => !excluded.has(group.id)).map(group => {
    const anchorScore = Math.max(similarity(group.embedding, embedding), ...(group.trustedEmbeddings ?? []).map(anchor => similarity(anchor, embedding)))
    return { id: group.id, score: Math.max(anchorScore, ...group.samples.map(face => similarity(face.embedding, embedding))), supported: anchorScore >= personAnchorThreshold }
  })
  const supported = candidates.filter(candidate => candidate.supported).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const best = supported[0]
  if (!best || best.score < personMatchThreshold) return { kind: candidates.some(candidate => candidate.score >= personAnchorThreshold) ? 'ambiguous' : 'new' }
  if (supported[1] && best.score - supported[1].score < 0.06) return { kind: 'ambiguous' }
  return { kind: 'matched', personId: best.id }
}

const group = (id: string, anchor: number, samples: number[], trusted: number[] = []): PersonFaceGroup => ({
  id, embedding: [anchor], trustedEmbeddings: trusted.map(value => [value]),
  samples: samples.map((value, index) => ({ id: `${id}-${index}`, assetId: `${id}-photo-${index}`, embedding: [value] })),
})

test('精确匹配在支持门槛、强匹配、候选差距、无效分值及合照排他边界保持原决策', () => {
  const scores = [-1, 0.362999, 0.363, 0.499999, 0.5, 0.559999, 0.56, 1, NaN]
  const similarity: Similarity = left => left[0]
  for (const anchor of scores) for (const sample of scores) {
    const groups = [group('second', anchor, [sample]), group('first', 0.44, [0.44], [0.363])]
    for (const excluded of [new Set<string>(), new Set(['first']), new Set(['second']), new Set(['first', 'second'])]) {
      assert.deepEqual(matchingPerson([1], groups, excluded, similarity), fullMatch([1], groups, excluded, similarity))
    }
  }
  const fallback = [group('unsupported', 0.2, [0.7])]
  assert.deepEqual(matchingPerson([1], fallback, new Set(), similarity), { kind: 'ambiguous' })
  assert.deepEqual(matchingPerson([1], [group('unsupported', 0.2, [0.7, NaN])], new Set(), similarity), { kind: 'new' })
  assert.deepEqual(matchingPerson([1], [], new Set(), similarity), { kind: 'new' })
})

test('确定性随机特征、多场景样本和人工可信参考与全量比较完全一致', () => {
  let seed = 29
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 4294967296 }
  const vector = () => Array.from({ length: 8 }, () => random() - 0.5)
  for (let iteration = 0; iteration < 200; iteration++) {
    const groups: PersonFaceGroup[] = Array.from({ length: 12 }, (_, index) => ({
      id: `person-${index}`, embedding: index === 0 && iteration % 7 === 0 ? [] : vector(),
      trustedEmbeddings: iteration % 3 === 0 ? [vector(), vector()] : [],
      samples: Array.from({ length: iteration % 9 }, (_, sample) => ({ id: `${index}-${sample}`, assetId: `photo-${sample}`, embedding: vector() })),
    }))
    const embedding = iteration % 2 === 0 ? groups[5].embedding : vector(), excluded = new Set(iteration % 4 === 0 ? ['person-5', 'person-8'] : [])
    assert.deepEqual(matchingPerson(embedding, groups, excluded, faceSimilarity), fullMatch(embedding, groups, excluded, faceSimilarity))
  }
})

test('存在可信候选时避免无支持人物的样本比较，同时保留相同匹配', () => {
  const groups = [group('known', 0.6, [0.8]), ...Array.from({ length: 100 }, (_, index) => group(`other-${index}`, 0.2, Array(8).fill(0.9)))]
  let completeCalls = 0, optimizedCalls = 0
  const expected = fullMatch([1], groups, new Set(), left => { completeCalls++; return left[0] })
  const actual = matchingPerson([1], groups, new Set(), left => { optimizedCalls++; return left[0] })
  assert.deepEqual(actual, expected)
  assert.ok(optimizedCalls < completeCalls / 2, '不满足可信支持的自动样本不能消耗全量比较开销')
})
