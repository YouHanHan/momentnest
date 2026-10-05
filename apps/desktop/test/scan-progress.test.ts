import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FamilyJob } from '../src/shared/family.ts'
import { hasScanTotal, scanProgressValue, scanTimingLabel } from '../src/shared/scan-progress.ts'

const time = Date.parse('2026-10-04T12:00:00Z')
const job: FamilyJob = { id: 'scan', kind: 'scan', state: 'running', processed: 10, total: 10, label: '', error: '', scanPhase: 'processing', scanTotal: 100, startedAt: new Date(time - 90000).toISOString(), processingStartedAt: new Date(time - 30000).toISOString() }

test('剩余时间使用处理阶段的真实速度，统计耗时不混入速度样本', () => {
  assert.equal(scanTimingLabel(job, time), '已用时 1 分钟 · 预计剩余约 5 分钟')
  assert.equal(scanTimingLabel({ ...job, skipped: 10 }, time), '已用时 1 分钟 · 预计剩余约 2 分钟')
  assert.equal(scanProgressValue({ ...job, skipped: 10 }), 20)
})

test('统计中、旧任务和不完整总量均不输出虚假剩余时间', () => {
  assert.match(scanTimingLabel({ ...job, scanPhase: 'counting', scanTotal: 200 }, time), /正在估算剩余时间/)
  for (const sample of [{ ...job, scanTotal: undefined }, { ...job, scanTotal: 9 }, { ...job, scanPhase: undefined }, { ...job, scanTotal: NaN }]) {
    assert.equal(hasScanTotal(sample), false)
    assert.equal(scanProgressValue(sample), undefined)
    assert.match(scanTimingLabel(sample, time), /总量待确认，暂无法估算/)
    assert.doesNotMatch(scanTimingLabel(sample, time), /预计剩余约|NaN/)
  }
})

test('样本不足或计时异常时继续估算，收尾与结束不显示零秒倒计时', () => {
  for (const sample of [{ ...job, processed: 4 }, { ...job, processingStartedAt: new Date(time - 2000).toISOString() }, { ...job, processingStartedAt: 'invalid' }, { ...job, processingStartedAt: new Date(time + 1000).toISOString() }]) assert.match(scanTimingLabel(sample, time), /正在估算剩余时间/)
  const finishing = { ...job, processed: 100 }
  assert.match(scanTimingLabel(finishing, time), /正在收尾/)
  assert.equal(scanProgressValue(finishing), 99)
  for (const state of ['done', 'error'] as const) assert.equal(scanTimingLabel({ ...job, state }, time), '')
  assert.equal(scanTimingLabel({ ...job, kind: 'faces' }, time), '')
})

test('短任务与长任务采用约数展示，长时间没有进展时重新估算', () => {
  assert.match(scanTimingLabel({ ...job, scanTotal: 11 }, time), /预计剩余不到 1 分钟/)
  assert.match(scanTimingLabel({ ...job, scanTotal: 1210 }, time), /预计剩余约 1 小时/)
  assert.match(scanTimingLabel(job, time + 30000), /预计剩余约 9 分钟/)
})
