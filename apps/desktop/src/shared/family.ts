export type MediaKind = 'photo' | 'video'
export type DateSource = 'capture' | 'creation' | 'manual' | 'unknown'
export interface MediaFace {
  id: string; x: number; y: number; width: number; height: number; score: number
  personId?: string; personName?: string; frameTime?: number
  /** 补充检测的人脸须先核对，不凭相似度自动加入宝宝相册。 */
  reviewRequired?: boolean
}
export interface MediaLocation {
  id: string; source: 'folder' | 'phone'; label: string; path: string
  libraryId?: string; receiptId?: string; available: boolean
  /** 原文件变化与读取失败分别提示，不把正常编辑误报为丢失。 */
  unavailableReason?: 'changed' | 'missing' | 'unreadable'
}
export interface MediaAsset {
  id: string; hash: string; size: number; filename: string; kind: MediaKind
  date: string | null; dateSource: DateSource; dateConfirmed: boolean
  captureDate: string | null; creationDate: string | null
  width: number; height: number; duration: number; available: boolean
  locations: MediaLocation[]; babyIds: string[]; personIds: string[]
  favorite: boolean; faces: MediaFace[]; faceState: 'pending' | 'done' | 'error'; faceError?: string
  /** 相册归属与人脸参考分别展示，不把识别相似程度当作身份概率。 */
  babyDecisions?: BabyDecision[]; babyReferenceIds?: string[]
  /** 待核对列表提供当前宝宝的未确定原因，不据此判断身份。 */
  babyReviewReason?: string
}
export interface BabyProfile {
  id: string; name: string; birthday: string; autoMatch: boolean
  referenceFaces: { assetId: string; faceId: string }[]; updatedAt: string
  /** 桌面本地头像仅关联照片，不参与人脸匹配或跨端同步。 */
  avatarAssetId?: string
}
export interface PersonProfile {
  id: string; name: string; faceCount: number; assetCount: number
  reference?: { assetId: string; face: MediaFace; kind: MediaKind }
}
export interface PersonGroupingPreview {
  id: string; libraryId: string; before: number; after: number
  merges: { source: PersonProfile; target: PersonProfile; similarity: number }[]
  ambiguous: number; conflicts: number
}
export interface BabyDecision {
  id: string; babyId: string; assetId: string; state: 'included' | 'excluded' | 'candidate' | 'unconfirmed'
  origin: 'manual' | 'recognition'; score?: number; updatedAt: string
  /** 仅供重建期间浏览的旧结果，不作为已确认归属、同步或水印资格。 */
  rebuildPending?: boolean
}
export interface FamilyJob {
  libraryId?: string
  scanPurpose?: 'library' | 'import-preview'
  id: string; kind: 'scan' | 'import' | 'faces' | 'matching'; state: 'running' | 'done' | 'error'
  processed: number; total: number; label: string; error: string
  skipped?: number; warnings?: string[]; warningReportId?: string; duplicates?: number
  sourceFiles?: number; uniqueMedia?: number; babyId?: string
  /** 扫描先统计文件数，处理计时与统计阶段分开，旧任务可缺少这些字段。 */
  scanPhase?: 'counting' | 'processing'; scanTotal?: number
  startedAt?: string; processingStartedAt?: string
}
export interface BabyMatchResult {
  babyId: string; scope: 'library' | 'all'; libraryId?: string
  state: 'running' | 'done' | 'error' | 'superseded'; processed: number; total: number
  included: number; candidates: number; addedIncluded: number; addedCandidates: number
  validReferences: number; invalidReferences: number; error?: string
  rebuilding?: boolean
  coverage: { total: number; done: number; pending: number; error: number; noFaces: number; supplementPending?: number }
}
export interface BabyMatchStatus extends BabyMatchResult { jobId?: string }
export interface PersonGroupingUndo { token: string; libraryId: string; count: number; expiresAt: number }
export interface ProcessingWarningPage { items: string[]; total: number; page: number; limit: number }
/** 局部浏览修改前后的版本，只在完整对应当前缓存时才能标记为最新。 */
export interface BrowseMutation { before: string; after: string }
/** 重建状态只公开处理范围和进度，不暴露备份路径或本地识别特征。 */
export interface FaceRebuildStatus {
  libraryId: string; libraryName: string; phase: 'preparing' | 'detecting' | 'grouping'
  state: 'running' | 'interrupted'; processed: number; total: number; failed: number; snapshotAvailable: boolean
}
export interface FamilyState {
  photoCount: number; videoCount: number; babies: BabyProfile[]; people: PersonProfile[]
  jobs: FamilyJob[]; modelReady: boolean; modelError: string; candidateCount: number
  /** 浏览相关记录变化时使进程内页面缓存失效，不能用媒体数量替代。 */
  browseRevision?: string
  importPlans?: ImportPlan[]
  analysis?: { pending: number; done: number; error: number; faceCount: number; noFaces?: number; supplementPending?: number }
  ungrouped?: { faces: number; assets: number }
  babyMatching?: BabyMatchStatus[]; personGroupingUndo?: PersonGroupingUndo
  faceRebuilds?: FaceRebuildStatus[]
}
export interface MediaQuery {
  libraryId?: string
  scope?: 'library' | 'all'
  page?: number; limit?: number; kind?: MediaKind; babyId?: string; personId?: string
  /** 只读取指定宝宝的参考媒体，不受相册归属和当前分页限制。 */
  referenceBabyId?: string
  source?: 'folder' | 'phone'; favorite?: boolean; from?: string; to?: string
  candidates?: boolean; search?: string
  includeCandidates?: boolean
  /** 单独查看尚未确定归属的媒体，人工排除和已有匹配不混入。 */
  unconfirmed?: boolean
  dateSource?: DateSource; datePending?: boolean
  order?: 'asc' | 'desc'
  ungroupedFaces?: boolean
}
export interface MediaPage { items: MediaAsset[]; total: number; page: number; limit: number }
export interface SimilarFaceQuery {
  assetId: string; faceId: string; scope: 'library' | 'all'; libraryId?: string
  page?: number; limit?: number; kind?: MediaKind; order?: 'asc' | 'desc'
}
export interface SimilarFacePage extends MediaPage {
  items: (MediaAsset & { similarity: number })[]; scope: 'library' | 'all'; threshold: 0.4
  coverage: { total: number; done: number; pending: number; error: number }
}
export interface ImportPlan {
  id: string; rootId: string; libraryId?: string; mode: 'index' | 'copy'
  state?: 'preparing' | 'ready' | 'error'; error?: string
  count: number; bytes: number; unknownDates: number; creationDates: number
  sourceFiles?: number; uniqueMedia?: number; duplicates?: number
  skipped?: number; warnings?: string[]; warningReportId?: string
  preview: { filename: string; date: string | null; dateSource: DateSource; relativePath: string }[]
}
export interface WatermarkOptions {
  babyId: string; position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  fontSize: number; color: string; opacity: number; showName: boolean; showAge: boolean
  showDayCount: boolean; showDate: boolean
  /** 未指定模板时沿用旧月龄排版，成长模板使用主标题与拍摄日期两行。 */
  template?: 'growth' | 'classic'; growthMode?: 'auto' | 'day-count'; shade?: boolean
}
export interface WatermarkResult { dataUrl?: string; path?: string; filename: string; assetId?: string; error?: string }

// 两端以完整内容指纹关联记录；同步相册记录不会生成上传回执。
export interface FamilyDate { assetId: string; date: string; updatedAt: string }
export interface FamilySyncRequest { babies: BabyProfile[]; decisions: BabyDecision[]; cursor?: number; limit?: number; decisionCursor?: number; dates?: FamilyDate[]; dateCursor?: number }
export interface FamilySyncResponse {
  babies: BabyProfile[]; decisions: BabyDecision[]; assets: MediaAsset[]; nextCursor: number | null
  nextDecisionCursor?: number | null
  dates?: FamilyDate[]; nextDateCursor?: number | null
}
