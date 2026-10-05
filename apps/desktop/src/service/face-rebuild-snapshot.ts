import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BabyDecision } from '../shared/family.ts'

/** 只读应用内部备份的宝宝归属，不恢复旧人脸或向真实索引写入记录。 */
export function readRebuildBabySnapshot(dataDirectory: string, backupPath: string): BabyDecision[] {
  const directory = resolve(dataDirectory, 'face-index-backups')
  const contained = (root: string, path: string): boolean => {
    const child = relative(root, path)
    return Boolean(child) && !isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\')
  }
  const realDirectory = realpathSync(directory)
  if (!contained(realpathSync(dataDirectory), realDirectory) || !contained(directory, resolve(backupPath)) || !contained(realDirectory, realpathSync(backupPath))) throw new Error('重扫前结果备份不在应用数据目录中。')
  const backup = new DatabaseSync(backupPath, { readOnly: true })
  try {
    const rows = backup.prepare("SELECT id,value FROM records WHERE kind='familyDecision' AND json_extract(value,'$.origin')='recognition' AND json_extract(value,'$.state') IN ('included','candidate')").all()
    return rows.flatMap(row => {
      const decision = JSON.parse(String(row.value)) as BabyDecision
      if (typeof decision.babyId !== 'string' || typeof decision.assetId !== 'string' || !/^[a-f0-9]{64}-\d+$/.test(decision.assetId) || decision.id !== row.id || decision.id !== `${decision.babyId}:${decision.assetId}` || !['included', 'candidate'].includes(decision.state) || decision.origin !== 'recognition' || typeof decision.updatedAt !== 'string') return []
      return [{ id: decision.id, babyId: decision.babyId, assetId: decision.assetId, state: decision.state, origin: decision.origin, updatedAt: decision.updatedAt }]
    })
  } finally { backup.close() }
}
