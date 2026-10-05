import { dirname } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

/** 根据可用核数限定测速范围，预留界面和传输资源，不让线程数无限增长。 */
export function faceThreadCandidates(parallelism: number): number[] {
  const available = Number.isInteger(parallelism) && parallelism > 0 ? parallelism : 1
  const maximum = Math.max(1, Math.min(4, Math.floor(available / 2)))
  return [...new Set([1, 2, 4, maximum])].filter(threads => threads <= maximum).sort((left, right) => left - right)
}

/** 使用短时模型测速选择线程数，提升不足一成时优先较少线程；缓存失效不影响识别。 */
export async function selectFaceThreads(key: string, candidates: number[], measure: (threads: number) => Promise<number[]>, cachePath?: string): Promise<number> {
  if (cachePath) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as { version?: number; key?: string; threads?: number }
      if (cached.version === 1 && cached.key === key && typeof cached.threads === 'number' && candidates.includes(cached.threads)) return cached.threads
    } catch { /* 首次运行、旧缓存或只读目录均可继续本地测速。 */ }
  }
  const fallback = candidates.includes(2) ? 2 : candidates[0]
  if (candidates.length === 1) return fallback
  const measurements: { threads: number; medianMs: number }[] = []
  let threads = fallback, best = Infinity
  const deadline = performance.now() + 3000
  for (const candidate of candidates) {
    if (measurements.length && performance.now() >= deadline) break
    try {
      const samples = (await measure(candidate)).filter(value => Number.isFinite(value) && value > 0).sort((left, right) => left - right)
      if (samples.length < 3) continue
      const medianMs = samples[Math.floor(samples.length / 2)]
      measurements.push({ threads: candidate, medianMs })
      if (medianMs < best * 0.9) { threads = candidate; best = medianMs }
    } catch { /* 单个线程配置测速失败时继续其它配置，正式模型仍可沿保守配置加载。 */ }
  }
  if (cachePath && measurements.length) {
    try {
      await mkdir(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, JSON.stringify({ version: 1, key, threads, measurements }), { encoding: 'utf8', flush: true })
    } catch { /* 无法保存性能偏好时继续使用本次测速结果，不影响原媒体或相册记录。 */ }
  }
  return threads
}
