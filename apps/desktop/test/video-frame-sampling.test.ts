import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoFrameTimes } from '../src/service/media-tools.ts'

/** 核对抽样时间在视频内均匀分布，且有效时长不会只检查中间一帧。 */
function assertSamples(duration: number, expected: number): number[] {
  const times = videoFrameTimes(duration)
  assert.equal(times.length, expected)
  assert.equal(new Set(times).size, expected)
  assert.ok(times.every(time => Number.isFinite(time) && time > 0 && time < duration))
  for (let index = 0; index < times.length; index++) assert.ok(Math.abs(times[index] - duration * (index + 0.5) / expected) < 1e-12)
  return times
}

test('约2.96秒及1秒短视频均匀检查首中尾，首尾不会因仅抽中间而漏查', () => {
  const example = assertSamples(2.9596, 3)
  assert.ok(Math.abs(example[0] - 0.4932666666666666) < 1e-12)
  assert.equal(example[1], 1.4798)
  assert.ok(Math.abs(example[2] - 2.4663333333333335) < 1e-12)
  assert.deepEqual(assertSamples(1, 3), [1 / 6, 0.5, 5 / 6])
})

test('普通抽样在5秒、10秒、15秒边界至少三帧，超过边界后沿用有限间隔', () => {
  for (const duration of [5, 10, 15]) assertSamples(duration, 3)
  assertSamples(15.0001, 4)
})

test('极短非零视频仍具有互异合法时间点，长视频最多检查八帧', () => {
  assertSamples(0.003, 3); assertSamples(0.000001, 3)
  for (const duration of [40, 41, 3600]) assertSamples(duration, 8)
})

test('补检策略保持至少三帧和四十八帧上限，无效时长仍仅尝试起始帧', () => {
  assert.deepEqual(videoFrameTimes(6, true), [1, 3, 5])
  assert.equal(videoFrameTimes(1, true).length, 3)
  for (const duration of [96, 3600]) assert.equal(videoFrameTimes(duration, true).length, 48)
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(videoFrameTimes(duration), [0]); assert.deepEqual(videoFrameTimes(duration, true), [0])
  }
})
