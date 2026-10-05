import { cpSync, existsSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** 日常启动固定使用同一目录，开发验收预先设置的独立目录继续隔离。 */
export function userDataDirectory(appData: string, applicationName: string, configured: string, packaged: boolean, home: string): string {
  const directory = resolve(configured)
  if (!packaged && directory !== resolve(join(appData, applicationName))) return directory
  return resolve(join(home, '.jinchuan'))
}

/** 使用系统返回的物理目录，避免启动环境重定向后触发目录身份校验失败。 */
export function canonicalUserDataDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true })
  return realpathSync.native(directory)
}

/** 首次沿用旧记录及生成缓存，校验完成后原子启用，旧目录保留作备份。 */
export function migrateUserDataDirectory(appData: string, directory: string): boolean {
  const target = join(directory, 'receiver')
  const legacy = join(appData, 'jinchuan', 'receiver')
  if (existsSync(join(target, 'receiver.sqlite')) || !existsSync(join(legacy, 'receiver.sqlite'))) return false
  const source = realpathSync.native(legacy)
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) return false
  const stage = join(directory, `receiver-migration-${randomUUID()}`)
  mkdirSync(stage, { recursive: true })
  // SQLite 自身生成一致快照，不能直接复制仍可能带有 WAL 的数据库文件。
  const previous = new DatabaseSync(join(source, 'receiver.sqlite'), { readOnly: true })
  try { previous.prepare('VACUUM INTO ?').run(join(stage, 'receiver.sqlite')) }
  finally { previous.close() }
  cpSync(source, stage, {
    recursive: true, force: false, errorOnExist: true,
    filter: path => !['receiver.sqlite', 'receiver.sqlite-wal', 'receiver.sqlite-shm'].some(name => path === join(source, name)),
  })
  const remap = (value: string): string => {
    for (const base of [source, legacy]) {
      const child = relative(base, value)
      if (child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) return join(target, child)
    }
    return value
  }
  const migrated = new DatabaseSync(join(stage, 'receiver.sqlite'))
  try {
    const rows = migrated.prepare("SELECT kind,id,value FROM records WHERE kind IN ('familyAsset','familyRebuild')").all()
    const update = migrated.prepare('UPDATE records SET value=? WHERE kind=? AND id=?')
    migrated.exec('BEGIN IMMEDIATE')
    for (const row of rows) {
      const record = JSON.parse(String(row.value))
      if (row.kind === 'familyAsset') {
        if (typeof record.thumbnailPath === 'string') record.thumbnailPath = remap(record.thumbnailPath)
        if (Array.isArray(record.faceFrames)) record.faceFrames = record.faceFrames.map((path: string) => remap(path))
      } else if (typeof record.backupPath === 'string') record.backupPath = remap(record.backupPath)
      const value = JSON.stringify(record)
      if (value !== row.value) update.run(value, row.kind, row.id)
    }
    migrated.exec('COMMIT')
    const integrity = migrated.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('旧相册迁移校验失败，原记录已保留。')
  } finally { migrated.close() }
  renameSync(stage, target)
  return true
}
