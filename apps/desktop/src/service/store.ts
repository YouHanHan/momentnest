import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const browseRecordKinds = new Set(['familyAsset', 'familyBaby', 'familyDecision', 'familyDate', 'familyFace', 'familyPerson', 'familyRebuild', 'library', 'root', 'workspace'])

/** 以事务保存领域记录，内容索引使用独立索引表。 */
export class Store {
  readonly db: DatabaseSync
  private readonly browseEpoch = randomUUID()
  private browseChanges = 0
  private faceMetadata?: Map<string, { value: string; embeddingValid: boolean }>
  private faceMetadataVersion = 0
  private faceMetadataChanges = 0
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE UNIQUE INDEX IF NOT EXISTS files_content ON records(
        json_extract(value,'$.libraryId'),json_extract(value,'$.hash'),json_extract(value,'$.size')) WHERE kind='file';
      CREATE UNIQUE INDEX IF NOT EXISTS upload_key ON records(
        json_extract(value,'$.deviceId'),json_extract(value,'$.clientKey')) WHERE kind='session';
      CREATE TABLE IF NOT EXISTS locations(root TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,PRIMARY KEY(root,path));
      CREATE INDEX IF NOT EXISTS location_content ON locations(hash,size);
      CREATE INDEX IF NOT EXISTS record_updated ON records(kind,json_extract(value,'$.updatedAt'));
      CREATE INDEX IF NOT EXISTS record_saved ON records(kind,json_extract(value,'$.savedAt'));
    `)
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind,id)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  list<T>(kind: string): T[] {
    return this.db.prepare('SELECT value FROM records WHERE kind=?').all(kind).map(row => JSON.parse(String(row.value)) as T)
  }
  /** 浏览仅投影人脸公开字段，需要头像时在数据库内核对向量有效性。 */
  listFaceMetadata<T>(checkEmbedding = false): (T & { embeddingValid: boolean })[] {
    const version = Number(this.db.prepare('PRAGMA data_version').get()!.data_version)
    const changes = Number(this.db.prepare('SELECT total_changes() AS changes').get()!.changes)
    // 本连接逐脸更新缓存，外部提交或绕过 Store 的写入则重新读取，避免轮询反复校验整库特征。
    if (!this.faceMetadata || version !== this.faceMetadataVersion || changes !== this.faceMetadataChanges) {
      const valid = "CASE WHEN json_type(value,'$.embedding')='array' THEN COALESCE((SELECT MIN(CASE WHEN type IN ('integer','real') AND ABS(atom)<=1.7976931348623157e308 THEN 1 ELSE 0 END)*MAX(CASE WHEN atom!=0 THEN 1 ELSE 0 END) FROM json_each(records.value,'$.embedding')),0) ELSE 0 END"
      const rows = this.db.prepare(`SELECT id,json_remove(value,'$.embedding') AS value, ${valid} AS embedding_valid FROM records WHERE kind='familyFace'`).all()
      this.faceMetadata = new Map(rows.map(row => [String(row.id), { value: String(row.value), embeddingValid: row.embedding_valid === 1 }]))
      this.faceMetadataVersion = version; this.faceMetadataChanges = changes
    }
    // 每次返回独立对象，并保持数据库按 ID 的顺序；缓存不保留或暴露特征向量。
    return [...this.faceMetadata].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, row]) => ({ ...JSON.parse(row.value) as T, embeddingValid: checkEmbedding && row.embeddingValid }))
  }
  /** 人物名称、别名和计数不读取识别特征数组。 */
  listPeopleMetadata<T>(): T[] {
    return this.db.prepare("SELECT json_remove(value,'$.embedding') AS value FROM records WHERE kind='familyPerson'").all().map(row => JSON.parse(String(row.value)) as T)
  }
  /** 按首次插入顺序倒序读取，更新旧记录不会把它变成新任务。 */
  listByInsertion<T>(kind: string): T[] {
    return this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(row => JSON.parse(String(row.value)) as T)
  }
  content<T>(libraryId:string,hash:string,size:number):T|undefined {
    const row=this.db.prepare("SELECT value FROM records WHERE kind='file' AND json_extract(value,'$.libraryId')=? AND json_extract(value,'$.hash')=? AND json_extract(value,'$.size')=?").get(libraryId,hash,size)
    return row?JSON.parse(String(row.value)) as T:undefined
  }
  recent<T>(kind:'file'|'session'):T[] {
    const field=kind==='file'?'savedAt':'updatedAt'
    return this.db.prepare(`SELECT value FROM records WHERE kind=? ORDER BY json_extract(value,'$.${field}') DESC LIMIT 300`).all(kind).map(row=>JSON.parse(String(row.value)) as T)
  }
  put<T extends {id: string}>(kind: string, value: T): void {
    const serialized = JSON.stringify(value)
    const result = this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind,value.id,serialized)
    if (this.faceMetadata) {
      this.faceMetadataChanges += Number(result.changes)
      if (kind === 'familyFace') {
        const { embedding, ...metadata } = JSON.parse(serialized) as Record<string, unknown>
        const embeddingValid = Array.isArray(embedding) && embedding.length > 0 && embedding.every(item => typeof item === 'number' && Number.isFinite(item)) && embedding.some(item => item !== 0)
        this.faceMetadata.set(value.id, { value: JSON.stringify(metadata), embeddingValid })
      }
    }
    if (browseRecordKinds.has(kind)) this.browseChanges++
  }
  /** 仅移除领域索引记录，使浏览缓存同步失效，不访问媒体文件。 */
  remove(kind: string, id: string): void {
    const result = this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id)
    if (this.faceMetadata) { this.faceMetadataChanges += Number(result.changes); if (kind === 'familyFace' && result.changes) this.faceMetadata.delete(id) }
    if (result.changes && browseRecordKinds.has(kind)) this.browseChanges++
  }
  /** 将被替代的派生记录保留为历史，更新浏览与人脸缓存，不删除原媒体。 */
  archive(kind: string, id: string): void {
    const result = this.db.prepare('UPDATE records SET kind=?,id=? WHERE kind=? AND id=?').run(`${kind}History`, `${id}:${randomUUID()}`, kind, id)
    if (this.faceMetadata) {
      this.faceMetadataChanges += Number(result.changes)
      if (kind === 'familyFace' && result.changes) this.faceMetadata.delete(id)
    }
    if (result.changes && browseRecordKinds.has(kind)) this.browseChanges++
  }
  /** 事务外生成完整快照并只读校验，校验失败时不允许清空原索引。 */
  backup(path: string): void {
    this.db.prepare('VACUUM INTO ?').run(path)
    const backup = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = backup.prepare('PRAGMA integrity_check').all()
      if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('人脸索引备份校验失败，原索引未清除。')
    } finally { backup.close() }
  }
  /** 用实例身份、本地浏览变更及外部提交版本使旧浏览缓存失效，不写入数据库。 */
  get browseRevision(): string {
    const externalVersion = this.db.prepare('PRAGMA data_version').get()!.data_version
    return `${this.browseEpoch}:${this.browseChanges}:${externalVersion}`
  }
  transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { action(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); this.faceMetadata = undefined; throw error }
  }
  close(): void { this.db.close() }
}
