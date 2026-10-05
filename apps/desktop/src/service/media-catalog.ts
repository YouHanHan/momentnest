import { createHash, randomUUID } from 'node:crypto'
import { constants, statSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, stat, statfs } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { Store } from './store.ts'
import { archiveName, canonicalDirectory, hashFile, localDate, localMediaIdentity, mediaExtensions, mediaKind, requireValue, safePath, textValue, validDate } from './files.ts'
import { FaceEngine } from './face-engine.ts'
import { matchingPerson, representativeFaces } from './face-grouping.ts'
import type { PersonFaceGroup } from './face-grouping.ts'
import { planPersonMerges } from './person-grouping-plan.ts'
import { rebuildPersonGroups } from './person-index-rebuild.ts'
import { readRebuildBabySnapshot } from './face-rebuild-snapshot.ts'
import { readMetadata, thumbnail, videoFrameTimes, videoFrame, watermarkText, watermarkPreview, watermarkExport } from './media-tools.ts'
import { copyDirectoryError } from '../shared/import-paths.ts'
import type { MediaMetadata } from './media-tools.ts'
import { mediaContentHash } from './media-content.ts'
import type { Library, Receipt, ScanRoot } from './types.ts'
import type { BabyDecision, BabyMatchResult, BabyMatchStatus, BabyProfile, BrowseMutation, FaceRebuildStatus, FamilyDate, FamilyJob, FamilyState, FamilySyncRequest, FamilySyncResponse, ImportPlan, MediaAsset, MediaFace, MediaLocation, MediaPage, MediaQuery, PersonGroupingPreview, PersonGroupingUndo, PersonProfile, ProcessingWarningPage, SimilarFacePage, SimilarFaceQuery, WatermarkOptions, WatermarkResult } from '../shared/family.ts'

interface CatalogLocation extends MediaLocation { rootId?: string; relativePath: string; mtime: number }
interface CatalogAsset extends MediaAsset { locations: CatalogLocation[]; thumbnailPath?: string; faceFrames?: string[]; faceSupplementVersion?: number; faceSupplementing?: boolean; updatedAt: string; contentSignature?: string | null; supersededById?: string; favoriteUpdatedAt?: string; reconciledRevisionIds?: string[] }
interface FaceRecord extends MediaFace { assetId: string; embedding: number[] }
interface PersonRecord { id: string; name: string; embedding: number[]; mergedIntoId?: string; mergeOrigin?: 'manual' | 'automatic' }
interface FaceMetadata extends MediaFace { assetId: string; embedding?: number[]; embeddingValid?: boolean }
interface PersonMetadata { id: string; name: string; mergedIntoId?: string; mergeOrigin?: 'manual' | 'automatic' }
interface StoredPersonGrouping { libraryId: string; fingerprint: string; expiresAt: number; merges: { sourceId: string; targetId: string; similarity: number }[] }
interface StoredGroupingUndo extends PersonGroupingUndo { fingerprint: string; originals: PersonRecord[] }
interface RebuildAnnotation {
  oldFaceId: string; assetId: string; x: number; y: number; width: number; height: number
  frameTime?: number; personId?: string; newFaceId?: string
}
interface FaceIndexRebuild {
  id: string; epoch: string; assetIds: string[]; annotations: RebuildAnnotation[]
  phase: 'preparing' | 'detecting' | 'grouping' | 'done'; backupPath: string; updatedAt: string
}
interface ImportItem { path: string; relativePath: string; filename: string; size: number; mtime: number; metadata: MediaMetadata; archivePath: string; hash?: string }
interface StoredPlan extends ImportPlan { state: 'preparing' | 'ready' | 'error'; error?: string; items: ImportItem[]; createdAt: string }
interface Detector {
  ready(): Promise<{ ready: boolean; error: string }>
  detect(path: string): Promise<{ id?: string; x: number; y: number; width: number; height: number; score: number; embedding: number[]; reviewRequired?: boolean }[]>
  close?(): Promise<void>
}
interface DecorationContext<F extends FaceMetadata = FaceMetadata> {
  decisions: Map<string, BabyDecision[]>; faces: Map<string, F[]>; people: Map<string, PersonMetadata>
  roots: Set<string>; libraries: Set<string>
  references: Map<string, string[]>
}
const now = () => new Date().toISOString()
const idFor = (hash: string, size: number) => `${hash}-${size}`
// 同一文件可属于父子照片库，位置身份必须同时包含授权目录身份。
const locationId = (path: string, rootId?: string, libraryId?: string) => createHash('sha256').update(`${resolve(path).toLowerCase()}\0${libraryId ?? rootId ?? ''}`).digest('hex')
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '处理失败，请检查目录或文件。'
/** 将常见文件访问错误写成可理解的原因，保留原始诊断供核对。 */
const processingError = (error: unknown): string => {
  const reasons: Record<string, string> = { ENOENT: '文件或目录不存在', EACCES: '没有读取或写入权限', EPERM: '系统拒绝访问，文件可能被占用或权限不足', EBUSY: '文件正被其他程序占用', ETXTBSY: '文件正被其他程序占用', ENOSPC: '磁盘可用空间不足', EIO: '磁盘读取或写入失败', ENAMETOOLONG: '文件路径过长', ELOOP: '路径包含循环链接', EISDIR: '该路径是目录，不能作为媒体文件读取', ENOTDIR: '路径中的目录已被其他文件替代' }
  const reason = reasons[(error as NodeJS.ErrnoException | null)?.code ?? '']
  return reason ? `${reason}（${errorMessage(error)}）` : errorMessage(error)
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const faceSupplementVersion = 1

/** 相似度仅用于人物整理，不参与原图去重或上传成功判定。 */
export function faceSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1
  let product = 0, first = 0, second = 0
  for (let index = 0; index < left.length; index++) { product += left[index] * right[index]; first += left[index] ** 2; second += right[index] ** 2 }
  const score = first && second ? product / Math.sqrt(first * second) : -1
  return Number.isFinite(score) ? score : -1
}

