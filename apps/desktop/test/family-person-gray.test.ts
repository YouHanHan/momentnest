import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchingPerson } from '../src/service/face-grouping.ts'
import { faceSimilarity } from '../src/service/media-catalog.ts'

const vector = (angle: number) => [Math.cos(angle * Math.PI / 180), Math.sin(angle * Math.PI / 180)]
const group = { id: 'known', embedding: vector(0), samples: [] as { id: string; assetId: string; embedding: number[] }[] }

test('跨场景达到最低相似支持但不足强匹配时待归组，不创建新人', () => {
  assert.deepEqual(matchingPerson(vector(65), [group], new Set(), faceSimilarity), { kind: 'ambiguous' })
  assert.deepEqual(matchingPerson(vector(90), [group], new Set(), faceSimilarity), { kind: 'new' })
})

test('晚出现桥接照片后，原弱相似脸能使用新样本得到强匹配', () => {
  const updated = { ...group, samples: [{ id: 'bridge', assetId: 'bridge-photo', embedding: vector(40) }] }
  assert.deepEqual(matchingPerson(vector(65), [updated], new Set(), faceSimilarity), { kind: 'matched', personId: 'known' })
})

test('合照排他优先，弱相似不能阻止建立同图的独立人物', () => {
  assert.deepEqual(matchingPerson(vector(65), [group], new Set(['known']), faceSimilarity), { kind: 'new' })
})
