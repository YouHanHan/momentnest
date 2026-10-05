import type { FamilyJob } from './family.ts'

export interface FaceProgressSample { time: number; processed: number }

/** 只按实际增加的处理数量估算，旧任务没有起始时间时不猜测总用时。 */
export function faceTimingLabel(job: FamilyJob, handled: number, currentTime: number, sample: FaceProgressSample): string {
  if (job.kind !== 'faces' || job.state !== 'running') return ''
  const started = Date.parse(job.startedAt ?? '')
  const elapsedSeconds = (currentTime - started) / 1000
  const elapsed = Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0
    ? `已用时 ${elapsedSeconds < 60 ? `${Math.floor(elapsedSeconds)} 秒` : `${Math.floor(elapsedSeconds / 60)} 分钟`} · ` : ''
  if (!Number.isSafeInteger(job.total) || job.total <= 0) return `${elapsed}正在准备分析`
  if (handled >= job.total) return `${elapsed}正在整理结果`
  const seconds = (currentTime - sample.time) / 1000, processed = handled - sample.processed
  if (!Number.isFinite(seconds) || seconds < 5 || processed < 5) return `${elapsed}正在估算剩余时间`
  const rate = Math.max(1, Math.round(processed / seconds * 60))
  const remainingSeconds = seconds * (job.total - handled) / processed, minutes = Math.ceil(remainingSeconds / 60)
  const remaining = remainingSeconds < 60 ? '不到 1 分钟' : minutes < 60 ? `约 ${minutes} 分钟` : `约 ${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
  return `${elapsed}约 ${rate} 项/分钟 · 预计剩余${remaining}`
}
