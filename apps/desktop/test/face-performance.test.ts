import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { faceThreadCandidates, selectFaceThreads } from '../src/service/face-performance.ts'

test('低核电脑减少线程候选，高核电脑仍保留资源和四线程上限', () => {
  assert.deepEqual(faceThreadCandidates(1), [1])
  assert.deepEqual(faceThreadCandidates(2), [1])
  assert.deepEqual(faceThreadCandidates(4), [1, 2])
  assert.deepEqual(faceThreadCandidates(6), [1, 2, 3])
  assert.deepEqual(faceThreadCandidates(12), [1, 2, 4])
  assert.deepEqual(faceThreadCandidates(64), [1, 2, 4])
  for (const invalid of [0, -1, NaN, Infinity, 1.5]) assert.deepEqual(faceThreadCandidates(invalid), [1])
})

test('相同核数根据实测选择不同线程，增加线程变慢时保留更快配置', async () => {
  const candidates = faceThreadCandidates(12)
  const fastFour = await selectFaceThreads('fast-four', candidates, async threads => threads === 1 ? [80, 82, 79] : threads === 2 ? [50, 52, 49] : [35, 36, 34])
  const fastTwo = await selectFaceThreads('fast-two', candidates, async threads => threads === 1 ? [80, 82, 79] : threads === 2 ? [50, 52, 49] : [65, 66, 64])
  assert.equal(fastFour, 4); assert.equal(fastTwo, 2)
})

test('测速中位数抵抗单次抖动，小幅提速不增加线程占用', async () => {
  const selected = await selectFaceThreads('noise', [1, 2, 4], async threads => threads === 1 ? [80, 81, 800] : threads === 2 ? [50, 51, 500] : [48, 49, 5])
  assert.equal(selected, 2)
})

test('相同硬件和模型复用磁盘结果，身份或可用核数变化后重新测速', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-face-performance-')), path = join(directory, 'nested', 'performance.json')
  let calls = 0
  const measure = async (threads: number) => { calls++; return [80 / threads, 81 / threads, 79 / threads] }
  assert.equal(await selectFaceThreads('hardware-model-a', [1, 2, 4], measure, path), 4)
  assert.equal(calls, 3)
  assert.equal(await selectFaceThreads('hardware-model-a', [1, 2, 4], measure, path), 4)
  assert.equal(calls, 3, '普通重启不重复运行测速')
  assert.equal(await selectFaceThreads('hardware-model-b', [1, 2, 4], measure, path), 4)
  assert.equal(calls, 6, '更换硬件或模型重新选择配置')
  assert.equal(await selectFaceThreads('hardware-model-b', [1, 2], measure, path), 2)
  assert.equal(calls, 8, '不能沿用超出当前核数预算的旧配置')
  assert.equal(JSON.parse(await readFile(path, 'utf8')).threads, 2)
})

test('损坏缓存、失败配置或缓存不可写时不阻止本次识别配置选择', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-face-performance-failure-')), path = join(directory, 'performance.json')
  await writeFile(path, '{broken')
  const measure = async (threads: number) => { if (threads === 4) throw new Error('合成测速失败'); return [80 / threads, 81 / threads, 79 / threads] }
  assert.equal(await selectFaceThreads('synthetic', [1, 2, 4], measure, path), 2)
  assert.equal(await selectFaceThreads('synthetic', [1, 2, 4], async () => [NaN, -1, 0]), 2)
  await mkdir(join(directory, 'not-a-file'))
  assert.equal(await selectFaceThreads('synthetic', [1, 2, 4], measure, join(directory, 'not-a-file')), 2)
  assert.equal(await selectFaceThreads('single-core', [1], async () => { throw new Error('单核无需比较配置') }), 1)
})
