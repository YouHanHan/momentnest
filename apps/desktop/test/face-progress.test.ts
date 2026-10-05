import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FamilyJob } from '../src/shared/family.ts'
import { faceTimingLabel } from '../src/shared/face-progress.ts'

const now = Date.parse('2026-10-05T00:00:00Z')
const job: FamilyJob = { id: 'faces', kind: 'faces', state: 'running', processed: 120, total: 600, label: '', error: '', startedAt: new Date(now - 120000).toISOString() }
const sample = { time: now - 60000, processed: 60 }

test('人脸进度按观察区间的增量估算速度，不把已有缓存数量当成新处理量', () => {
  assert.equal(faceTimingLabel(job, 120, now, sample), '已用时 2 分钟 · 约 60 项/分钟 · 预计剩余约 8 分钟')
  assert.equal(faceTimingLabel({ ...job, startedAt: undefined }, 120, now, sample), '约 60 项/分钟 · 预计剩余约 8 分钟')
  assert.match(faceTimingLabel({ ...job, total: 7200 }, 120, now, sample), /预计剩余约 1 小时 58 分钟/)
})

test('样本不足、进度重置和计时异常不显示虚假剩余时间', () => {
  for (const observed of [{ time: now - 2000, processed: 60 }, { time: now - 60000, processed: 118 }, { time: now + 1000, processed: 60 }, { time: now - 60000, processed: 130 }]) {
    assert.match(faceTimingLabel(job, 120, now, observed), /正在估算剩余时间/)
  }
  assert.match(faceTimingLabel({ ...job, total: 0 }, 0, now, sample), /正在准备分析/)
})

test('失败项纳入已处理量，收尾及任务结束不显示零秒倒计时', () => {
  assert.match(faceTimingLabel(job, 150, now, sample), /约 90 项\/分钟 · 预计剩余约 5 分钟/)
  assert.match(faceTimingLabel(job, 600, now, sample), /正在整理结果/)
  assert.match(faceTimingLabel({ ...job, total: 150 }, 120, now, sample), /预计剩余不到 1 分钟/)
  for (const state of ['done', 'error'] as const) assert.equal(faceTimingLabel({ ...job, state }, 120, now, sample), '')
})
