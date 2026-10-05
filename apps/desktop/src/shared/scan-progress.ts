import type { FamilyJob } from './family.ts'

/** 只有完整统计过的扫描才有可用于预计时间的总量。 */
export function hasScanTotal(job: FamilyJob): boolean {
  return job.scanPhase === 'processing' && Number.isSafeInteger(job.scanTotal) && job.scanTotal! > 0 && job.processed + (job.skipped ?? 0) <= job.scanTotal!
}

/** 处理中不提前显示满格，最后的目录核对完成后才算结束。 */
export function scanProgressValue(job: FamilyJob): number | undefined {
  if (!hasScanTotal(job)) return undefined
  return Math.min(job.processed + (job.skipped ?? 0), job.scanTotal! * 0.99)
}

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
}

function remainingLabel(seconds: number): string {
  if (seconds < 60) return '不到 1 分钟'
  const minutes = Math.ceil(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
}

/** 使用本轮实际处理速度估算，样本不足、未知总量和历史任务不生成倒计时。 */
export function scanTimingLabel(job: FamilyJob, currentTime = Date.now()): string {
  if (job.kind !== 'scan' || job.state !== 'running') return ''
  const started = Date.parse(job.startedAt ?? '')
  const elapsed = Number.isFinite(started) && currentTime >= started ? `已用时 ${elapsedLabel((currentTime - started) / 1000)} · ` : ''
  if (job.scanPhase === 'counting') return `${elapsed}正在估算剩余时间`
  if (!hasScanTotal(job)) return `${elapsed}总量待确认，暂无法估算`
  const handled = job.processed + (job.skipped ?? 0)
  if (handled >= job.scanTotal!) return `${elapsed}正在收尾`
  const processingStarted = Date.parse(job.processingStartedAt ?? '')
  const processingSeconds = (currentTime - processingStarted) / 1000
  if (!Number.isFinite(processingSeconds) || processingSeconds < 5 || handled < 5) return `${elapsed}正在估算剩余时间`
  const remaining = processingSeconds * (job.scanTotal! - handled) / handled
  return `${elapsed}预计剩余${remaining < 60 ? '' : '约 '}${remainingLabel(remaining)}`
}