/** 家庭相册索引与传输回执独立存储，原图仅由明确的复制归档操作写入。 */
export class MediaCatalog {
  readonly cacheDirectory: string
  private readonly engine: Detector
  private model = { ready: false, error: '' }
  private modelInitialization?: Promise<void>
  private automaticLibraries = new Set<string>()
  private automaticTimer?: ReturnType<typeof setTimeout>
  private automaticStarting = false
  private mediaQueryCache?: { revision: string; key: string; items: CatalogAsset[]; context: DecorationContext; baby?: BabyProfile }
  private tasks = new Set<Promise<void>>()
  private assets = new Map<string, CatalogAsset>()
  private locationAssets = new Map<string, string>()
  private locationHistory = new Map<string, Set<string>>()
  private contentTasks = new Map<string, Promise<unknown>>()
  private scanProgressTimes = new Map<string, number>()
  private personGroupingPlans = new Map<string, StoredPersonGrouping>()
  private personGroupingUndos = new Map<string, StoredGroupingUndo>()
  private babyMatching = new Map<string, BabyMatchStatus>()
  private babyMatchVersions = new Map<string, number>()
  private rebuildSnapshots = new Map<string, { decisions: BabyDecision[]; available: boolean }>()
  private rebuilding = false
  private closed = false
  constructor(readonly store: Store, readonly dataDirectory: string, readonly receiverId: string, modelDirectory?: string, engine?: Detector, private readonly externalContentLock?: <T>(key: string, action: () => Promise<T>) => Promise<T>) {
    this.cacheDirectory = join(dataDirectory, 'family-cache')
    this.engine = engine ?? new FaceEngine(modelDirectory ?? join(dataDirectory, 'models'), join(dataDirectory, 'face-performance.json'))
    for (const asset of store.list<CatalogAsset>('familyAsset')) {
      if (asset.faceSupplementing) { asset.faceState = 'error'; asset.faceError = '上次无脸补检被中断，可仅重试失败项。'; store.put('familyAsset', asset) }
      this.assets.set(asset.id, asset)
      for (const location of asset.locations) this.rememberLocation(location, asset.id)
      for (const location of asset.locations.filter(location => location.available)) this.locationAssets.set(locationId(location.path, location.rootId, location.libraryId), asset.id)
    }
    for (const job of store.list<FamilyJob>('familyJob').filter(item => item.state === 'running')) store.put('familyJob', { ...job, state: 'error', error: '上次任务被中断，请重新执行。' })
    for (const plan of store.list<StoredPlan>('familyPlan').filter(item => item.state === 'preparing')) store.put('familyPlan', { ...plan, state: 'error', error: '上次预扫描被中断，请重新生成计划。' })
    const queue = store.get<{ id: string; libraryIds: string[] }>('familyAutomaticQueue', 'main')
    if (Array.isArray(queue?.libraryIds)) for (const id of queue.libraryIds) if (typeof id === 'string') this.automaticLibraries.add(id)
    this.wakeAutomaticFaces()
  }
  private asset(id: string): CatalogAsset {
    requireValue(typeof id === 'string' && /^[a-f0-9]{64}-\d+$/.test(id), '媒体标识无效。')
    const asset = this.assets.get(id)
    requireValue(asset, '相册项目不存在。', 404)
    return asset
  }
  private putAsset(asset: CatalogAsset): void {
    this.store.put('familyAsset', asset); this.assets.set(asset.id, asset)
    for (const location of asset.locations) this.rememberLocation(location, asset.id)
    for (const location of asset.locations) if (location.available) this.locationAssets.set(locationId(location.path, location.rootId, location.libraryId), asset.id)
  }
  /** 位置历史用于恢复早期重扫产生的旧记录，不依赖整库逐项搜索。 */
  private rememberLocation(location: CatalogLocation, assetId: string): void {
    const key = locationId(location.path, location.rootId, location.libraryId), history = this.locationHistory.get(key) ?? new Set<string>()
    history.add(assetId); this.locationHistory.set(key, history)
  }
  /** 本地复制与手机上传使用同一个内容提交锁，避免同时保存重复文件。 */
  private async contentSerial<T>(key: string, action: () => Promise<T>): Promise<T> {
    if (this.externalContentLock) return this.externalContentLock(key, action)
    const previous = this.contentTasks.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action); this.contentTasks.set(key, next)
    try { return await next } finally { if (this.contentTasks.get(key) === next) this.contentTasks.delete(key) }
  }
  private root(id: string): ScanRoot {
    const root = this.store.get<ScanRoot>('root', textValue(id, 80))
    requireValue(root?.enabled, '来源目录不存在或已停用。', 404)
    return root
  }
  private library(id: string): Library {
    const library = this.store.get<Library>('library', textValue(id, 80))
    requireValue(library?.enabled, '目标目录不存在或已停用。', 404)
    return library
  }
  /** 复制只允许互不包含的目录，避免扫描自身归档结果或写回来源目录。 */
  private assertCopyDirectories(root: ScanRoot, library: Library): void {
    const error = copyDirectoryError(root.path, library.path)
    requireValue(!error, error ?? '复制归档目录冲突。', 409)
  }
  private baby(id: string): BabyProfile {
    const baby = this.store.get<BabyProfile>('familyBaby', textValue(id, 80))
    requireValue(baby, '宝宝档案不存在。', 404)
    return baby
  }
  private startJob(kind: FamilyJob['kind'], label: string, action: (job: FamilyJob) => Promise<void>, libraryId?: string, scanPurpose?: FamilyJob['scanPurpose']): FamilyJob {
    requireValue(!this.closed, '相册服务已关闭。')
    requireValue(!this.rebuilding, '人脸索引正在重建，请结束后再开始其他处理任务。', 409)
    requireValue(!this.store.list<FamilyJob>('familyJob').some(job => job.kind === kind && job.state === 'running'), '同类任务正在进行，请稍后重试。', 409)
    // 创建时固定扫描用途，进度中的文件名变化不影响任务分类。
    const job: FamilyJob = { id: randomUUID(), kind, state: 'running', processed: 0, total: 0, label, error: '', ...(libraryId ? { libraryId } : {}), ...(scanPurpose ? { scanPurpose } : {}) }
    this.store.put('familyJob', job)
    const task = pause().then(() => action(job)).then(() => { job.state = 'done'; this.store.put('familyJob', job) }).catch(error => { job.state = 'error'; job.error = errorMessage(error); this.store.put('familyJob', job) }).finally(() => {
      this.tasks.delete(task); this.scanProgressTimes.delete(job.id)
      if (kind === 'scan' || kind === 'import') this.requestAutomaticFaces(libraryId ?? this.store.get<{ id: string; libraryId: string | null }>('workspace', 'current-library')?.libraryId ?? undefined)
      else if (job.state === 'done') this.wakeAutomaticFaces()
    })
    this.tasks.add(task)
    return job
  }
  private progress(job: FamilyJob, label?: string): void {
    if (label) job.label = label
    if (job.scanPhase === 'processing' && job.scanTotal !== undefined && job.processed + (job.skipped ?? 0) > job.scanTotal) job.scanTotal = undefined
    // 扫描进度最多每半秒落盘一次，媒体索引与失败原因仍逐项保存。
    if (job.kind === 'scan' && job.scanPhase === 'processing' && job.state === 'running') {
      const time = Date.now()
      if (time - (this.scanProgressTimes.get(job.id) ?? 0) < 500) return
      this.scanProgressTimes.set(job.id, time)
    }
    this.store.put('familyJob', job)
  }
  /** 单项读取失败只记录有限警告，保留同批次已成功读取的媒体。 */
  // 完整原因逐条持久保存，任务及计划只携带前 20 条摘要。
  private skip(job: FamilyJob, path: string, error: unknown, plan?: StoredPlan): void {
    const warning = `${path}：${processingError(error)}`, index = (job.skipped ?? 0) + 1
    this.store.put('familyWarning', { id: `${job.id}:${index}`, jobId: job.id, index, message: warning })
    job.skipped = index; job.warningReportId = job.id
    if (job.kind !== 'faces') job.total = Math.max(job.total, job.processed + index)
    job.warnings = [...(job.warnings ?? []), warning].slice(0, 20)
    if (plan) { plan.skipped = job.skipped; plan.warnings = job.warnings; plan.warningReportId = job.id }
    this.progress(job)
  }
  /** 按任务和照片库分页读取完整原因，旧摘要只能返回实际保留的内容。 */
  getJobWarnings(jobId: string, page = 1, libraryId?: string): ProcessingWarningPage {
    const job = this.store.get<FamilyJob>('familyJob', textValue(jobId, 80))
    requireValue(job, '处理记录不存在。', 404)
    requireValue(Number.isSafeInteger(page) && page > 0, '原因页码无效。')
    if (libraryId !== undefined) textValue(libraryId, 80)
    requireValue(!job.libraryId || job.libraryId === libraryId, '处理记录不属于当前照片库。', 403)
    const limit = 20, offset = (page - 1) * limit
    requireValue(Number.isSafeInteger(offset), '原因页码无效。')
    if (!job.warningReportId) { const warnings = job.warnings ?? []; return { items: warnings.slice(offset, offset + limit), total: warnings.length, page, limit } }
    const condition = "kind='familyWarning' AND json_extract(value,'$.jobId')=?"
    const count = this.store.db.prepare(`SELECT COUNT(*) AS total FROM records WHERE ${condition}`).get(job.id)
    const rows = this.store.db.prepare(`SELECT json_extract(value,'$.message') AS message FROM records WHERE ${condition} ORDER BY CAST(json_extract(value,'$.index') AS INTEGER) LIMIT ? OFFSET ?`).all(job.id, limit, offset)
    return { items: rows.map(row => String(row.message)), total: Number(count?.total ?? 0), page, limit }
  }
  /** 同一次整库统计共用授权目录快照，避免对每张照片重复查询相同目录。 */
  private locationAuthorization(): Pick<DecorationContext, 'roots' | 'libraries'> {
    return { roots: new Set(this.store.list<ScanRoot>('root').filter(root => root.enabled).map(root => root.id)), libraries: new Set(this.store.list<Library>('library').filter(library => library.enabled).map(library => library.id)) }
  }
  private activeLocation(location: CatalogLocation, authorization?: Pick<DecorationContext, 'roots' | 'libraries'>): boolean {
    if (!location.available) return false
    if (authorization) return location.rootId ? authorization.roots.has(location.rootId) : Boolean(location.libraryId && authorization.libraries.has(location.libraryId))
    return location.rootId ? Boolean(this.store.get<ScanRoot>('root', location.rootId)?.enabled) : Boolean(location.libraryId && this.store.get<Library>('library', location.libraryId)?.enabled)
  }
  /** 检测与补检始终限定可用且仍获授权的媒体位置。 */
  private hasActiveLocation(asset: CatalogAsset, libraryId?: string, authorization?: Pick<DecorationContext, 'roots' | 'libraries'>): boolean {
    return asset.locations.some(location => (libraryId === undefined || location.libraryId === libraryId) && this.activeLocation(location, authorization))
  }
  /** 旧的无脸缓存只明确补检一次，失败或中断由既有失败重试入口继续。 */
  private needsFaceSupplement(asset: CatalogAsset, faceAssetIds: Set<string>): boolean {
    return asset.faceState === 'done' && !faceAssetIds.has(asset.id) && (asset.faceSupplementVersion ?? 0) < faceSupplementVersion && !asset.faceSupplementing
  }
  private decorationContext(faces: FaceRecord[]): DecorationContext<FaceRecord>
  private decorationContext(faces: undefined, checkEmbedding: boolean, browseRebuild?: boolean): DecorationContext
  private decorationContext(): DecorationContext
  private decorationContext(faces?: FaceRecord[], checkEmbedding = false, browseRebuild = false): DecorationContext {
    const context: DecorationContext = { decisions: new Map(), faces: new Map(), people: new Map(this.store.listPeopleMetadata<PersonMetadata>().map(person => [person.id, person])), ...this.locationAuthorization(), references: new Map() }
    for (const baby of this.store.list<BabyProfile>('familyBaby')) for (const reference of baby.referenceFaces) { const ids = context.references.get(reference.assetId) ?? []; if (!ids.includes(baby.id)) ids.push(baby.id); context.references.set(reference.assetId, ids) }
    for (const decision of browseRebuild ? this.browseBabyDecisions() : this.store.list<BabyDecision>('familyDecision')) { const group = context.decisions.get(decision.assetId) ?? []; group.push(this.visibleBabyDecision(decision)); context.decisions.set(decision.assetId, group) }
    for (const face of faces ?? this.store.listFaceMetadata<FaceMetadata>(checkEmbedding)) { const group = context.faces.get(face.assetId) ?? []; group.push(face); context.faces.set(face.assetId, group) }
    return context
  }
  /** 只显示仍授权照片库的未完成重建，普通浏览不启动或恢复检测任务。 */
  private pendingFaceRebuilds(): FaceIndexRebuild[] {
    const libraries = new Set(this.store.list<Library>('library').filter(library => library.enabled).map(library => library.id))
    return this.store.list<FaceIndexRebuild>('familyRebuild').filter(rebuild => rebuild.phase !== 'done' && libraries.has(rebuild.id))
  }
  /** 备份不可读时明确报告；同一重建只读取一次归属快照，避免轮询反复访问磁盘。 */
  private rebuildSnapshot(rebuild: FaceIndexRebuild): { decisions: BabyDecision[]; available: boolean } {
    if (rebuild.phase === 'preparing') return { decisions: [], available: true }
    const cached = this.rebuildSnapshots.get(rebuild.epoch)
    if (cached) return cached
    let snapshot: { decisions: BabyDecision[]; available: boolean }
    try { snapshot = { decisions: readRebuildBabySnapshot(this.dataDirectory, rebuild.backupPath), available: true } }
    catch { snapshot = { decisions: [], available: false } }
    this.rebuildSnapshots.set(rebuild.epoch, snapshot)
    return snapshot
  }
  /** 旧识别结果仅投影到浏览，当前人工确认及排除优先且不改写真实归属。 */
  private browseBabyDecisions(): BabyDecision[] {
    const decisions = new Map(this.store.list<BabyDecision>('familyDecision').map(decision => [decision.id, decision]))
    const babyIds = new Set(this.store.list<BabyProfile>('familyBaby').map(baby => baby.id))
    for (const rebuild of this.pendingFaceRebuilds()) {
      const assetIds = new Set(rebuild.assetIds)
      for (const previous of this.rebuildSnapshot(rebuild).decisions) {
        const current = decisions.get(previous.id)
        if (!assetIds.has(previous.assetId) || !babyIds.has(previous.babyId) || current?.origin === 'manual') continue
        decisions.set(previous.id, { ...previous, rebuildPending: true })
      }
    }
    return [...decisions.values()]
  }
  /** 累计进度来自已持久化媒体状态，继续重建时不会把剩余任务误当成整库总量。 */
  private faceRebuildStatuses(): FaceRebuildStatus[] {
    const jobs = this.store.list<FamilyJob>('familyJob')
    return this.pendingFaceRebuilds().map(rebuild => {
      const assets = rebuild.assetIds.flatMap(id => this.assets.get(id) ? [this.assets.get(id)!] : [])
      return { libraryId: rebuild.id, libraryName: this.library(rebuild.id).name, phase: rebuild.phase as FaceRebuildStatus['phase'], state: jobs.some(job => job.libraryId === rebuild.id && job.kind === 'faces' && job.state === 'running') ? 'running' : 'interrupted', processed: rebuild.phase === 'preparing' ? 0 : assets.filter(asset => asset.faceState !== 'pending').length, total: rebuild.assetIds.length, failed: assets.filter(asset => asset.faceState === 'error').length, snapshotAvailable: this.rebuildSnapshot(rebuild).available }
    })
  }
  /** 旧自动排除只表示未匹配，读取时兼容为待核对而不批量改写历史记录。 */
  private visibleBabyDecision(decision: BabyDecision): BabyDecision {
    return decision.origin === 'recognition' && decision.state === 'excluded' ? { ...decision, state: 'unconfirmed' } : decision
  }
  /** 没有判断证据的媒体仍可人工核对，只有明确匹配或人工排除才移出此范围。 */
  private needsBabyReview(decision?: BabyDecision): boolean {
    return !decision || decision.state === 'unconfirmed' || decision.origin === 'recognition' && decision.state === 'excluded'
  }
  /** 根据检测覆盖和当前宝宝记录说明未确定原因，不从无脸或低分推断身份。 */
  private babyReviewReason(asset: CatalogAsset, baby: BabyProfile, context: DecorationContext): string {
    if (asset.faceState === 'pending') return '尚未分析，可直接人工核对。'
    if (asset.faceState === 'error') return '人脸识别失败，可直接人工核对。'
    if (!context.faces.get(asset.id)?.length) return '未检测到人脸，可直接人工核对。'
    if (!baby.referenceFaces.length) return '尚未设置参考人脸，可直接人工核对。'
    const decision = context.decisions.get(asset.id)?.find(item => item.babyId === baby.id)
    if (decision?.origin === 'recognition' && decision.score !== undefined && decision.score < 0.4) return '人脸相似度较低，仍需人工核对。'
    return '尚未确定归属，可直接人工核对。'
  }
  /** 合并只保存人物别名，读取时解析最终人物，不改写历史人脸与宝宝参考。 */
  private canonicalPersonId(id: string, people: Map<string, PersonMetadata>): string {
    const visited = new Set<string>()
    let current = id
    while (people.get(current)?.mergedIntoId) {
      requireValue(!visited.has(current), '人物合并记录存在循环，请检查记录。')
      visited.add(current)
      const target = people.get(current)!.mergedIntoId!
      requireValue(people.has(target), '人物合并目标不存在。')
      current = target
    }
    return current
  }
  /** 内容记录共用，当前库范围只按该库的真实保存位置判断。 */
  private scopedAssets(libraryId?: string): CatalogAsset[] {
    if (libraryId !== undefined) {
      requireValue(this.store.get<Library>('library', textValue(libraryId, 80)), '照片库不存在，请重新选择。', 404)
      return [...this.assets.values()].filter(asset => !asset.supersededById && asset.locations.some(location => location.libraryId === libraryId))
    }
    return [...this.assets.values()].filter(asset => !asset.supersededById)
  }
  private decorated(asset: CatalogAsset, context: DecorationContext, libraryId?: string): MediaAsset {
    const decisions = context.decisions.get(asset.id) ?? []
    const faces = (context.faces.get(asset.id) ?? []).map(({ embedding: _, assetId: __, embeddingValid: ___, ...face }) => {
      const personId = face.personId ? this.canonicalPersonId(face.personId, context.people) : undefined
      return { ...face, personId, personName: personId ? context.people.get(personId)?.name ?? '' : undefined }
    })
    const active = (location: CatalogLocation) => location.available && (location.rootId ? context.roots.has(location.rootId) : Boolean(location.libraryId && context.libraries.has(location.libraryId)))
    const { thumbnailPath: _, updatedAt: __, faceFrames: ___, faceSupplementVersion: ____, faceSupplementing: _____, contentSignature: ______, supersededById: _______, favoriteUpdatedAt: ________, reconciledRevisionIds: _________, ...visible } = asset
    const locations = asset.locations.filter(location => libraryId === undefined || location.libraryId === libraryId)
    // 同内容跨库可使用不同名字，展示与搜索使用当前库位置及其原始回执名。
    const filename = this.mediaFilename(asset, context, libraryId)
    return { ...visible, filename, locations: locations.map(entry => { const { rootId: _, relativePath: __, mtime: ___, ...location } = entry; return { ...location, available: active(entry) } }), available: locations.some(active), babyIds: decisions.filter(item => item.state === 'included' && !item.rebuildPending).map(item => item.babyId), babyDecisions: decisions.map(decision => ({ ...decision })), babyReferenceIds: context.references.get(asset.id) ?? [], faces, personIds: [...new Set(faces.map(face => face.personId).filter((id): id is string => Boolean(id)))] }
  }
  /** 界面仅接收头像框和人物名称，不暴露本地特征向量。 */
  private visibleFace(face: FaceMetadata, personName?: string): MediaFace {
    const { embedding: _, assetId: __, embeddingValid: ___, ...visible } = face
    return { ...visible, ...(personName !== undefined ? { personName } : {}) }
  }
  /** 自动归类只使用确实有特征向量和有效头像框的清晰参考。 */
  private clearReference(face: FaceRecord): boolean {
    return this.clearFaceBox(face) && face.embedding.length > 0 && face.embedding.every(Number.isFinite) && face.embedding.some(value => value !== 0)
  }
  /** 头像展示先核对检测框，向量有效性由读取方式单独提供。 */
  private clearFaceBox(face: MediaFace): boolean {
    return Number.isFinite(face.score) && face.score >= 0.5 && [face.x, face.y, face.width, face.height].every(Number.isFinite) && face.x >= 0 && face.y >= 0 && face.width > 0 && face.height > 0 && face.x + face.width <= 1.000001 && face.y + face.height <= 1.000001
  }
  /** 当前库名称只在需要搜索或装饰本页时读取对应位置和有效回执。 */
  private mediaFilename(asset: CatalogAsset, context: Pick<DecorationContext, 'roots' | 'libraries'>, libraryId?: string): string {
    if (libraryId === undefined) return asset.filename
    const locations = asset.locations.filter(location => location.libraryId === libraryId)
    const current = locations.find(location => location.available && (location.rootId ? context.roots.has(location.rootId) : context.libraries.has(libraryId))) ?? locations[0]
    if (!current) return asset.filename
    const receipt = current.receiptId ? this.store.get<Receipt>('file', current.receiptId) : undefined
    return receipt && receipt.libraryId === libraryId && receipt.relativePath === current.relativePath ? receipt.filename : basename(current.path)
  }
  /** 参考必须对应指定照片，并持有清晰有效的本地人脸记录。 */
  private validReferenceFaces(baby: BabyProfile): FaceRecord[] {
    return baby.referenceFaces.flatMap(reference => {
      const face = this.store.get<FaceRecord>('familyFace', reference.faceId)
      return face?.assetId === reference.assetId && this.clearReference(face) && this.assets.get(reference.assetId)?.locations.some(location => this.activeLocation(location)) ? [face] : []
    })
  }
  private automaticBabies(): BabyProfile[] {
    return this.store.list<BabyProfile>('familyBaby').filter(baby => baby.autoMatch && this.validReferenceFaces(baby).length > 0)
  }
  /** 模型加载与页面读取分离，接收入库后的后台队列也能独立使用。 */
  private initializeModel(): Promise<void> {
    return this.modelInitialization ??= this.engine.ready().then(status => { this.model = status }).catch(error => { this.model = { ready: false, error: errorMessage(error) } })
  }
  /** 保存实际目标库的处理请求，批量接收合并排队，重启后继续未处理内容。 */
  requestAutomaticFaces(libraryId?: string): void {
    if (this.closed) return
    if (libraryId !== undefined && this.store.get<Library>('library', libraryId)?.enabled && !this.automaticLibraries.has(libraryId) && this.hasPendingAutomaticFaces(libraryId)) {
      this.automaticLibraries.add(libraryId); this.saveAutomaticQueue()
    }
    this.wakeAutomaticFaces()
  }
  private saveAutomaticQueue(): void {
    this.store.put('familyAutomaticQueue', { id: 'main', libraryIds: [...this.automaticLibraries] })
  }
  private hasPendingAutomaticFaces(libraryId: string): boolean {
    return [...this.assets.values()].some(asset => asset.faceState === 'pending' && !asset.faceSupplementing && this.hasActiveLocation(asset, libraryId))
  }
  /** 短时间内的新照片共用一次唤醒，正在处理时由任务结束后接续。 */
  private wakeAutomaticFaces(): void {
    if (this.closed || !this.automaticLibraries.size || this.automaticTimer || this.automaticStarting) return
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = undefined
      const task = this.drainAutomaticFaces().catch(error => { console.error('自动人脸队列启动失败：', errorMessage(error)) }).finally(() => this.tasks.delete(task))
      this.tasks.add(task)
    }, 250)
  }
  /** 只处理仍授权目标库中的待分析内容，失败缓存和未完成重建等待明确操作。 */
  private async drainAutomaticFaces(): Promise<void> {
    if (this.closed || this.automaticStarting || this.rebuilding || this.store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    this.automaticStarting = true
    try {
      const pendingLibrary = (): string | undefined => {
        for (const id of this.automaticLibraries) {
          if (!this.store.get<Library>('library', id)?.enabled) continue
          const rebuild = this.store.get<FaceIndexRebuild>('familyRebuild', id)
          if (rebuild && rebuild.phase !== 'done') continue
          if (this.hasPendingAutomaticFaces(id)) return id
          this.automaticLibraries.delete(id); this.saveAutomaticQueue()
        }
        return undefined
      }
      if (!pendingLibrary() || !this.automaticBabies().length) return
      await this.initializeModel()
      if (this.closed || this.rebuilding || !this.model.ready || !this.automaticBabies().length || this.store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
      const libraryId = pendingLibrary()
      if (libraryId) this.analyzeFaces(libraryId, false, true)
    } finally { this.automaticStarting = false }
  }
  /** 轮询只启动未分析的新内容，错误项留给明确重试，防止反复整库运行。 */
  private ensureAutomaticFaces(libraryId?: string): void {
    this.requestAutomaticFaces(libraryId)
    if (libraryId === undefined || !this.store.get<Library>('library', libraryId)?.enabled) return
    if (this.closed || !this.model.ready || this.store.list<FamilyJob>('familyJob').some(job => job.state === 'running') || !this.automaticBabies().length) return
    const rebuild = this.store.get<FaceIndexRebuild>('familyRebuild', libraryId)
    if (rebuild && rebuild.phase !== 'done') return
    this.analyzeFaces(libraryId, false, true)
  }
  /** 相册与整理预览共用人物头像统计，整理预览无需启动模型或自动任务。 */
  private peopleProfiles(faces: FaceMetadata[], personRecords: PersonMetadata[], libraryId?: string, authorization?: Pick<DecorationContext, 'roots' | 'libraries'>): PersonProfile[] {
    const personMap = new Map(personRecords.map(person => [person.id, person]))
    const personFaces = new Map<string, FaceMetadata[]>()
    for (const face of faces) if (face.personId) { const personId = this.canonicalPersonId(face.personId, personMap), group = personFaces.get(personId) ?? []; group.push({ ...face, personId }); personFaces.set(personId, group) }
    return personRecords.filter(person => !person.mergedIntoId).map(person => {
      const related = personFaces.get(person.id) ?? []
      const representative = related.filter(face => {
        const asset = this.assets.get(face.assetId)
        return asset?.kind === 'photo' && face.embeddingValid && this.clearFaceBox(face) && this.hasActiveLocation(asset, libraryId, authorization)
      }).sort((left, right) => right.score - left.score || right.width * right.height - left.width * left.height || left.id.localeCompare(right.id))[0]
      const reference = representative ? { assetId: representative.assetId, face: this.visibleFace(representative, person.name), kind: 'photo' as const } : undefined
      return { id: person.id, name: person.name, faceCount: related.length, assetCount: new Set(related.map(face => face.assetId)).size, ...(reference ? { reference } : {}) }
    }).filter(person => person.faceCount > 0)
  }
  /** 只统计具有有效特征与头像框、尚未可靠归组的人脸。 */
  private ungroupedFace(face: FaceMetadata): boolean { return !face.personId && Boolean(face.embeddingValid) && this.clearFaceBox(face) }
  async familyState(libraryId?: string): Promise<FamilyState> {
    // 模型校验与首次测速独立进行，现有图库和归属不等待模型加载。
    void this.initializeModel()
    await Promise.resolve()
    const assets = this.scopedAssets(libraryId), assetIds = new Set(assets.map(asset => asset.id))
    this.ensureAutomaticFaces(libraryId)
    const allFaces = this.store.listFaceMetadata<FaceMetadata>(true), faces = allFaces.filter(face => assetIds.has(face.assetId))
    const authorization = this.locationAuthorization()
    const availableAssets = assets.filter(asset => this.hasActiveLocation(asset, libraryId, authorization)), faceAssetIds = new Set(faces.map(face => face.assetId))
    const people = this.peopleProfiles(faces, this.store.listPeopleMetadata<PersonMetadata>(), libraryId, authorization)
    const ungrouped = faces.filter(face => this.ungroupedFace(face))
    // 先按库筛选再取最新任务，旧版无库记录仍作为历史保留。
    const jobs = this.store.listByInsertion<FamilyJob>('familyJob').filter(job => libraryId === undefined || !job.libraryId || job.libraryId === libraryId).slice(0, 25)
    const babies = this.store.list<BabyProfile>('familyBaby'), decisions = this.browseBabyDecisions()
    const babyMatching = babies.map(baby => {
      const latest = this.babyMatching.get(baby.id), matchedLibrary = latest?.libraryId ?? libraryId, scope = latest?.scope ?? (libraryId ? 'library' : 'all')
      const visibleLibrary = scope === 'all' ? undefined : matchedLibrary
      const related = this.scopedAssets(visibleLibrary).filter(asset => this.hasActiveLocation(asset, visibleLibrary, authorization))
      const live = this.matchStatus(baby, related, visibleLibrary, scope, decisions, allFaces)
      return latest && !live.rebuilding ? { ...latest, included: live.included, candidates: live.candidates, validReferences: live.validReferences, invalidReferences: live.invalidReferences, coverage: live.coverage } : live
    })
    const undo = [...this.personGroupingUndos.values()].reverse().find(item => item.libraryId === libraryId && item.expiresAt > Date.now())
    const personGroupingUndo = undo ? { token: undo.token, libraryId: undo.libraryId, count: undo.count, expiresAt: undo.expiresAt } : undefined
    return { faceRebuilds: this.faceRebuildStatuses(), browseRevision: this.store.browseRevision, photoCount: assets.filter(asset => asset.kind === 'photo').length, videoCount: assets.filter(asset => asset.kind === 'video').length, babies, people, jobs, modelReady: this.model.ready, modelError: this.model.error, candidateCount: decisions.filter(item => item.state === 'candidate' && assetIds.has(item.assetId)).length, importPlans: this.store.list<StoredPlan>('familyPlan').filter(plan => libraryId === undefined || !plan.libraryId || plan.libraryId === libraryId).slice(-10).map(plan => this.publicPlan(plan)), analysis: { pending: assets.filter(asset => asset.faceState === 'pending').length, done: assets.filter(asset => asset.faceState === 'done').length, error: assets.filter(asset => asset.faceState === 'error').length, faceCount: faces.length, noFaces: availableAssets.filter(asset => asset.faceState === 'done' && !faceAssetIds.has(asset.id)).length, supplementPending: availableAssets.filter(asset => this.needsFaceSupplement(asset, faceAssetIds)).length }, ungrouped: { faces: ungrouped.length, assets: new Set(ungrouped.map(face => face.assetId)).size }, babyMatching, ...(personGroupingUndo ? { personGroupingUndo } : {}) }
  }
  queryMedia(query: MediaQuery = {}): MediaPage {
    requireValue(query && typeof query === 'object' && !Array.isArray(query), '相册查询参数无效。')
    const page = Number.isSafeInteger(query.page) && query.page! > 0 ? query.page! : 1
    const limit = Number.isSafeInteger(query.limit) ? Math.max(1, Math.min(100, query.limit!)) : 60
    if (query.from) requireValue(validDate(query.from), '开始日期无效。')
    if (query.to) requireValue(validDate(query.to), '结束日期无效。')
    requireValue(query.order === undefined || query.order === 'asc' || query.order === 'desc', '日期排序无效。')
    requireValue(query.scope === undefined || query.scope === 'library' || query.scope === 'all', '宝宝查询范围无效。')
    if (query.scope !== undefined) requireValue(Boolean(query.babyId || query.referenceBabyId), '宝宝查询范围需要宝宝标识。')
    if (query.scope === 'all') requireValue(query.libraryId === undefined, '全部授权目录查找不能限定单个照片库。')
    if (query.scope === 'library') textValue(query.libraryId, 80)
    requireValue(query.includeCandidates === undefined || typeof query.includeCandidates === 'boolean', '包含待确认参数无效。')
    requireValue(query.unconfirmed === undefined || typeof query.unconfirmed === 'boolean', '待核对参数无效。')
    requireValue(query.ungroupedFaces === undefined || typeof query.ungroupedFaces === 'boolean', '待归组筛选参数无效。')
    requireValue(!query.ungroupedFaces || !query.personId, '待归组查询不能同时限定人物。')
    if (query.includeCandidates) requireValue(Boolean(query.babyId) && query.candidates !== true, '包含待确认需要指定宝宝，且不能与仅看待确认同时使用。')
    if (query.unconfirmed) requireValue(Boolean(query.babyId) && query.candidates !== true && query.includeCandidates !== true, '待核对需要指定宝宝，且不能与疑似或全部匹配同时使用。')
    const search = typeof query.search === 'string' ? query.search.slice(0, 200).trim().toLowerCase() : ''
    const revision = this.store.browseRevision, key = JSON.stringify({ ...query, page: undefined, limit: undefined })
    let cached = this.mediaQueryCache
    if (!cached || cached.revision !== revision || cached.key !== key) {
      const context = this.decorationContext(undefined, Boolean(query.ungroupedFaces), true), baby = query.babyId ? this.baby(query.babyId) : undefined
      const personId = query.personId ? this.canonicalPersonId(textValue(query.personId, 80), context.people) : undefined
      // 档案管理按参考标识读取，避免为最多二十个参考遍历整库媒体。
      const referenceBaby = query.referenceBabyId ? this.baby(textValue(query.referenceBabyId, 80)) : undefined
      if (referenceBaby && query.libraryId !== undefined) requireValue(this.store.get<Library>('library', textValue(query.libraryId, 80)), '照片库不存在，请重新选择。', 404)
      const sourceAssets = referenceBaby ? [...new Set(referenceBaby.referenceFaces.map(face => face.assetId))].flatMap(id => {
        const asset = this.assets.get(id)
        return asset && (query.libraryId === undefined || asset.locations.some(location => location.libraryId === query.libraryId)) ? [asset] : []
      }) : this.scopedAssets(query.libraryId)
      const items = sourceAssets.filter(asset => {
        if ((query.scope === 'all' || query.unconfirmed) && !asset.locations.some(location => (query.libraryId === undefined || location.libraryId === query.libraryId) && location.available && (location.rootId ? context.roots.has(location.rootId) : Boolean(location.libraryId && context.libraries.has(location.libraryId))))) return false
        if (query.kind && asset.kind !== query.kind) return false
        if (query.babyId) {
          const membership = context.decisions.get(asset.id)?.find(item => item.babyId === query.babyId)
          if (query.unconfirmed ? !this.needsBabyReview(membership) : query.includeCandidates ? !membership || !['included', 'candidate'].includes(membership.state) : query.candidates ? membership?.state !== 'candidate' : membership?.state !== 'included') return false
        } else if (query.candidates && !context.decisions.get(asset.id)?.some(item => item.state === 'candidate')) return false
        const faces = context.faces.get(asset.id) ?? []
        if (query.ungroupedFaces && !faces.some(face => this.ungroupedFace(face))) return false
        if (personId && !faces.some(face => face.personId && this.canonicalPersonId(face.personId, context.people) === personId)) return false
        if (query.source && !asset.locations.some(location => (query.libraryId === undefined || location.libraryId === query.libraryId) && location.source === query.source)) return false
        if (query.favorite !== undefined && asset.favorite !== query.favorite) return false
        if (query.from && (!asset.date || asset.date < query.from)) return false
        if (query.to && (!asset.date || asset.date > query.to)) return false
        if (query.dateSource && asset.dateSource !== query.dateSource) return false
        const reliableDate = Boolean(asset.dateConfirmed && asset.date && (asset.dateSource === 'capture' || asset.dateSource === 'manual') && (!baby || asset.date >= baby.birthday))
        if (query.datePending !== undefined && (query.datePending ? reliableDate : !reliableDate)) return false
        if (search && !this.mediaFilename(asset, context, query.libraryId).toLowerCase().includes(search) && !faces.some(face => face.personId && context.people.get(this.canonicalPersonId(face.personId, context.people))?.name?.toLowerCase().includes(search))) return false
        return true
      }).sort((left, right) => {
        if (!left.date && right.date) return 1
        if (left.date && !right.date) return -1
        const dates = (left.date ?? '').localeCompare(right.date ?? '')
        return (query.order === 'asc' ? dates : -dates) || left.id.localeCompare(right.id)
      })
      // 同一查询分页复用筛选与排序，归属、日期或授权变化后重新生成。
      cached = { revision, key, items, context, baby }; this.mediaQueryCache = cached
    }
    const { items, context, baby } = cached
    return { items: items.slice((page - 1) * limit, page * limit).map(asset => ({ ...this.decorated(asset, context, query.libraryId), ...(query.unconfirmed && baby ? { babyReviewReason: this.babyReviewReason(asset, baby, context) } : {}) })), total: items.length, page, limit }
  }
  /** 相似查找遍历授权范围内的全部缓存人脸，不依赖人物分组或当前已加载照片。 */
  querySimilarFaces(query: SimilarFaceQuery): SimilarFacePage {
    requireValue(query && typeof query === 'object' && !Array.isArray(query), '相似人脸查询参数无效。')
    const allowed = new Set(['assetId', 'faceId', 'scope', 'libraryId', 'page', 'limit', 'kind', 'order'])
    requireValue(Object.keys(query).every(key => allowed.has(key)), '相似人脸查找不能附带日期、收藏、人物或搜索条件。')
    requireValue(query.scope === 'library' || query.scope === 'all', '相似人脸查找范围无效。')
    requireValue(query.kind === undefined || query.kind === 'photo' || query.kind === 'video', '媒体类型无效。')
    requireValue(query.order === undefined || query.order === 'asc' || query.order === 'desc', '日期排序无效。')
    const page = query.page ?? 1, limit = query.limit ?? 50, offset = (page - 1) * limit
    requireValue(Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(offset), '相似人脸结果页码无效。')
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, '相似人脸每页数量须在 1 到 100 之间。')
    if (query.scope === 'library') this.library(textValue(query.libraryId, 80))
    else requireValue(query.libraryId === undefined, '全部授权目录查找不使用单个照片库标识。')
    const referenceAsset = this.asset(query.assetId), faceId = textValue(query.faceId, 80), context = this.decorationContext(this.store.list<FaceRecord>('familyFace'))
    const active = (location: CatalogLocation): boolean => location.available && (location.rootId ? context.roots.has(location.rootId) : Boolean(location.libraryId && context.libraries.has(location.libraryId)))
    requireValue(referenceAsset.locations.some(active), '参考照片已不在可用的授权目录中，请重新选择。')
    const reference = context.faces.get(referenceAsset.id)?.find(face => face.id === faceId)
    requireValue(reference?.assetId === referenceAsset.id && this.clearReference(reference), '参考人脸不存在、与照片不对应或不清晰，请重新选择。')
    const libraryId = query.scope === 'library' ? query.libraryId : undefined
    const assets = this.scopedAssets(libraryId).filter(asset => asset.locations.some(location => (libraryId === undefined || location.libraryId === libraryId) && active(location)))
    const covered = assets.filter(asset => !query.kind || asset.kind === query.kind), threshold = 0.4
    const coverage = { total: covered.length, done: covered.filter(asset => asset.faceState === 'done').length, pending: covered.filter(asset => asset.faceState === 'pending').length, error: covered.filter(asset => asset.faceState === 'error').length }
    const matches = assets.flatMap(asset => {
      const faces = (context.faces.get(asset.id) ?? []).filter(face => this.clearReference(face))
      const similarity = Math.max(-1, ...faces.map(face => faceSimilarity(reference.embedding, face.embedding)))
      return similarity >= threshold ? [{ asset, similarity }] : []
    }).filter(item => !query.kind || item.asset.kind === query.kind).sort((left, right) => {
      if (query.order) {
        if (!left.asset.date && right.asset.date) return 1
        if (left.asset.date && !right.asset.date) return -1
        const date = (left.asset.date ?? '').localeCompare(right.asset.date ?? '')
        if (date) return query.order === 'asc' ? date : -date
      }
      return right.similarity - left.similarity || left.asset.id.localeCompare(right.asset.id)
    })
    const items = matches.slice(offset, offset + limit).map(({ asset, similarity }) => ({ ...this.decorated(asset, context, libraryId), similarity }))
    return { items, total: matches.length, page, limit, scope: query.scope, threshold, coverage }
  }
  private async walk(root: string, onFile: (path: string, relativePath: string) => Promise<void>, onError?: (path: string, error: unknown) => void, options: { concurrency?: number; countOnly?: boolean } = {}): Promise<void> {
    requireValue(await canonicalDirectory(root) === root, '目录身份已变化，请重新选择。')
    const pending = new Set<Promise<void>>(), concurrency = options.concurrency ?? 1
    let failure: unknown
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        requireValue(!this.closed, '任务已中断。')
        if (entry.isSymbolicLink() || entry.name === '.jinchuan-incoming') continue
        const path = join(directory, entry.name), child = relative(root, path)
        try {
          if (!options.countOnly || entry.isDirectory()) await safePath(root, child)
          if (entry.isDirectory()) await visit(path)
          else if (entry.isFile() && mediaExtensions.has(extname(entry.name).toLowerCase())) {
            if (concurrency === 1) await onFile(path, child)
            else {
              // 限制在途文件数，关闭或遍历失败时先等待已开始的文件处理结束。
              const task = onFile(path, child).catch(error => {
                if (this.closed || !onError) failure ??= error
                else { try { onError(path, error) } catch (reportError) { failure ??= reportError } }
              }).then(() => { pending.delete(task) })
              pending.add(task)
              if (pending.size >= concurrency) await Promise.race(pending)
            }
          }
        } catch (error) { if (this.closed || !onError) throw error; onError(path, error) }
      }
    }
    try { await visit(root) } finally { await Promise.all(pending) }
    if (failure !== undefined) throw failure
  }
  /** 只遍历目录统计数量，不读取媒体内容；统计不完整时保留未知总量。 */
  private async countScanFiles(job: FamilyJob, directories: string[]): Promise<void> {
    job.startedAt = now(); job.scanPhase = 'counting'; job.scanTotal = 0; this.progress(job)
    let complete = true
    for (const directory of directories) {
      try {
        await this.walk(directory, async () => {
          job.scanTotal!++
          if (job.scanTotal! % 200 === 0) { this.progress(job); await pause() }
        }, () => { complete = false }, { countOnly: true })
      } catch (error) { if (this.closed) throw error; complete = false }
    }
    if (!complete) job.scanTotal = undefined
    job.scanPhase = 'processing'; job.processingStartedAt = now(); this.progress(job)
  }
  /** 旧索引无内容签名时，只从仍授权的原始副本或校验通过的元数据备份取证。 */
  private async revisionSignature(asset: CatalogAsset): Promise<string | undefined> {
    if (asset.contentSignature) return asset.contentSignature
    for (const location of asset.locations) {
      if (!this.activeLocation({ ...location, available: true })) continue
      const root = location.rootId ? this.root(location.rootId).path : this.library(location.libraryId!).path
      const candidates = [location.relativePath, relative(root, join(dirname(location.path), '.date-metadata-backup', `${basename(location.path)}.${asset.hash.slice(0, 12)}.bak`)), `${location.relativePath}_original`]
      for (const child of candidates) {
        try {
          const path = await safePath(root, child), identity = await hashFile(path)
          if (identity.hash !== asset.hash || identity.size !== asset.size) continue
          const signature = await mediaContentHash(path, asset.kind)
          if (signature) return signature
        } catch { /* 没有可信原件时保留历史记录，不能用缩略图或同名文件猜测身份。 */ }
      }
    }
    return undefined
  }
  /** 仅在编码内容与渲染属性相同时迁移人工信息，保留旧指纹记录作为历史。 */
  private inheritRevision(old: CatalogAsset, asset: CatalogAsset): void {
    const retained = old.locations.some(location => location.available)
    const babies = this.store.list<BabyProfile>('familyBaby')
    // 新记录已被人工选作参考时保留双方记录，不覆盖新的人脸选择。
    if (!retained && babies.some(baby => baby.referenceFaces.some(reference => reference.assetId === asset.id))) return
    const oldDate = this.store.get<FamilyDate & { id: string; assetId: string; updatedAt: string }>('familyDate', old.id)
    const currentDate = this.store.get<FamilyDate & { id: string; assetId: string; updatedAt: string }>('familyDate', asset.id)
    const faces = this.store.listFaceMetadata<FaceMetadata>().filter(face => face.assetId === old.id || face.assetId === asset.id).map(face => this.store.get<FaceRecord>('familyFace', face.id)!)
    const oldFaces = faces.filter(face => face.assetId === old.id), currentFaces = faces.filter(face => face.assetId === asset.id)
    this.store.transaction(() => {
      if (!asset.favoriteUpdatedAt || (old.favoriteUpdatedAt ?? '') > asset.favoriteUpdatedAt) {
        asset.favorite = old.favorite || asset.favorite; asset.favoriteUpdatedAt = old.favoriteUpdatedAt
      }
      if (oldDate && (!currentDate || oldDate.updatedAt > currentDate.updatedAt)) {
        this.store.put('familyDate', { ...oldDate, id: asset.id, assetId: asset.id })
        Object.assign(asset, { date: oldDate.date, dateSource: 'manual', dateConfirmed: true })
      }
      for (const decision of this.store.list<BabyDecision>('familyDecision').filter(decision => decision.assetId === old.id)) {
        const replacement = { ...decision, id: `${decision.babyId}:${asset.id}`, assetId: asset.id }, current = this.store.get<BabyDecision>('familyDecision', replacement.id)
        const replace = !current || (decision.origin === 'manual' && (current.origin !== 'manual' || decision.updatedAt > current.updatedAt)) || (decision.origin !== 'manual' && current.origin !== 'manual')
        if (replace) { if (current) this.store.archive('familyDecision', current.id); this.store.put('familyDecision', replacement) }
      }
      if (!retained) {
        if (old.faceState === 'done' || oldFaces.length) {
          for (const face of currentFaces) this.store.archive('familyFace', face.id)
          for (const face of oldFaces) this.store.put('familyFace', { ...face, assetId: asset.id })
          asset.faceState = old.faceState; asset.faceError = old.faceError
          asset.faceFrames = old.faceFrames; asset.faceSupplementVersion = old.faceSupplementVersion; asset.faceSupplementing = old.faceSupplementing
        }
        for (const baby of babies) if (baby.referenceFaces.some(reference => reference.assetId === old.id) || baby.avatarAssetId === old.id) {
          this.store.put('familyBaby', { ...baby, referenceFaces: baby.referenceFaces.map(reference => reference.assetId === old.id ? { ...reference, assetId: asset.id } : reference), ...(baby.avatarAssetId === old.id ? { avatarAssetId: asset.id } : {}) })
        }
        this.store.put('familyAsset', { ...old, supersededById: asset.id })
      }
      asset.reconciledRevisionIds = [...(asset.reconciledRevisionIds ?? []), old.id]
      this.store.put('familyAsset', asset)
    })
    if (!retained) this.assets.set(old.id, { ...old, supersededById: asset.id })
    this.assets.set(asset.id, asset)
  }
  /** 重扫也能恢复早期版本留下的失效旧卡片，只比较同一授权位置的历史。 */
  private async reconcileRevisions(asset: CatalogAsset, location: CatalogLocation): Promise<void> {
    if (!asset.contentSignature || this.rebuilding || this.store.list<FamilyJob>('familyJob').some(job => job.kind === 'faces' && job.state === 'running')) return
    const key = locationId(location.path, location.rootId, location.libraryId)
    for (const oldId of this.locationHistory.get(key) ?? []) {
      const previous = this.assets.get(oldId)
      if (!previous || previous.id === asset.id || previous.supersededById || previous.kind !== asset.kind || asset.reconciledRevisionIds?.includes(oldId)) continue
      if (await this.revisionSignature(previous) !== asset.contentSignature) continue
      if (this.rebuilding || this.store.list<FamilyJob>('familyJob').some(job => job.kind !== 'scan' && job.state === 'running')) return
      const latest = this.assets.get(asset.id), latestPrevious = this.assets.get(oldId) ?? previous
      if (latest?.favoriteUpdatedAt) { asset.favorite = latest.favorite; asset.favoriteUpdatedAt = latest.favoriteUpdatedAt }
      const old = { ...latestPrevious, locations: latestPrevious.locations.map(entry => locationId(entry.path, entry.rootId, entry.libraryId) === key ? { ...entry, available: false, unavailableReason: 'changed' as const } : entry) }
      this.inheritRevision(old, asset)
    }
  }
  /** 同一内容只建立一条资产记录，位置和上传回执保持各自的证据。 */
  private async indexFile(path: string, location: Omit<CatalogLocation, 'id' | 'path' | 'mtime' | 'available'>, supplied?: MediaMetadata, identity?: { hash: string; size: number; mtime: number }, createThumbnail = true): Promise<CatalogAsset> {
    const current = identity ?? await hashFile(path)
    localMediaIdentity(current)
    const id = idFor(current.hash, current.size), kind = mediaKind(path), existing = this.assets.get(id)
    // 完整内容指纹一致且日期已确认时复用元数据，未知日期仍重读以保留补齐机会。
    const metadata = supplied ?? (existing && (existing.dateSource === 'manual' || existing.dateConfirmed) ? existing : await readMetadata(path, kind))
    const item: CatalogLocation = { ...location, id: locationId(path, location.rootId, location.libraryId), path, mtime: current.mtime, available: true }
    const previousAssetId = this.locationAssets.get(item.id), old = previousAssetId && previousAssetId !== id ? this.assets.get(previousAssetId) : undefined
    const sameLocation = (entry: CatalogLocation) => locationId(entry.path, entry.rootId, entry.libraryId) === item.id
    if (old) this.putAsset({ ...old, locations: old.locations.map(entry => sameLocation(entry) ? { ...entry, available: false, unavailableReason: 'changed' } : entry) })
    const corrected = this.store.get<{ id: string; date: string; updatedAt: string }>('familyDate', id)
    const asset: CatalogAsset = existing ? { ...existing } : { id, hash: current.hash, size: current.size, filename: basename(path), kind, ...metadata, dateConfirmed: metadata.dateSource === 'capture', available: true, locations: [], babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'pending', updatedAt: now() }
    if (corrected) Object.assign(asset, { date: corrected.date, dateSource: 'manual', dateConfirmed: true })
    if (existing && asset.dateSource !== 'manual' && !asset.dateConfirmed && metadata.captureDate) Object.assign(asset, metadata, { dateConfirmed: true })
    asset.locations = [...asset.locations.filter(entry => !sameLocation(entry)), item]
    if (asset.supersededById) delete asset.reconciledRevisionIds
    delete asset.supersededById
    asset.available = true; asset.updatedAt = now()
    if (asset.contentSignature === undefined) asset.contentSignature = await mediaContentHash(path, kind) ?? null
    if (createThumbnail && !asset.thumbnailPath) {
      const output = join(this.cacheDirectory, 'thumbs', `${id}.jpg`)
      try { await thumbnail(path, kind, output); asset.thumbnailPath = output } catch { /* 缩略图失败不影响原图索引及备份回执。 */ }
    }
    const latest = this.assets.get(id)
    if (latest && latest !== existing) {
      asset.locations = [...latest.locations.filter(entry => !sameLocation(entry)), item]
      asset.favorite = latest.favorite
      if (latest.dateSource === 'manual') { asset.date = latest.date; asset.dateSource = latest.dateSource; asset.dateConfirmed = true }
      else if (latest.captureDate && !asset.captureDate) { asset.captureDate = latest.captureDate; asset.date = latest.date; asset.dateSource = latest.dateSource; asset.dateConfirmed = latest.dateConfirmed }
      asset.faceState = latest.faceState; asset.faceError = latest.faceError
      asset.faceFrames = latest.faceFrames
      asset.faceSupplementVersion = latest.faceSupplementVersion; asset.faceSupplementing = latest.faceSupplementing
      asset.thumbnailPath = latest.thumbnailPath ?? asset.thumbnailPath
    }
    // 内容已完整校验，业务字段与位置未变化时避免重写资产和使浏览缓存失效。
    const storedAsset = latest ?? existing
    await this.reconcileRevisions(asset, item)
    if (storedAsset && JSON.stringify({ ...asset, updatedAt: storedAsset.updatedAt }) === JSON.stringify(storedAsset)) return storedAsset
    this.putAsset(asset)
    return asset
  }
  scanMedia(libraryId?: string): void {
    const scopedLibrary = libraryId === undefined ? undefined : this.library(libraryId)
    this.startJob('scan', '读取已授权的照片和视频目录', async job => {
      job.sourceFiles = 0; job.uniqueMedia = 0
      const roots = scopedLibrary ? [] : this.store.list<ScanRoot>('root').filter(root => root.enabled), libraries = scopedLibrary ? [scopedLibrary] : this.store.list<Library>('library').filter(library => library.enabled)
      await this.countScanFiles(job, [...roots, ...libraries].map(directory => directory.path))
      const contents = new Set<string>()
      const scannedFile = (path: string, identity: { hash: string; size: number }): void => {
        const content = idFor(identity.hash, identity.size)
        if (contents.has(content)) job.duplicates = (job.duplicates ?? 0) + 1
        else contents.add(content)
        job.uniqueMedia = contents.size
        job.processed++; job.total = Math.max(job.total, job.processed + (job.skipped ?? 0)); this.progress(job, basename(path))
      }
      for (const root of roots) {
        const seen = new Set<string>(), skippedBefore = job.skipped ?? 0
        this.store.put('root', { ...root, state: 'scanning', count: 0, error: '' })
        let state = 'ready', error = ''
        try {
          await this.walk(root.path, async (path, child) => {
            job.sourceFiles = (job.sourceFiles ?? 0) + 1
            const identity = await hashFile(path)
            // 扫描先保存索引，缩略图复用浏览入口按需生成，避免等待整库图片解码。
            await this.contentSerial(`catalog:${identity.hash}:${identity.size}`, () => this.indexFile(path, { rootId: root.id, relativePath: child, source: 'folder', label: basename(root.path) }, undefined, identity, false))
            this.store.db.prepare('INSERT INTO locations VALUES(?,?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,mtime=excluded.mtime WHERE locations.hash!=excluded.hash OR locations.size!=excluded.size OR locations.mtime!=excluded.mtime').run(root.id, path, identity.hash, identity.size, identity.mtime)
            seen.add(locationId(path, root.id)); scannedFile(path, identity); await pause()
          }, (path, failure) => this.skip(job, path, failure), { concurrency: 2 })
          const skipped = (job.skipped ?? 0) - skippedBefore
          if (skipped) { state = 'partial'; error = `${skipped} 项未能读取，不能视为完整扫描。` }
          else for (const asset of this.assets.values()) if (asset.locations.some(location => location.rootId === root.id && !seen.has(locationId(location.path, location.rootId, location.libraryId)))) this.putAsset({ ...asset, locations: asset.locations.map(location => location.rootId === root.id && !seen.has(locationId(location.path, location.rootId, location.libraryId)) ? { ...location, available: false } : location) })
        } catch (failure) {
          if (this.closed) throw failure
          this.skip(job, root.path, failure); state = 'unavailable'; error = '目录不可访问或身份已变化，请检查后重试。'
          for (const asset of this.assets.values()) if (asset.locations.some(location => location.rootId === root.id)) this.putAsset({ ...asset, locations: asset.locations.map(location => location.rootId === root.id ? { ...location, available: false } : location) })
        }
        const latestRoot = this.store.get<ScanRoot>('root', root.id)
        this.store.put('root', { ...root, enabled: latestRoot?.enabled ?? false, state, count: seen.size, scannedAt: now(), error })
      }
      for (const library of libraries) {
        const seen = new Set<string>()
        const skippedBefore = job.skipped ?? 0
        try {
          await this.walk(library.path, async (path, child) => {
            job.sourceFiles = (job.sourceFiles ?? 0) + 1
            const identity = await hashFile(path), saved = this.store.content<Receipt>(library.id, identity.hash, identity.size)
            const receipt = saved?.relativePath === child ? saved : undefined
            const existing = this.assets.get(idFor(identity.hash, identity.size))
            const metadata = receipt && (!existing || (existing.dateSource !== 'manual' && !existing.dateConfirmed)) ? await readMetadata(path, mediaKind(path), receipt.captureDate, receipt.creationDate) : undefined
            await this.contentSerial(`catalog:${identity.hash}:${identity.size}`, () => this.indexFile(path, { libraryId: library.id, receiptId: receipt?.id, relativePath: child, source: receipt?.source ?? (receipt ? 'phone' : 'folder'), label: library.name }, metadata, identity, false))
            seen.add(locationId(path, undefined, library.id))
            scannedFile(path, identity); await pause()
          }, (path, failure) => this.skip(job, path, failure), { concurrency: 2 })
          if ((job.skipped ?? 0) === skippedBefore) for (const asset of this.assets.values()) if (asset.locations.some(location => location.libraryId === library.id && !seen.has(locationId(location.path, location.rootId, location.libraryId)))) this.putAsset({ ...asset, locations: asset.locations.map(location => location.libraryId === library.id && !seen.has(locationId(location.path, location.rootId, location.libraryId)) ? { ...location, available: false } : location) })
        } catch (failure) {
          if (this.closed) throw failure
          this.skip(job, library.path, failure)
          for (const asset of this.assets.values()) if (asset.locations.some(location => location.libraryId === library.id)) this.putAsset({ ...asset, locations: asset.locations.map(location => location.libraryId === library.id ? { ...location, available: false } : location) })
        }
      }
    }, libraryId, 'library')
  }
  private publicPlan(plan: StoredPlan): ImportPlan & { state: StoredPlan['state']; error?: string } {
    const { items: _, createdAt: __, ...visible } = plan
    return visible
  }
  /** 预扫描固定源文件日期及目标路径，后续重试不会改用复制后的创建时间。 */
  prepareImport(rootId: string, mode: 'index' | 'copy', libraryId?: string): ImportPlan {
    const root = this.root(rootId)
    requireValue(mode === 'index' || mode === 'copy', '导入模式无效。')
    if (mode === 'copy' && libraryId === undefined) libraryId = this.store.get<{id: string; libraryId: string | null}>('workspace', 'current-library')?.libraryId ?? undefined
    if (mode === 'copy') this.assertCopyDirectories(root, this.library(libraryId ?? ''))
    const plan: StoredPlan = { id: randomUUID(), rootId, mode, libraryId: mode === 'copy' ? libraryId : undefined, count: 0, bytes: 0, unknownDates: 0, creationDates: 0, sourceFiles: 0, uniqueMedia: 0, duplicates: 0, preview: [], state: 'preparing', items: [], createdAt: now() }
    const job = this.startJob('scan', '预扫描电脑文件夹并冻结归档日期', async job => {
      const contents = new Set<string>(); job.sourceFiles = 0; job.uniqueMedia = 0
      try {
        await this.countScanFiles(job, [root.path])
        await this.walk(root.path, async (path, child) => {
          plan.sourceFiles = (plan.sourceFiles ?? 0) + 1; job.sourceFiles = plan.sourceFiles
          const identity = await hashFile(path)
          localMediaIdentity(identity)
          const metadata = await readMetadata(path, mediaKind(path))
          const corrected = this.store.get<FamilyDate & { id: string }>('familyDate', idFor(identity.hash, identity.size))
          if (corrected) { metadata.date = corrected.date; metadata.dateSource = 'manual' }
          const filename = basename(path), archivePath = `${metadata.date ?? '日期待确认'}/${archiveName(filename, identity.hash, plan.id)}`
          plan.items.push({ path, relativePath: child, filename, size: identity.size, mtime: identity.mtime, hash: identity.hash, metadata, archivePath })
          const content = idFor(identity.hash, identity.size)
          if (contents.has(content)) { plan.duplicates = (plan.duplicates ?? 0) + 1; job.duplicates = plan.duplicates } else contents.add(content)
          plan.uniqueMedia = contents.size; job.uniqueMedia = contents.size
          plan.count++; plan.bytes += identity.size; plan.unknownDates += metadata.date ? 0 : 1; plan.creationDates += metadata.dateSource === 'creation' ? 1 : 0
          if (plan.preview.length < 100) plan.preview.push({ filename, date: metadata.date, dateSource: metadata.dateSource, relativePath: archivePath })
          job.processed = plan.count; job.total = plan.count + (job.skipped ?? 0); this.progress(job, filename)
          if (plan.count % 25 === 0) this.store.put('familyPlan', plan)
          await pause()
        }, (path, failure) => this.skip(job, path, failure, plan))
        plan.state = 'ready'; this.store.put('familyPlan', plan)
      } catch (error) { plan.state = 'error'; plan.error = errorMessage(error); this.store.put('familyPlan', plan); throw error }
    }, plan.libraryId, 'import-preview')
    this.store.put('familyPlan', plan)
    this.progress(job)
    return this.publicPlan(plan)
  }
  executeImport(planId: string): void {
    const plan = this.store.get<StoredPlan>('familyPlan', textValue(planId, 80))
    requireValue(plan?.state === 'ready', '请等待预扫描完成，检查计划后再开始。')
    const root = this.root(plan.rootId), library = plan.mode === 'copy' ? this.library(plan.libraryId!) : undefined
    if (library) this.assertCopyDirectories(root, library)
    this.startJob('import', plan.mode === 'copy' ? '复制原文件并按日期归档' : '建立来源目录索引', async job => {
      const contents = new Set<string>(); job.total = plan.items.length; job.sourceFiles = plan.items.length; job.uniqueMedia = 0; this.progress(job)
      for (const item of plan.items) {
        requireValue(!this.closed, '导入已中断。')
        const currentRoot = this.root(plan.rootId), currentLibrary = library ? this.library(library.id) : undefined
        if (currentLibrary) this.assertCopyDirectories(currentRoot, currentLibrary)
        requireValue(currentRoot.path === root.path && (!library || currentLibrary?.path === library.path), '来源或目标目录配置已变化，请重新预扫描。', 409)
        // 目录授权和身份变化终止批次；单个媒体的读取、校验或复制失败继续处理下一项。
        requireValue(await canonicalDirectory(root.path) === root.path, '来源目录身份已变化，请重新选择。', 409)
        if (library) requireValue(await canonicalDirectory(library.path) === library.path, '归档目录身份已变化，请重新选择。', 409)
        try {
          const path = await safePath(root.path, item.relativePath)
          if (library) await safePath(library.path, item.archivePath)
          const sourceStat = await stat(path)
          requireValue(sourceStat.size === item.size && sourceStat.mtimeMs === item.mtime, `源文件已变化，请重新预扫描：${item.filename}`, 409)
          const identity = await hashFile(path)
          requireValue(!item.hash || item.hash === identity.hash, `源内容已变化，请重新预扫描：${item.filename}`, 409)
          await this.indexFile(path, { rootId: root.id, relativePath: item.relativePath, source: 'folder', label: basename(root.path) }, item.metadata, identity)
          if (library) {
            await this.contentSerial(`content:${library.id}:${identity.hash}`, async () => {
              const recorded = this.store.content<Receipt>(library.id, identity.hash, identity.size)
              let receipt = recorded
              if (receipt) {
                try { const present = await hashFile(await safePath(library.path, receipt.relativePath)); if (present.hash !== identity.hash || present.size !== identity.size) receipt = undefined } catch { receipt = undefined }
              }
              if (!receipt) {
                const disk = await statfs(library.path)
                requireValue(disk.bavail * disk.bsize > item.size + 16 * 1024 ** 2, '归档目录可用空间不足。', 507)
                let child = item.archivePath, destination = await safePath(library.path, child)
                await mkdir(join(destination, '..'), { recursive: true }); await safePath(library.path, child)
                try { await copyFile(path, destination, constants.COPYFILE_EXCL) }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                  const existing = await hashFile(destination)
                  if (existing.hash !== identity.hash || existing.size !== identity.size) {
                    child = `${item.metadata.date ?? '日期待确认'}/${archiveName(item.filename, identity.hash, randomUUID())}`
                    destination = await safePath(library.path, child); await copyFile(path, destination, constants.COPYFILE_EXCL)
                  }
                }
                const handle = await open(destination, 'r+')
                try { await handle.sync() } finally { await handle.close() }
                const saved = await hashFile(destination)
                requireValue(saved.hash === identity.hash && saved.size === identity.size, '复制后内容校验失败，未记录归档成功。', 422)
                receipt = { id: recorded?.id ?? randomUUID(), receiverId: this.receiverId, libraryId: library.id, hash: identity.hash, size: identity.size, relativePath: child, filename: item.filename, savedAt: now(), captureDate: item.metadata.captureDate, creationDate: item.metadata.creationDate, source: 'folder', kind: mediaKind(path) }
                this.store.put('file', receipt)
                if (recorded) for (const asset of this.assets.values()) if (asset.locations.some(location => location.receiptId === recorded.id && location.libraryId === library.id && location.relativePath !== child)) this.putAsset({ ...asset, locations: asset.locations.map(location => location.receiptId === recorded.id && location.libraryId === library.id && location.relativePath !== child ? { ...location, available: false } : location) })
              }
              const savedPath = await safePath(library.path, receipt.relativePath)
              await this.indexFile(savedPath, { libraryId: library.id, receiptId: receipt.id, relativePath: receipt.relativePath, source: 'folder', label: library.name }, item.metadata)
            })
          }
          const content = idFor(identity.hash, identity.size)
          if (contents.has(content)) job.duplicates = (job.duplicates ?? 0) + 1; else contents.add(content)
          job.uniqueMedia = contents.size; job.processed++
        } catch (error) { if (this.closed) throw error; this.skip(job, join(root.path, item.relativePath), error) }
        this.progress(job, item.filename); await pause()
      }
    }, plan.libraryId)
  }
  /** 上传回执提交后再建立相册索引，解码失败不改变上传结果。 */
  recordReceipt(receipt: Receipt): void {
    if (this.closed) return
    const task = (async () => {
      const library = this.library(receipt.libraryId), path = await safePath(library.path, receipt.relativePath)
      const metadata = await readMetadata(path, mediaKind(path), receipt.captureDate, receipt.creationDate)
      await this.indexFile(path, { libraryId: library.id, receiptId: receipt.id, relativePath: receipt.relativePath, source: receipt.source ?? 'phone', label: library.name }, metadata)
      this.requestAutomaticFaces(library.id)
    })().catch(() => { /* 相册可重新扫描补齐，原图成功回执不受影响。 */ }).finally(() => this.tasks.delete(task))
    this.tasks.add(task)
  }
  async mediaPath(assetId: string, useThumbnail = false, libraryId?: string): Promise<string> {
    const asset = this.asset(assetId)
    if (libraryId !== undefined) {
      this.library(libraryId)
      requireValue(asset.locations.some(location => location.libraryId === libraryId), '这张照片或视频不在所选照片库中。', 404)
    }
    let refreshed = false
    for (const location of asset.locations.filter(item => (libraryId === undefined || item.libraryId === libraryId) && this.activeLocation({ ...item, available: true })).sort((left, right) => Number(right.available) - Number(left.available))) {
      let path: string
      try {
        const root = location.rootId ? this.root(location.rootId).path : this.library(location.libraryId!).path
        path = await safePath(root, location.relativePath)
        const info = await stat(path)
        requireValue(info.isFile(), '原文件位置不再是普通文件。', 409)
        if (info.size !== asset.size || info.mtimeMs !== location.mtime || !location.available) {
          const identity = await hashFile(path)
          if (identity.hash !== asset.hash || identity.size !== asset.size) {
            location.available = false; location.unavailableReason = 'changed'; this.putAsset(asset)
            if (!this.rebuilding && !this.store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) {
              const saved = location.libraryId ? this.store.content<Receipt>(location.libraryId, identity.hash, identity.size) : undefined
              const receipt = saved?.relativePath === location.relativePath ? saved : undefined
              await this.contentSerial(`catalog:${identity.hash}:${identity.size}`, () => this.indexFile(path, { rootId: location.rootId, libraryId: location.libraryId, relativePath: location.relativePath, source: receipt?.source ?? 'folder', label: location.label, receiptId: receipt?.id }, undefined, identity, false))
              refreshed = true
            }
            continue
          }
          location.mtime = identity.mtime; location.available = true; delete location.unavailableReason; this.putAsset(asset)
        }
      } catch (error) {
        location.available = false; location.unavailableReason = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable'; this.putAsset(asset); continue
      }
      if (useThumbnail) {
        const output = asset.thumbnailPath ?? join(this.cacheDirectory, 'thumbs', `${asset.id}.jpg`)
        const authorized = await safePath(this.dataDirectory, relative(this.dataDirectory, output))
        let present = false
        try { present = (await stat(authorized)).isFile() } catch { /* 缓存丢失时重新生成，不把原文件标为缺失。 */ }
        if (!present) {
          // 同内容并发请求只生成一次，并合入最新记录，保留生成期间的人工修改与识别进度。
          await this.contentSerial(`thumbnail:${asset.id}`, async () => {
            try { if ((await stat(authorized)).isFile()) return } catch { /* 上一个请求尚未生成缓存时继续处理。 */ }
            await thumbnail(path, asset.kind, authorized)
            this.putAsset({ ...this.asset(asset.id), thumbnailPath: authorized })
          })
        }
        return authorized
      }
      return path
    }
    throw new Error(refreshed ? '原文件信息已更新，相册将自动刷新，请重新打开。' : asset.locations.some(location => location.unavailableReason === 'changed') ? '原文件已变化，请在当前处理任务结束后重新扫描。' : '照片或视频所在目录不可用，请连接原目录或重新扫描。')
  }
  /** 档案与本地头像只修改记录，识别配置改变时才启动重新匹配。 */
  saveBaby(value: BabyProfile, matchScope?: 'library' | 'all'): void {
    requireValue(!this.rebuilding, '人脸索引正在重建，请完成后再编辑宝宝档案。', 409)
    requireValue(value && typeof value === 'object', '宝宝档案参数无效。')
    requireValue(matchScope === undefined || matchScope === 'library' || matchScope === 'all', '宝宝匹配范围无效。')
    const id = value.id ? textValue(value.id, 80) : randomUUID(), previous = this.store.get<BabyProfile>('familyBaby', id)
    requireValue(/^[a-zA-Z0-9-]{1,80}$/.test(id), '宝宝标识无效。')
    requireValue(validDate(value.birthday) && value.birthday <= localDate(), '请填写有效的宝宝出生日期。')
    requireValue(typeof value.autoMatch === 'boolean' && Array.isArray(value.referenceFaces) && value.referenceFaces.length <= 20, '宝宝参考人脸参数无效。')
    const referenceFaces: BabyProfile['referenceFaces'] = []
    for (const reference of value.referenceFaces) {
      requireValue(reference && typeof reference === 'object', '参考人脸参数无效。')
      const faceId = textValue(reference.faceId, 80), assetId = textValue(reference.assetId, 80)
      const face = this.store.get<FaceRecord>('familyFace', faceId)
      const retained = previous?.referenceFaces.some(item => item.assetId === assetId && item.faceId === faceId)
      requireValue(face?.assetId === assetId || !face && retained, '新参考人脸不存在或与照片不匹配。')
      if (!referenceFaces.some(item => item.assetId === assetId && item.faceId === faceId)) referenceFaces.push({ assetId, faceId })
    }
    let avatarAssetId: string | undefined
    if (value.avatarAssetId !== undefined) {
      const avatar = this.asset(value.avatarAssetId)
      requireValue(avatar.kind === 'photo', '宝宝头像只能使用照片。')
      requireValue(previous?.avatarAssetId === avatar.id || avatar.locations.some(location => this.activeLocation(location)), '头像照片所在目录不可用或未授权。')
      avatarAssetId = avatar.id
    }
    const baby: BabyProfile = { id, name: textValue(value.name.trim(), 40), birthday: value.birthday, autoMatch: value.autoMatch, referenceFaces, ...(avatarAssetId ? { avatarAssetId } : {}), updatedAt: now() }
    this.store.put('familyBaby', baby)
    const referenceChanged = JSON.stringify(previous?.referenceFaces ?? []) !== JSON.stringify(referenceFaces)
    if (referenceChanged || previous?.autoMatch !== baby.autoMatch) {
      this.refreshBabyMatches(baby, matchScope)
      this.ensureAutomaticFaces(this.store.get<{ id: string; libraryId: string | null }>('workspace', 'current-library')?.libraryId ?? undefined)
    }
  }
  /** 档案编辑和跨端同步使用一致的识别开关，人工归属始终保留。 */
  private refreshBabyMatches(baby: BabyProfile, scope?: 'library' | 'all'): void {
    if (!baby.referenceFaces.length && !this.store.list<BabyDecision>('familyDecision').some(item => item.babyId === baby.id && item.origin === 'recognition')) { this.babyMatchVersions.set(baby.id, (this.babyMatchVersions.get(baby.id) ?? 0) + 1); this.babyMatching.delete(baby.id); return }
    const libraryId = scope === 'all' ? undefined : this.store.get<{ id: string; libraryId: string | null }>('workspace', 'current-library')?.libraryId ?? undefined
    if (libraryId !== undefined && !this.store.get<Library>('library', libraryId)?.enabled) { this.babyMatchVersions.set(baby.id, (this.babyMatchVersions.get(baby.id) ?? 0) + 1); return }
    const assetIds = new Set(this.scopedAssets(libraryId).map(asset => asset.id))
    if (this.rebuilding || this.pendingFaceRebuilds().some(rebuild => rebuild.assetIds.some(id => assetIds.has(id)))) { this.babyMatchVersions.set(baby.id, (this.babyMatchVersions.get(baby.id) ?? 0) + 1); this.babyMatching.delete(baby.id); return }
    this.beginBabyMatching(baby, libraryId, libraryId ? 'library' : 'all')
  }
  /** 保存人工归属并返回本次修改的浏览版本，局部界面可核对缓存是否完整。 */
  setBabyMembership(babyId: string, assetIds: string[], included: boolean): BrowseMutation {
    this.baby(babyId); requireValue(Array.isArray(assetIds) && assetIds.length <= 10000 && typeof included === 'boolean', '相册归属参数无效。')
    const before = this.store.browseRevision
    this.store.transaction(() => { for (const assetId of assetIds) { this.asset(assetId); this.store.put('familyDecision', { id: `${babyId}:${assetId}`, babyId, assetId, state: included ? 'included' : 'excluded', origin: 'manual', updatedAt: now() } satisfies BabyDecision) } })
    return { before, after: this.store.browseRevision }
  }
  setMediaDate(assetId: string, date: string): void {
    const asset = this.asset(assetId); requireValue(validDate(date), '日期无效。')
    const updatedAt = now()
    this.store.put('familyDate', { id: assetId, assetId, date, updatedAt })
    this.putAsset({ ...asset, date, dateSource: 'manual', dateConfirmed: true, updatedAt })
  }
  /** 更新收藏并返回修改前后版本，避免局部更新掩盖其他记录变化。 */
  setFavorite(assetId: string, favorite: boolean): BrowseMutation {
    requireValue(typeof favorite === 'boolean', '收藏参数无效。')
    const before = this.store.browseRevision
    const updatedAt = now()
    this.putAsset({ ...this.asset(assetId), favorite, favoriteUpdatedAt: updatedAt, updatedAt })
    return { before, after: this.store.browseRevision }
  }
  /** 重建只替换当前库的派生人脸索引，完整备份完成后才清除旧记录。 */
  async rebuildFaceIndex(libraryId: string): Promise<void> {
    this.personGroupingContext(libraryId)
    const library = this.library(libraryId)
    requireValue(await canonicalDirectory(library.path) === library.path, '当前照片库目录身份已变化，请重新选择。', 409)
    this.model = await this.engine.ready(); requireValue(this.model.ready, this.model.error || '本地人物模型不可用。')
    this.personGroupingContext(libraryId)
    const previous = this.store.get<FaceIndexRebuild>('familyRebuild', libraryId)
    const rebuild: FaceIndexRebuild = previous && previous.phase !== 'done' ? previous : { id: libraryId, epoch: randomUUID(), assetIds: this.scopedAssets(libraryId).map(asset => asset.id), annotations: previous?.annotations.filter(annotation => !annotation.newFaceId) ?? [], phase: 'preparing', backupPath: join(this.dataDirectory, 'face-index-backups', `${Date.now()}-${randomUUID()}.sqlite`), updatedAt: now() }
    const assets = rebuild.assetIds.flatMap(id => { const asset = this.assets.get(id); return asset && (rebuild.phase === 'preparing' || asset.faceState !== 'done') ? [asset] : [] })
    this.analyzeSelectedFaces(assets, libraryId, '重新检测照片头像并重建人物索引', false, false, rebuild)
  }
  /** 几何书签不保存旧向量，新检测排序变化时按同帧唯一重叠恢复人工标注。 */
  private restoreRebuildAnnotations(rebuild: FaceIndexRebuild, assetId: string, faces: FaceRecord[]): void {
    const annotations = rebuild.annotations.filter(annotation => annotation.assetId === assetId)
    const overlap = (annotation: RebuildAnnotation, face: FaceRecord): number => {
      if (annotation.frameTime !== face.frameTime) return 0
      const width = Math.max(0, Math.min(annotation.x + annotation.width, face.x + face.width) - Math.max(annotation.x, face.x))
      const height = Math.max(0, Math.min(annotation.y + annotation.height, face.y + face.height) - Math.max(annotation.y, face.y))
      const intersection = width * height, union = annotation.width * annotation.height + face.width * face.height - intersection
      return union > 0 ? intersection / union : 0
    }
    this.store.transaction(() => {
      for (const annotation of annotations) {
        const candidates = faces.filter(face => this.clearReference(face) && overlap(annotation, face) >= 0.6)
        if (candidates.length !== 1 || annotations.filter(other => overlap(other, candidates[0]) >= 0.6).length !== 1) continue
        const face = candidates[0]
        annotation.newFaceId = face.id
        if (annotation.personId && this.store.get<PersonRecord>('familyPerson', annotation.personId) && !faces.some(other => other.id !== face.id && other.personId === annotation.personId && other.frameTime === face.frameTime)) {
          face.personId = annotation.personId; this.store.put('familyFace', face)
        }
        for (const baby of this.store.list<BabyProfile>('familyBaby')) if (baby.referenceFaces.some(reference => reference.assetId === assetId && reference.faceId === annotation.oldFaceId)) this.store.put('familyBaby', { ...baby, referenceFaces: baby.referenceFaces.map(reference => reference.assetId === assetId && reference.faceId === annotation.oldFaceId ? { assetId, faceId: face.id } : reference), updatedAt: now() })
      }
      rebuild.updatedAt = now(); this.store.put('familyRebuild', rebuild)
    })
  }
  /** 备份校验及几何书签持久化先于原子清空，未涉及的库保留全部人脸关系。 */
  private async prepareFaceRebuild(rebuild: FaceIndexRebuild, job: FamilyJob): Promise<void> {
    this.progress(job, '备份完整索引并校验；原照片和视频保留')
    await mkdir(join(this.dataDirectory, 'face-index-backups'), { recursive: true })
    requireValue(!this.closed, '人脸重建已中断。')
    this.store.backup(rebuild.backupPath)
    const assetIds = new Set(rebuild.assetIds), faces = this.store.list<FaceRecord>('familyFace'), people = new Map(this.store.list<PersonRecord>('familyPerson').map(person => [person.id, person]))
    const protectedIds = this.protectedPeople(people)
    for (const person of people.values()) if (person.name || person.mergedIntoId && person.mergeOrigin !== 'automatic') { protectedIds.add(person.id); protectedIds.add(this.canonicalPersonId(person.id, people)) }
    // 人工别名链保持完整，避免命名人物的根或中间节点成为悬空引用。
    for (const person of people.values()) if (protectedIds.has(person.id)) { let current = person; const seen = new Set<string>(); while (current.mergedIntoId && !seen.has(current.id)) { seen.add(current.id); protectedIds.add(current.mergedIntoId); const parent = people.get(current.mergedIntoId); if (!parent) break; current = parent } }
    const referenceIds = new Set(this.store.list<BabyProfile>('familyBaby').flatMap(baby => baby.referenceFaces.filter(reference => assetIds.has(reference.assetId)).map(reference => reference.faceId)))
    const retainedAnnotations = rebuild.annotations.filter(annotation => assetIds.has(annotation.assetId) && (referenceIds.has(annotation.oldFaceId) || Boolean(annotation.personId && protectedIds.has(annotation.personId))))
    rebuild.annotations = faces.filter(face => assetIds.has(face.assetId) && (referenceIds.has(face.id) || Boolean(face.personId && protectedIds.has(this.canonicalPersonId(face.personId, people))))).map(face => ({ oldFaceId: face.id, assetId: face.assetId, x: face.x, y: face.y, width: face.width, height: face.height, ...(face.frameTime !== undefined ? { frameTime: face.frameTime } : {}), ...(face.personId && protectedIds.has(this.canonicalPersonId(face.personId, people)) ? { personId: this.canonicalPersonId(face.personId, people) } : {}) }))
    for (const annotation of retainedAnnotations) if (!rebuild.annotations.some(current => current.oldFaceId === annotation.oldFaceId)) rebuild.annotations.push(annotation)
    const remainingFaces = faces.filter(face => !assetIds.has(face.assetId)), usedPeople = new Set(remainingFaces.flatMap(face => face.personId ? [face.personId, this.canonicalPersonId(face.personId, people)] : []))
    for (const person of people.values()) if (usedPeople.has(person.id)) { let current = person; const seen = new Set<string>(); while (current.mergedIntoId && !seen.has(current.id)) { seen.add(current.id); usedPeople.add(current.mergedIntoId); const parent = people.get(current.mergedIntoId); if (!parent) break; current = parent } }
    const resetAssets = rebuild.assetIds.flatMap(id => { const asset = this.assets.get(id); return asset ? [{ ...asset, faceState: 'pending' as const, faceError: undefined, faceFrames: [], faceSupplementVersion: undefined, faceSupplementing: undefined, faces: [], personIds: [], updatedAt: now() }] : [] })
    rebuild.phase = 'detecting'; rebuild.updatedAt = now()
    this.store.transaction(() => {
      this.store.put('familyRebuild', rebuild)
      for (const face of faces) if (assetIds.has(face.assetId)) this.store.remove('familyFace', face.id)
      for (const person of people.values()) {
        if (!usedPeople.has(person.id) && !protectedIds.has(person.id)) this.store.remove('familyPerson', person.id)
        else if (!usedPeople.has(person.id) && protectedIds.has(person.id)) this.store.put('familyPerson', { ...person, embedding: [] })
      }
      for (const asset of resetAssets) this.store.put('familyAsset', asset)
      for (const decision of this.store.list<BabyDecision>('familyDecision')) if (assetIds.has(decision.assetId) && decision.origin === 'recognition') this.store.put('familyDecision', { ...decision, state: 'unconfirmed', score: undefined, updatedAt: now() })
    })
    for (const asset of resetAssets) this.assets.set(asset.id, asset)
    this.personGroupingPlans.clear(); this.personGroupingUndos.clear()
    for (const baby of this.store.list<BabyProfile>('familyBaby')) { this.babyMatchVersions.set(baby.id, (this.babyMatchVersions.get(baby.id) ?? 0) + 1); this.babyMatching.delete(baby.id) }
    this.progress(job, '旧照片头像索引已清除，开始从原媒体重新检测')
  }
  /** 全部新特征生成后统一归组，进度让出线程且外部照片的人物关联保持原样。 */
  private async finishFaceRebuild(rebuild: FaceIndexRebuild, job: FamilyJob): Promise<void> {
    rebuild.phase = 'grouping'; rebuild.updatedAt = now(); this.store.put('familyRebuild', rebuild)
    const faces = this.store.list<FaceRecord>('familyFace'), people = this.store.list<PersonRecord>('familyPerson')
    const babies = this.store.list<BabyProfile>('familyBaby').map(baby => ({ id: baby.id, referenceFaces: this.validReferenceFaces(baby).map(face => ({ assetId: face.assetId, faceId: face.id })) }))
    const result = await rebuildPersonGroups({ faces, people, assets: [...this.assets.values()].map(asset => ({ id: asset.id, kind: asset.kind })), babies, editableAssetIds: rebuild.assetIds }, progress => {
      requireValue(!this.closed, '人物索引重建已中断。')
      this.progress(job, `重新归组人物：${progress.processed}/${progress.total} 张人脸`)
    })
    requireValue(!this.closed, '人物索引重建已中断。')
    const assetIds = new Set(rebuild.assetIds)
    const previousPeople = new Map(people.map(person => [person.id, person])), resultPersonIds = new Set(result.people.map(person => person.id))
    const editablePersonIds = new Set(faces.filter(face => assetIds.has(face.assetId) && face.personId).map(face => this.canonicalPersonId(face.personId!, previousPeople)))
    this.store.transaction(() => {
      // 失败重试会再次统一归组，只清理由目标新脸独占且已不在结果中的自动人物。
      for (const person of people) if (!resultPersonIds.has(person.id) && editablePersonIds.has(this.canonicalPersonId(person.id, previousPeople))) this.store.remove('familyPerson', person.id)
      for (const person of result.people) this.store.put('familyPerson', person)
      for (const face of result.faces) if (assetIds.has(face.assetId)) this.store.put('familyFace', face)
    })
    const groups = new Map<string, FaceRecord[]>()
    for (const face of result.faces) if (assetIds.has(face.assetId)) { const group = groups.get(face.assetId) ?? []; group.push(face); groups.set(face.assetId, group) }
    // 宝宝回匹按批事务提交并让出线程，中断时保持归组阶段以便沿原新特征继续。
    for (const baby of this.store.list<BabyProfile>('familyBaby')) {
      const references = this.validReferenceFaces(baby)
      for (let offset = 0; offset < rebuild.assetIds.length; offset += 128) {
        requireValue(!this.closed, '宝宝照片回匹已中断。')
        const batch = rebuild.assetIds.slice(offset, offset + 128)
        this.store.transaction(() => { for (const assetId of batch) this.matchFaces(baby, assetId, groups.get(assetId) ?? [], references) })
        this.progress(job, `重新回匹${baby.name}的照片：${offset + batch.length}/${rebuild.assetIds.length}`)
        await pause(); requireValue(!this.closed, '宝宝照片回匹已中断。')
      }
    }
    rebuild.phase = 'done'; rebuild.updatedAt = now(); this.store.put('familyRebuild', rebuild)
    this.rebuildSnapshots.delete(rebuild.epoch)
    this.progress(job, `照片头像索引重建完成${job.skipped ? `；${job.skipped} 项失败可重试` : ''}`)
  }
  analyzeFaces(libraryId?: string, retryOnlyFailed = false, automatic = false): void {
    requireValue(!this.rebuilding, '人脸索引正在重建，请完成后再开始人物分析。', 409)
    requireValue(typeof retryOnlyFailed === 'boolean' && typeof automatic === 'boolean', '人物分析参数无效。')
    requireValue(libraryId !== undefined || !this.store.list<FaceIndexRebuild>('familyRebuild').some(rebuild => rebuild.phase !== 'done'), '有尚未完成的人脸重建，请在对应照片库继续重建或重试失败项。', 409)
    const assets = this.scopedAssets(libraryId).filter(asset => (retryOnlyFailed ? asset.faceState === 'error' : automatic ? asset.faceState === 'pending' && !asset.faceSupplementing : asset.faceState !== 'done') && this.hasActiveLocation(asset, libraryId))
    const rebuild = libraryId ? this.store.get<FaceIndexRebuild>('familyRebuild', libraryId) : undefined
    if (rebuild && (rebuild.phase !== 'done' || assets.some(asset => asset.faceState === 'error' && rebuild.assetIds.includes(asset.id)))) {
      requireValue(!automatic, '上次人脸重建尚未完成，请明确重试失败项。', 409)
      requireValue(!this.store.list<FamilyJob>('familyJob').some(job => job.state === 'running'), '本地处理正在进行，请完成后重试人脸重建。', 409)
      this.analyzeSelectedFaces(assets.filter(asset => rebuild.assetIds.includes(asset.id)), libraryId, '继续重建照片头像索引', false, false, rebuild)
      return
    }
    this.analyzeSelectedFaces(assets, libraryId, retryOnlyFailed ? '仅重试人物分析失败项' : automatic ? '自动整理宝宝照片与视频' : '本地检测人物；视频最多检查 8 帧', automatic)
  }
  /** 用户明确发起后，仅补检本范围内尚未执行当前策略的旧无脸缓存。 */
  supplementFaces(libraryId?: string): void {
    requireValue(!this.rebuilding, '人脸索引正在重建，请完成后再补检。', 409)
    requireValue(!this.store.list<FaceIndexRebuild>('familyRebuild').some(rebuild => rebuild.phase !== 'done' && (libraryId === undefined || rebuild.id === libraryId)), '人脸重建尚未完成，请先继续重建或重试失败项。', 409)
    const faceAssetIds = new Set(this.store.listFaceMetadata<FaceMetadata>().map(face => face.assetId))
    const assets = this.scopedAssets(libraryId).filter(asset => this.needsFaceSupplement(asset, faceAssetIds) && this.hasActiveLocation(asset, libraryId))
    this.analyzeSelectedFaces(assets, libraryId, '本地补检无脸照片；视频增加抽样，最多检查 48 帧', false, true)
  }
  /** 普通分析与无脸补检共用单项容错、缓存与互斥任务。 */
  private analyzeSelectedFaces(assets: CatalogAsset[], libraryId: string | undefined, label: string, automatic = false, supplement = false, rebuild?: FaceIndexRebuild): void {
    if (!assets.length && !rebuild) return
    if (libraryId !== undefined) this.library(libraryId)
    this.startJob('faces', label, async job => {
      try {
      // 新人脸任务保存实际起始时间，进度提示不猜测旧任务的总用时。
      job.startedAt = now(); job.total = assets.length; this.progress(job)
      this.model = await this.engine.ready(); requireValue(this.model.ready, this.model.error || '本地人物模型不可用。')
      if (rebuild?.phase === 'preparing') await this.prepareFaceRebuild(rebuild, job)
      const cachedFaces = new Map<string, FaceRecord[]>()
      for (const face of this.store.list<FaceRecord>('familyFace')) { const group = cachedFaces.get(face.assetId) ?? []; group.push(face); cachedFaces.set(face.assetId, group) }
      const people = new Map(this.store.list<PersonRecord>('familyPerson').map(person => [person.id, person]))
      const groupFaces = new Map<string, FaceRecord[]>()
      const trustedEmbeddings = new Map<string, number[][]>()
      for (const person of people.values()) if (person.mergedIntoId && person.mergeOrigin !== 'automatic') {
        const personId = this.canonicalPersonId(person.id, people), anchors = trustedEmbeddings.get(personId) ?? []
        anchors.push(person.embedding); trustedEmbeddings.set(personId, anchors)
      }
      for (const faces of cachedFaces.values()) for (const face of faces) if (face.personId && this.clearReference(face)) {
        const personId = this.canonicalPersonId(face.personId, people), related = groupFaces.get(personId) ?? []
        related.push(face); groupFaces.set(personId, related)
      }
      const groups: PersonFaceGroup[] = [...people.values()].filter(person => !person.mergedIntoId && person.embedding.length && person.embedding.every(Number.isFinite) && person.embedding.some(value => value !== 0)).map(person => ({ id: person.id, embedding: person.embedding, samples: representativeFaces(groupFaces.get(person.id) ?? [], person.embedding, faceSimilarity), trustedEmbeddings: trustedEmbeddings.get(person.id) ?? [] }))
      let unknownVideos = 0
      for (const asset of assets) {
        requireValue(!this.closed, '人物分析已中断。')
        if (automatic && !this.automaticBabies().length) { this.progress(job, '自动整理已停止，请启用自动归类并设置有效参考。'); break }
        if (automatic && libraryId !== undefined && !this.store.get<Library>('library', libraryId)?.enabled) { this.progress(job, '照片库已停用，自动整理已暂停。'); break }
        const warningPath = asset.locations.find(location => (libraryId === undefined || location.libraryId === libraryId) && this.activeLocation(location))?.path ?? asset.filename
        const supplementing = supplement || Boolean(this.asset(asset.id).faceSupplementing)
        let unknownDuration = false
        try {
          if (supplementing) this.putAsset({ ...this.asset(asset.id), faceSupplementing: true, faceState: 'pending', faceError: undefined })
          const path = await this.mediaPath(asset.id, false, libraryId)
          let duration = asset.duration
          if (asset.kind === 'video' && supplementing && (!Number.isFinite(duration) || duration <= 0)) {
            duration = (await readMetadata(path, 'video')).duration
            if (Number.isFinite(duration) && duration > 0) this.putAsset({ ...this.asset(asset.id), duration })
          }
          unknownDuration = asset.kind === 'video' && (!Number.isFinite(duration) || duration <= 0)
          if (unknownDuration) unknownVideos++
          const times: (number | undefined)[] = asset.kind === 'photo' ? [undefined] : videoFrameTimes(duration, supplementing)
          const found = new Map((cachedFaces.get(asset.id) ?? []).map(face => [face.id, face]))
          const completedFrames = new Set(this.asset(asset.id).faceFrames ?? [])
          for (const time of times) {
            requireValue(!this.closed, '人物分析已中断。')
            const frameKey = `${supplementing ? `supplement:${faceSupplementVersion}:` : ''}${time === undefined ? 'photo' : String(time)}`
            if (completedFrames.has(frameKey)) continue
            const frame = time === undefined ? { path, time } : await videoFrame(path, time, join(this.cacheDirectory, 'frames'))
            const detections = await this.engine.detect(frame.path)
            if (rebuild) {
              const freshFaces: FaceRecord[] = detections.flatMap((detected, faceIndex) => {
                if (!detected.embedding.length || detected.score < 0.5) return []
                const faceId = createHash('sha256').update(`${asset.id}:rebuild:${rebuild.epoch}:${frame.time ?? 'photo'}:${faceIndex}`).digest('hex')
                return [{ id: faceId, assetId: asset.id, x: detected.x, y: detected.y, width: detected.width, height: detected.height, score: detected.score, embedding: detected.embedding, ...(detected.reviewRequired ? { reviewRequired: true } : {}), ...(frame.time !== undefined ? { frameTime: frame.time } : {}) }]
              })
              const nextAsset = { ...this.asset(asset.id), faceFrames: [...completedFrames, frameKey] }
              // 重建一帧的人脸和完成标记原子保存，崩溃后不会复用半帧检测顺序。
              this.store.transaction(() => { for (const face of freshFaces) this.store.put('familyFace', face); this.store.put('familyAsset', nextAsset) })
              this.assets.set(asset.id, nextAsset); completedFrames.add(frameKey)
              for (const face of freshFaces) found.set(face.id, face)
              continue
            }
            for (let faceIndex = 0; faceIndex < detections.length; faceIndex++) {
            const detected = detections[faceIndex]
            if (!detected.embedding.length || detected.score < 0.5) continue
            const faceId = createHash('sha256').update(`${asset.id}:${supplementing ? `supplement:${faceSupplementVersion}:` : ''}${frame.time ?? 'photo'}:${faceIndex}`).digest('hex')
            const prior = this.store.get<FaceRecord>('familyFace', faceId)
            if (prior) { found.set(prior.id, prior); continue }
            const excluded = new Set([...found.values()].filter(face => face.personId && (asset.kind === 'photo' || face.frameTime === frame.time)).map(face => this.canonicalPersonId(face.personId!, people)))
            const reviewRequired = supplementing || Boolean(detected.reviewRequired)
            const decision = reviewRequired ? { kind: 'ambiguous' as const } : matchingPerson(detected.embedding, groups, excluded, faceSimilarity)
            let person: PersonRecord | undefined
            if (decision.kind === 'matched') person = people.get(decision.personId)!
            else if (decision.kind === 'new') {
              person = { id: randomUUID(), name: '', embedding: detected.embedding }
              this.store.put('familyPerson', person); people.set(person.id, person); groups.push({ id: person.id, embedding: person.embedding, samples: [] })
            }
            // 歧义脸仍保留完整缓存与宝宝匹配能力，不再为每张照片创建人物。
            const face: FaceRecord = { id: faceId, assetId: asset.id, x: detected.x, y: detected.y, width: detected.width, height: detected.height, score: detected.score, embedding: detected.embedding, ...(reviewRequired ? { reviewRequired: true } : {}), ...(person ? { personId: person.id } : {}), ...(frame.time !== undefined ? { frameTime: frame.time } : {}) }
            this.store.put('familyFace', face); found.set(face.id, face)
            if (person) {
              const group = groups.find(group => group.id === person.id)!
              group.samples = representativeFaces([...group.samples, face], group.embedding, faceSimilarity)
            }
            }
            // 成功但未发现人脸的帧也缓存，重试只补失败帧。
            completedFrames.add(frameKey)
            this.putAsset({ ...this.asset(asset.id), faceFrames: [...completedFrames] })
          }
          if (rebuild) this.restoreRebuildAnnotations(rebuild, asset.id, [...found.values()])
          // 手动补检也为关闭自动加入的宝宝提供疑似，人工归属仍优先保留。
          if (!rebuild) for (const baby of supplementing ? this.store.list<BabyProfile>('familyBaby') : this.automaticBabies()) this.matchFaces(baby, asset.id, [...found.values()])
          requireValue(!supplementing || !unknownDuration, '视频时长仍未知，仅检查起始帧，补检覆盖不完整；可仅重试失败项继续检查。')
          this.putAsset({ ...this.asset(asset.id), faceState: 'done', faceError: undefined, ...(supplementing || asset.kind === 'photo' ? { faceSupplementVersion, faceSupplementing: false } : {}), updatedAt: now() })
          job.processed++
        } catch (error) { this.putAsset({ ...this.asset(asset.id), faceState: 'error', faceError: errorMessage(error) }); this.skip(job, warningPath, error) }
        this.progress(job, unknownDuration ? `${asset.filename}（视频时长未知，仅检查起始帧，未覆盖完整视频）` : asset.filename); await pause()
      }
      // 后续文件进度不能抹掉未知时长视频的有限检查说明。
      if (unknownVideos) this.progress(job, `${label}；${unknownVideos} 段视频时长未知，仅尝试起始帧，未覆盖完整视频`)
      if (rebuild) await this.finishFaceRebuild(rebuild, job)
      } finally { if (rebuild) this.rebuilding = false }
    }, libraryId)
    if (rebuild) this.rebuilding = true
  }
  namePerson(personId: string, name: string): void {
    requireValue(!this.rebuilding, '人脸索引正在重建，请完成后再命名人物。', 409)
    const people = new Map(this.store.list<PersonRecord>('familyPerson').map(person => [person.id, person]))
    const person = people.get(this.canonicalPersonId(textValue(personId, 80), people)); requireValue(person, '人物分组不存在。')
    this.store.put('familyPerson', { ...person, name: textValue(name.trim(), 40) })
  }
  /** 用户确认后只写一个人物别名；相册归属、参考和原文件保持原样。 */
  mergePersons(sourceId: string, targetId: string, libraryId: string): void {
    this.library(textValue(libraryId, 80))
    const people = new Map(this.store.list<PersonRecord>('familyPerson').map(person => [person.id, person]))
    const source = people.get(textValue(sourceId, 80)), target = people.get(textValue(targetId, 80))
    requireValue(source && target && sourceId !== targetId, '请选择两个不同的人物分组。')
    requireValue(!this.store.list<FamilyJob>('familyJob').some(job => job.kind === 'faces' && job.state === 'running'), '人物分析正在进行，请完成后再合并。', 409)
    const sourcePersonId = this.canonicalPersonId(source.id, people), targetPersonId = this.canonicalPersonId(target.id, people)
    const scopedIds = new Set(this.scopedAssets(libraryId).map(asset => asset.id)), allFaces = this.store.list<FaceRecord>('familyFace')
    const belongs = (face: FaceRecord, personId: string) => Boolean(face.personId && this.canonicalPersonId(face.personId, people) === personId)
    requireValue(allFaces.some(face => scopedIds.has(face.assetId) && belongs(face, sourcePersonId)) && allFaces.some(face => scopedIds.has(face.assetId) && belongs(face, targetPersonId)), '两个分组都必须属于当前照片库。')
    if (sourcePersonId === targetPersonId) return
    const sourceFrames = new Set(allFaces.filter(face => belongs(face, sourcePersonId)).map(face => `${face.assetId}:${this.assets.get(face.assetId)?.kind === 'video' ? face.frameTime ?? 'unknown' : 'photo'}`))
    requireValue(!allFaces.some(face => belongs(face, targetPersonId) && sourceFrames.has(`${face.assetId}:${this.assets.get(face.assetId)?.kind === 'video' ? face.frameTime ?? 'unknown' : 'photo'}`)), '两个分组在同一照片或视频帧中同时出现，不能合并。')
    const canonicalSource = people.get(sourcePersonId)!
    this.store.put('familyPerson', { ...canonicalSource, mergedIntoId: targetPersonId, mergeOrigin: 'manual' })
  }
  /** 整理只作用于当前可用库，任何本地处理任务运行时均保持现有分组。 */
  private personGroupingContext(libraryId: string): void {
    requireValue(!this.closed, '相册服务已关闭。')
    const library = this.library(textValue(libraryId, 80))
    const workspace = this.store.get<{ id: string; libraryId: string | null }>('workspace', 'current-library')
    requireValue(!workspace || workspace.libraryId === libraryId, '当前照片库已切换，请重新生成整理预览。', 409)
    let available = false
    try { available = statSync(library.path).isDirectory() } catch { /* 离线目录只显示不可用，不读取或更改原媒体。 */ }
    requireValue(available, '当前照片库不可用，请连接原目录后再整理。', 409)
    requireValue(!this.store.list<FamilyJob>('familyJob').some(job => job.state === 'running'), '本地处理正在进行，请结束后再整理人物。', 409)
  }
  /** 全量读取相关领域记录计算指纹，不建立任务或写入状态，避免旧预览应用到新数据。 */
  private personGroupingFingerprint(): string {
    const hash = createHash('sha256')
    const rows = this.store.db.prepare("SELECT kind,id,value FROM records WHERE kind IN ('familyPerson','familyFace','familyAsset','library','root','workspace') ORDER BY kind,id").all()
    for (const row of rows) hash.update(JSON.stringify([row.kind, row.id, row.value]))
    hash.update(JSON.stringify([...this.assets.values()].sort((left, right) => left.id.localeCompare(right.id))))
    return hash.digest('hex')
  }
  /** 共现范围始终包含所有库，视频只将同一帧中的不同人脸设为冲突。 */
  private personFrameKey(face: FaceMetadata): string {
    const kind = this.assets.get(face.assetId)?.kind
    return `${face.assetId}:${kind === 'photo' ? 'photo' : face.frameTime ?? 'unknown'}`
  }
  /** 人工或旧版合并的最终人物保持为根，自动整理不会覆盖其确认锚点。 */
  private protectedPeople(people: Map<string, PersonRecord>): Set<string> {
    return new Set([...people.values()].filter(person => person.mergedIntoId && person.mergeOrigin !== 'automatic').map(person => this.canonicalPersonId(person.id, people)))
  }
  /** 仅用缓存特征生成可审核方案，预览不触发检测、自动归类或数据库写入。 */
  async preparePersonGrouping(libraryId: string): Promise<PersonGroupingPreview> {
    this.personGroupingContext(libraryId)
    const fingerprint = this.personGroupingFingerprint(), personRecords = this.store.list<PersonRecord>('familyPerson')
    const people = new Map(personRecords.map(person => [person.id, person])), faces = this.store.list<FaceRecord>('familyFace')
    const scopedIds = new Set(this.scopedAssets(libraryId).map(asset => asset.id))
    const profiles = this.peopleProfiles(faces.filter(face => scopedIds.has(face.assetId)).map(face => ({ ...face, embeddingValid: this.clearReference(face) })), personRecords, libraryId)
    const profileMap = new Map(profiles.map(person => [person.id, person])), groupedFaces = new Map<string, FaceRecord[]>(), protectedIds = this.protectedPeople(people), automaticAnchors = new Map<string, number[][]>(), trustedEmbeddings = new Map<string, number[][]>()
    // 自动整理保留全部旧别名锚点，连续预览时不能绕过前次组件的场景约束。
    for (const person of personRecords) if (person.mergedIntoId && person.mergeOrigin === 'automatic') {
      const personId = this.canonicalPersonId(person.id, people), anchors = automaticAnchors.get(personId) ?? []
      anchors.push(person.embedding); automaticAnchors.set(personId, anchors)
    }
    // 人工确认的多角度锚点与普通识别共用最低支持规则，防止整理重新拆开已确认人物。
    for (const person of personRecords) if (person.mergedIntoId && person.mergeOrigin !== 'automatic') {
      const personId = this.canonicalPersonId(person.id, people), anchors = trustedEmbeddings.get(personId) ?? []
      anchors.push(person.embedding); trustedEmbeddings.set(personId, anchors)
    }
    for (const face of faces) if (face.personId) {
      const personId = this.canonicalPersonId(face.personId, people), related = groupedFaces.get(personId) ?? []
      related.push(face); groupedFaces.set(personId, related)
    }
    const groups = personRecords.filter(person => !person.mergedIntoId && profileMap.has(person.id)).map(person => {
      const related = groupedFaces.get(person.id) ?? []
      return { id: person.id, name: person.name, embedding: person.embedding, samples: representativeFaces(related.filter(face => this.clearReference(face)), person.embedding, faceSimilarity), frames: new Set(related.map(face => this.personFrameKey(face))), assetCount: profileMap.get(person.id)!.assetCount, protected: protectedIds.has(person.id), anchors: automaticAnchors.get(person.id) ?? [], trustedEmbeddings: trustedEmbeddings.get(person.id) ?? [] }
    })
    const result = await planPersonMerges(groups, faceSimilarity)
    this.personGroupingContext(libraryId)
    requireValue(fingerprint === this.personGroupingFingerprint(), '人物或图库记录已变化，请重新生成整理预览。', 409)
    const id = randomUUID(), expiresAt = Date.now() + 10 * 60 * 1000
    for (const [planId, plan] of this.personGroupingPlans) if (plan.expiresAt <= Date.now()) this.personGroupingPlans.delete(planId)
    if (this.personGroupingPlans.size >= 8) this.personGroupingPlans.delete(this.personGroupingPlans.keys().next().value!)
    this.personGroupingPlans.set(id, { libraryId, fingerprint, expiresAt, merges: result.merges.map(merge => ({ ...merge })) })
    return { id, libraryId, before: profiles.length, after: profiles.length - result.merges.length, merges: result.merges.map(merge => ({ source: profileMap.get(merge.sourceId)!, target: profileMap.get(merge.targetId)!, similarity: merge.similarity })), ambiguous: result.ambiguous, conflicts: result.conflicts }
  }
  /** 确认后原子写入人物别名，原始人脸、照片、宝宝参考和人工决定均保持原样。 */
  applyPersonGrouping(planId: string, libraryId: string, sourceIds?: string[]): number {
    this.personGroupingContext(libraryId)
    const plan = this.personGroupingPlans.get(textValue(planId, 80))
    requireValue(plan, '整理预览不存在或已使用，请重新生成。', 409)
    requireValue(plan.libraryId === libraryId, '整理预览不属于当前照片库。', 409)
    requireValue(sourceIds === undefined || Array.isArray(sourceIds) && sourceIds.length <= 10000 && sourceIds.every(value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)), '整理选择参数无效。')
    const selected = sourceIds === undefined ? undefined : new Set(sourceIds)
    requireValue(!selected || [...selected].every(sourceId => plan.merges.some(merge => merge.sourceId === sourceId)), '所选人物不属于本次整理预览。')
    const merges = selected ? plan.merges.filter(merge => selected.has(merge.sourceId)) : plan.merges, originals: PersonRecord[] = []
    const validate = () => {
      this.personGroupingContext(libraryId)
      requireValue(plan.expiresAt > Date.now(), '整理预览已过期，请重新生成。', 409)
      requireValue(plan.fingerprint === this.personGroupingFingerprint(), '人物或图库记录已变化，请重新生成整理预览。', 409)
    }
    validate()
    this.store.transaction(() => {
      validate()
      const people = new Map(this.store.list<PersonRecord>('familyPerson').map(person => [person.id, person])), protectedIds = this.protectedPeople(people), frames = new Map<string, Set<string>>()
      for (const face of this.store.list<FaceRecord>('familyFace')) if (face.personId) {
        const personId = this.canonicalPersonId(face.personId, people), related = frames.get(personId) ?? new Set<string>()
        related.add(this.personFrameKey(face)); frames.set(personId, related)
      }
      for (const merge of merges) {
        const source = people.get(merge.sourceId), target = people.get(merge.targetId)
        requireValue(source && target && source.id !== target.id && !source.mergedIntoId && !target.mergedIntoId && !source.name.trim() && !protectedIds.has(source.id), '人物分组已变化，请重新生成整理预览。', 409)
        const sourceFrames = frames.get(source.id) ?? new Set<string>(), targetFrames = frames.get(target.id) ?? new Set<string>()
        requireValue(![...sourceFrames].some(frame => targetFrames.has(frame)), '两个分组在同一照片或视频帧中同时出现，不能合并。', 409)
        const alias: PersonRecord = { ...source, mergedIntoId: target.id, mergeOrigin: 'automatic' }
        originals.push(source)
        this.store.put('familyPerson', alias); people.set(source.id, alias)
        for (const frame of sourceFrames) targetFrames.add(frame)
        frames.set(target.id, targetFrames)
      }
    })
    this.personGroupingPlans.clear()
    if (originals.length) {
      for (const [token, undo] of this.personGroupingUndos) if (undo.libraryId === libraryId || undo.expiresAt <= Date.now()) this.personGroupingUndos.delete(token)
      const token = randomUUID(); this.personGroupingUndos.set(token, { token, libraryId, count: originals.length, expiresAt: Date.now() + 10 * 60 * 1000, fingerprint: this.personGroupingFingerprint(), originals })
    }
    return merges.length
  }
  /** 只还原本次别名，后续人物或图库变化时拒绝撤销旧操作。 */
  undoPersonGrouping(token: string, libraryId: string): number {
    this.personGroupingContext(libraryId)
    const undo = this.personGroupingUndos.get(textValue(token, 80))
    requireValue(undo && undo.libraryId === libraryId && undo.expiresAt > Date.now(), '可撤销的整理已过期或不属于当前照片库。', 409)
    const validate = () => { this.personGroupingContext(libraryId); requireValue(undo.fingerprint === this.personGroupingFingerprint(), '人物或图库记录已变化，不能撤销旧整理，请重新核对人物。', 409) }
    validate()
    this.store.transaction(() => { validate(); for (const original of undo.originals) this.store.put('familyPerson', original) })
    this.personGroupingUndos.delete(token); this.personGroupingPlans.clear()
    return undo.count
  }
  setBabyReference(babyId: string, assetId: string, faceId: string): void {
    requireValue(!this.rebuilding, '人脸索引正在重建，请完成后再选择宝宝参考。', 409)
    const baby = this.baby(babyId); this.asset(assetId)
    const face = this.store.get<FaceRecord>('familyFace', textValue(faceId, 80)); requireValue(face?.assetId === assetId, '参考人脸不存在。')
    requireValue(this.clearReference(face), '请选择清晰、完整的人脸作为宝宝参考。')
    const retained = baby.referenceFaces.some(item => item.faceId === faceId && item.assetId === assetId)
    requireValue(retained || baby.referenceFaces.length < 20, '每个宝宝最多保留 20 个参考，请先明确移除不再需要的参考。')
    const referenceFaces = retained ? baby.referenceFaces : [...baby.referenceFaces, { assetId, faceId }]
    const updated = { ...baby, referenceFaces, updatedAt: now() }
    this.store.put('familyBaby', updated)
    this.setBabyMembership(babyId, [assetId], true)
    if (JSON.stringify(baby.referenceFaces) !== JSON.stringify(referenceFaces)) this.refreshBabyMatches(updated)
    this.ensureAutomaticFaces(this.store.get<{ id: string; libraryId: string | null }>('workspace', 'current-library')?.libraryId ?? undefined)
  }
  private matchFaces(baby: BabyProfile, assetId: string, faces: FaceRecord[], references = this.validReferenceFaces(baby)): void {
    const previous = this.store.get<BabyDecision>('familyDecision', `${baby.id}:${assetId}`)
    if (previous?.origin === 'manual') return
    if (!references.length) return
    const clearFaces = faces.filter(face => this.clearReference(face))
    const scoreFor = (values: FaceRecord[]) => Math.max(-1, ...values.flatMap(face => references.map(reference => faceSimilarity(face.embedding, reference.embedding))))
    const score = scoreFor(clearFaces), automaticScore = scoreFor(clearFaces.filter(face => !face.reviewRequired))
    // 补检及旋转兜底人脸必须人工确认，正常强匹配仍按原规则自动加入。
    if (score >= 0.4) this.store.put('familyDecision', { id: `${baby.id}:${assetId}`, babyId: baby.id, assetId, origin: 'recognition', state: baby.autoMatch && automaticScore >= 0.65 ? 'included' : 'candidate', score, updatedAt: now() } satisfies BabyDecision)
    else if (previous?.origin === 'recognition') this.store.put('familyDecision', { ...previous, state: 'unconfirmed', score, updatedAt: now() })
  }
  /** 缓存重新匹配按块让出工作线程，不重新检测，也不覆盖人工归属。 */
  private matchStatus(baby: BabyProfile, assets: CatalogAsset[], libraryId: string | undefined, scope: 'library' | 'all', decisions = this.store.list<BabyDecision>('familyDecision'), faceMetadata = this.store.listFaceMetadata<FaceMetadata>(true)): BabyMatchStatus {
    const assetIds = new Set(assets.map(asset => asset.id)), related = decisions.filter(item => item.babyId === baby.id && assetIds.has(item.assetId))
    const faceMap = new Map(faceMetadata.map(face => [face.id, face])), faceAssets = new Set(faceMetadata.map(face => face.assetId))
    const validReferences = baby.referenceFaces.filter(reference => { const face = faceMap.get(reference.faceId); return face?.assetId === reference.assetId && face.embeddingValid && this.clearFaceBox(face) && this.assets.get(reference.assetId)?.locations.some(location => this.activeLocation(location)) }).length
    const rebuilds = this.pendingFaceRebuilds().filter(rebuild => rebuild.assetIds.some(id => assetIds.has(id)))
    const rebuilding = rebuilds.length > 0, running = rebuilding && this.store.list<FamilyJob>('familyJob').some(job => job.kind === 'faces' && job.state === 'running' && rebuilds.some(rebuild => rebuild.id === job.libraryId))
    return { babyId: baby.id, scope, ...(libraryId ? { libraryId } : {}), state: rebuilding ? running ? 'running' : 'error' : 'done', ...(rebuilding ? { rebuilding: true, error: running ? '正在重建人脸，宝宝新结果将在重建完成后更新。' : '人脸重建已中断，请继续重建；重扫前宝宝结果仍可浏览。' } : {}), processed: rebuilding ? assets.filter(asset => asset.faceState !== 'pending').length : 0, total: assets.length, included: related.filter(item => item.state === 'included').length, candidates: related.filter(item => item.state === 'candidate').length, addedIncluded: 0, addedCandidates: 0, validReferences, invalidReferences: baby.referenceFaces.length - validReferences, coverage: { total: assets.length, done: assets.filter(asset => asset.faceState === 'done').length, pending: assets.filter(asset => asset.faceState === 'pending').length, error: assets.filter(asset => asset.faceState === 'error').length, noFaces: assets.filter(asset => asset.faceState === 'done' && !faceAssets.has(asset.id)).length, supplementPending: assets.filter(asset => this.needsFaceSupplement(asset, faceAssets)).length } }
  }
  /** 新参考使旧任务失效，迟到的分块只结束自身记录，不写回新状态。 */
  private beginBabyMatching(baby: BabyProfile, libraryId: string | undefined, scope: 'library' | 'all'): BabyMatchResult {
    requireValue(!this.closed, '相册服务已关闭。')
    requireValue(!this.rebuilding, '人脸索引正在重建，请完成后再查找宝宝照片。', 409)
    if (scope === 'library') this.library(textValue(libraryId, 80))
    const assets = this.scopedAssets(libraryId).filter(asset => asset.locations.some(location => (libraryId === undefined || location.libraryId === libraryId) && this.activeLocation(location)))
    const assetIds = new Set(assets.map(asset => asset.id))
    requireValue(!this.pendingFaceRebuilds().some(rebuild => rebuild.assetIds.some(id => assetIds.has(id))), '人脸重建尚未完成，请先继续重建；重扫前宝宝结果仍可浏览和人工确认。', 409)
    const status = this.matchStatus(baby, assets, libraryId, scope), references = this.validReferenceFaces(baby)
    const version = (this.babyMatchVersions.get(baby.id) ?? 0) + 1; this.babyMatchVersions.set(baby.id, version)
    const signature = JSON.stringify([baby.autoMatch, baby.referenceFaces]), faceMap = new Map<string, FaceRecord[]>()
    for (const face of this.store.list<FaceRecord>('familyFace')) { const group = faceMap.get(face.assetId) ?? []; group.push(face); faceMap.set(face.assetId, group) }
    const current = () => !this.closed && this.babyMatchVersions.get(baby.id) === version && JSON.stringify([this.baby(baby.id).autoMatch, this.baby(baby.id).referenceFaces]) === signature && (libraryId === undefined || Boolean(this.store.get<Library>('library', libraryId)?.enabled))
    const job: FamilyJob | undefined = assets.length > 32 ? { id: randomUUID(), kind: 'matching', babyId: baby.id, state: 'running', processed: 0, total: assets.length, label: `匹配${baby.name}的缓存照片与视频`, error: '', ...(libraryId ? { libraryId } : {}) } : undefined
    status.state = 'running'; if (job) { status.jobId = job.id; this.store.put('familyJob', job) }; this.babyMatching.set(baby.id, status)
    const process = async () => {
      const chunkSize = job ? 16 : Math.max(1, assets.length)
      for (let offset = 0; offset < assets.length; offset += chunkSize) {
        if (!current()) { status.state = 'superseded'; if (job) { job.state = 'done'; job.label = '参考或查找范围已变化，已停止旧匹配'; this.progress(job) }; return }
        this.store.transaction(() => {
          for (const asset of assets.slice(offset, offset + chunkSize)) {
            const before = this.store.get<BabyDecision>('familyDecision', `${baby.id}:${asset.id}`)
            if (!references.length && before?.origin === 'recognition') this.store.put('familyDecision', { ...before, state: 'unconfirmed', score: undefined, updatedAt: now() })
            else this.matchFaces(baby, asset.id, faceMap.get(asset.id) ?? [], references)
            const after = this.store.get<BabyDecision>('familyDecision', `${baby.id}:${asset.id}`)
            status.included += Number(after?.state === 'included') - Number(before?.state === 'included')
            status.candidates += Number(after?.state === 'candidate') - Number(before?.state === 'candidate')
            if (after?.state === 'included' && before?.state !== 'included') status.addedIncluded++
            if (after?.state === 'candidate' && before?.state !== 'candidate') status.addedCandidates++
            status.processed++
          }
        })
        if (job) { job.processed = status.processed; this.progress(job) }
        if (offset + chunkSize < assets.length) await pause()
      }
      status.state = 'done'; if (job) { job.state = 'done'; this.progress(job) }
      this.ensureAutomaticFaces(libraryId)
    }
    const task = process().catch(error => { status.state = 'error'; status.error = errorMessage(error); if (job) { job.state = 'error'; job.error = status.error; this.progress(job) } }).finally(() => { this.tasks.delete(task); if (status.state !== 'error') this.wakeAutomaticFaces() })
    this.tasks.add(task)
    return { ...status, coverage: { ...status.coverage } }
  }
  matchBaby(babyId: string, libraryId?: string, scope: 'library' | 'all' = libraryId ? 'library' : 'all'): BabyMatchResult {
    const baby = this.baby(babyId); requireValue(baby.referenceFaces.length > 0, '请先选择一张清晰人脸作为宝宝参考。')
    requireValue(this.validReferenceFaces(baby).length > 0, '宝宝参考人脸已失效或不清晰，请重新选择参考。')
    requireValue(scope === 'library' || scope === 'all', '宝宝查找范围无效。')
    if (scope === 'all') requireValue(libraryId === undefined, '全部授权目录查找不能限定单个照片库。')
    return this.beginBabyMatching(baby, libraryId, scope)
  }
  /** 通用参数先整批校验，媒体日期、归属及解码问题则逐张记录并继续。 */
  private watermarkOptions(value: WatermarkOptions): WatermarkOptions {
    requireValue(value && typeof value === 'object', '水印参数无效。')
    this.baby(value.babyId)
    requireValue(['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(value.position), '水印位置无效。')
    requireValue(Number.isInteger(value.fontSize) && value.fontSize >= 10 && value.fontSize <= 120, '字号须在 10 到 120 之间。')
    requireValue(/^#[a-f0-9]{6}$/i.test(value.color) && Number.isFinite(value.opacity) && value.opacity >= 0.1 && value.opacity <= 1, '水印颜色或透明度无效。')
    for (const field of ['showName', 'showAge', 'showDayCount', 'showDate'] as const) requireValue(typeof value[field] === 'boolean', '水印内容开关无效。')
    requireValue(value.showName || value.showAge || value.showDayCount || value.showDate, '请至少选择一种水印内容。')
    requireValue(value.template === undefined || value.template === 'classic' || value.template === 'growth', '水印模板无效。')
    requireValue(value.growthMode === undefined || value.growthMode === 'auto' || value.growthMode === 'day-count', '成长文字模式无效。')
    requireValue(value.shade === undefined || typeof value.shade === 'boolean', '水印暗底开关无效。')
    return { ...value }
  }
  private watermark(assetId: string, value: WatermarkOptions): { asset: CatalogAsset; options: WatermarkOptions; text: string } {
    const asset = this.asset(assetId), options = this.watermarkOptions(value), baby = this.baby(options.babyId)
    requireValue(asset.date && asset.dateConfirmed && (asset.dateSource === 'capture' || asset.dateSource === 'manual'), '请先确认拍摄日期，创建日期不能直接用于月龄水印。')
    const membership = this.store.get<BabyDecision>('familyDecision', `${baby.id}:${asset.id}`)
    requireValue(membership?.state === 'included', '请先确认这张照片属于该宝宝相册。')
    return { asset, options, text: watermarkText(baby, asset.date!, options) }
  }
  async previewWatermark(assetId: string, options: WatermarkOptions, libraryId?: string): Promise<WatermarkResult> {
    const checked = this.watermark(assetId, options), path = await this.mediaPath(assetId, false, libraryId)
    requireValue(checked.asset.kind === 'photo', '视频可按原文件归档和查看，当前成长水印仅支持照片。')
    await mkdir(this.cacheDirectory, { recursive: true })
    const buffer = await watermarkPreview(path, checked.asset.kind, checked.text, checked.options, this.cacheDirectory)
    return { assetId, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`, filename: `${basename(path, extname(path))}_${options.template === 'growth' ? '成长' : '月龄'}.jpg` }
  }
  async exportWatermark(assetIds: string[], options: WatermarkOptions, outputDirectory: string, libraryId?: string): Promise<WatermarkResult[]> {
    requireValue(Array.isArray(assetIds) && assetIds.length > 0 && assetIds.length <= 100, '每次请选择 1 到 100 个水印导出项目。')
    const validatedOptions = this.watermarkOptions(options), assets = assetIds.map(id => this.asset(id))
    const outputRoot = await canonicalDirectory(outputDirectory), results: WatermarkResult[] = []
    if (libraryId !== undefined) {
      this.library(libraryId)
      requireValue(assets.every(asset => asset.locations.some(location => location.libraryId === libraryId)), '所选照片不都在当前照片库中。', 404)
    }
    requireValue(assets.every(asset => asset.kind === 'photo'), '视频可按原文件归档和查看，当前月龄水印仅导出照片。')
    const naming = { roots: new Set(this.store.list<ScanRoot>('root').filter(root => root.enabled).map(root => root.id)), libraries: new Set(this.store.list<Library>('library').filter(library => library.enabled).map(library => library.id)) }
    for (const asset of assets) {
      const sourceFilename = this.mediaFilename(asset, naming, libraryId), stem = basename(sourceFilename, extname(sourceFilename)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 70) || 'photo'
      const filename = `${stem}_${options.template === 'growth' ? '成长' : '月龄'}_${randomUUID().slice(0, 8)}.jpg`, output = await safePath(outputRoot, filename)
      let created = false
      try {
        const item = this.watermark(asset.id, validatedOptions), path = await this.mediaPath(asset.id, false, libraryId)
        // 创建目标失败属于整批保存环境错误，已生成的副本继续保留。
        const handle = await open(output, 'wx'); created = true; await handle.close()
        await watermarkExport(path, item.asset.kind, item.text, item.options, output, this.cacheDirectory, item.asset.date!)
        this.store.put('familyExport', { id: randomUUID(), assetId: item.asset.id, babyId: options.babyId, options: item.options, path: output, hash: (await hashFile(output)).hash, createdAt: now() })
        results.push({ assetId: asset.id, path: output, filename })
      } catch (error) {
        await canonicalDirectory(outputRoot)
        if (!created && ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error
        results.push({ assetId: asset.id, filename: sourceFilename, ...(created ? { path: output } : {}), error: processingError(error) })
      }
    }
    return results
  }
  /** 同步仅传可共享的相册信息，保留人工决定，绝不暴露人脸向量或电脑绝对路径。 */
  sync(request: FamilySyncRequest): FamilySyncResponse {
    requireValue(request && Array.isArray(request.babies) && request.babies.length <= 100 && Array.isArray(request.decisions) && request.decisions.length <= 100 && (!request.dates || Array.isArray(request.dates) && request.dates.length <= 100), '相册同步数据无效。')
    const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 300000
    for (const incoming of request.babies) {
      requireValue(incoming && /^[a-zA-Z0-9-]{1,80}$/.test(incoming.id) && validDate(incoming.birthday) && incoming.birthday <= localDate() && validTime(incoming.updatedAt) && typeof incoming.autoMatch === 'boolean', '宝宝同步数据无效。')
      const previous = this.store.get<BabyProfile>('familyBaby', incoming.id)
      if (!previous || Date.parse(incoming.updatedAt) > Date.parse(previous.updatedAt)) {
        const baby: BabyProfile = { id: incoming.id, name: textValue(incoming.name, 40), birthday: incoming.birthday, autoMatch: incoming.autoMatch, referenceFaces: previous?.referenceFaces ?? [], ...(previous?.avatarAssetId ? { avatarAssetId: previous.avatarAssetId } : {}), updatedAt: new Date(incoming.updatedAt).toISOString() }
        this.store.put('familyBaby', baby)
        if (previous && previous.autoMatch !== baby.autoMatch) this.refreshBabyMatches(baby)
      }
    }
    for (const incoming of request.decisions) {
      if (incoming?.origin === 'recognition') continue
      requireValue(incoming && incoming.origin === 'manual' && /^[a-f0-9]{64}-\d+$/.test(incoming.assetId) && /^[a-zA-Z0-9-]{1,80}$/.test(incoming.babyId) && validTime(incoming.updatedAt) && ['included', 'excluded'].includes(incoming.state), '相册归属同步数据无效。')
      this.baby(incoming.babyId)
      const id = `${incoming.babyId}:${incoming.assetId}`, previous = this.store.get<BabyDecision>('familyDecision', id)
      if (!previous || previous.origin === 'recognition' || Date.parse(incoming.updatedAt) > Date.parse(previous.updatedAt)) this.store.put('familyDecision', { id, babyId: incoming.babyId, assetId: incoming.assetId, state: incoming.state, origin: 'manual', updatedAt: new Date(incoming.updatedAt).toISOString() } satisfies BabyDecision)
    }
    for (const incoming of request.dates ?? []) {
      requireValue(incoming && /^[a-f0-9]{64}-\d+$/.test(incoming.assetId) && validDate(incoming.date) && validTime(incoming.updatedAt), '拍摄日期同步数据无效。')
      const previous = this.store.get<FamilyDate & { id: string }>('familyDate', incoming.assetId)
      if (!previous || Date.parse(incoming.updatedAt) > Date.parse(previous.updatedAt)) {
        const record = { ...incoming, id: incoming.assetId, updatedAt: new Date(incoming.updatedAt).toISOString() }
        this.store.put('familyDate', record)
        const asset = this.assets.get(incoming.assetId)
        if (asset) this.putAsset({ ...asset, date: incoming.date, dateSource: 'manual', dateConfirmed: true, updatedAt: record.updatedAt })
      }
    }
    const cursor = Number.isSafeInteger(request.cursor) && request.cursor! >= 0 ? request.cursor! : 0
    const limit = Number.isSafeInteger(request.limit) ? Math.max(1, Math.min(100, request.limit!)) : 100
    const all = [...this.assets.values()].sort((left, right) => left.id.localeCompare(right.id)), context = this.decorationContext()
    const assets = all.slice(cursor, cursor + limit).map(asset => {
      const item = this.decorated(asset, context)
      const babyIds = (context.decisions.get(asset.id) ?? []).filter(decision => decision.origin === 'manual' && decision.state === 'included').map(decision => decision.babyId)
      return { ...item, babyIds, ...(item.faceError ? { faceError: '本地人物分析失败，可在电脑端重试。' } : {}), locations: item.locations.map(location => ({ id: location.id, source: location.source, label: location.label, path: '', libraryId: location.libraryId, receiptId: location.receiptId, available: location.available })) }
    })
    const decisionCursor = Number.isSafeInteger(request.decisionCursor) && request.decisionCursor! >= 0 ? request.decisionCursor! : 0
    const dateCursor = Number.isSafeInteger(request.dateCursor) && request.dateCursor! >= 0 ? request.dateCursor! : 0
    const allDecisions = this.store.list<BabyDecision>('familyDecision').filter(item => item.origin === 'manual' && ['included', 'excluded'].includes(item.state)).sort((left, right) => left.id.localeCompare(right.id))
    const allDates = this.store.list<FamilyDate & { id: string }>('familyDate').sort((left, right) => left.id.localeCompare(right.id))
    // 桌面头像与本机参考不参与同步，只返回明确的共享档案字段。
    const babies = this.store.list<BabyProfile>('familyBaby').map(({ id, name, birthday, autoMatch, updatedAt }) => ({ id, name, birthday, autoMatch, referenceFaces: [], updatedAt }))
    return { babies, decisions: allDecisions.slice(decisionCursor, decisionCursor + 500), dates: allDates.slice(dateCursor, dateCursor + 500).map(({ id: _, ...date }) => date), assets, nextCursor: cursor + assets.length < all.length ? cursor + assets.length : null, nextDecisionCursor: decisionCursor + 500 < allDecisions.length ? decisionCursor + 500 : null, nextDateCursor: dateCursor + 500 < allDates.length ? dateCursor + 500 : null }
  }
  async thumbnailData(assetId: string): Promise<string> {
    const path = await this.mediaPath(assetId, true)
    return `data:image/jpeg;base64,${(await readFile(path)).toString('base64')}`
  }
  async close(): Promise<void> { this.closed = true; clearTimeout(this.automaticTimer); this.automaticTimer = undefined; this.personGroupingPlans.clear(); this.personGroupingUndos.clear(); this.mediaQueryCache = undefined; await Promise.allSettled([...this.tasks, ...(this.modelInitialization ? [this.modelInitialization] : [])]); await this.engine.close?.() }
}
