<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { NButton, NSkeleton } from 'naive-ui'
import type { ReceiverState } from '../../../shared/desktop-api'
import { copyDirectoryError } from '../../../shared/import-paths'
import type { BabyProfile, BrowseMutation, DateSource, FamilyJob, FamilyState, ImportPlan, MediaAsset, MediaFace, MediaPage, MediaQuery, PersonGroupingPreview, SimilarFacePage, SimilarFaceQuery, WatermarkResult } from '../../../shared/family'
import { calendarAge, growthStamp, hasReliableDate, monthRange, plainData } from '../family-ui'
import { hasScanTotal, scanProgressValue, scanTimingLabel } from '../../../shared/scan-progress'

import VirtualMonthGallery from './VirtualMonthGallery.vue'
import { recallBrowse, rememberBrowse } from '../browse-memory'
import MediaPreview from './MediaPreview.vue'
import GrowthWatermarkEditor from './GrowthWatermarkEditor.vue'
import GrowthWatermarkStamp from './GrowthWatermarkStamp.vue'
import FaceRebuildNotice from './FaceRebuildNotice.vue'
import FaceAnalysisProgress from './FaceAnalysisProgress.vue'
import BabyProfileDialog from './BabyProfileDialog.vue'
import PhotoAvatar from './PhotoAvatar.vue'
import UiIcon from './UiIcon.vue'
import UiSelect from './UiSelect.vue'
import UiDatePicker from './UiDatePicker.vue'
import UiPopover from './UiPopover.vue'
import UiDialog from './UiDialog.vue'
import UiProvider from './UiProvider.vue'
import UiLoading from './UiLoading.vue'
import PersonBrowser from './PersonBrowser.vue'
import PersonMergeDialog from './PersonMergeDialog.vue'
import PersonGroupingDialog from './PersonGroupingDialog.vue'
import FaceSelector from './FaceSelector.vue'
import ProcessingWarnings from './ProcessingWarnings.vue'
import { userError } from '../ui-error'
import { closePopupMenus } from '../popup-dismiss'

const props = defineProps<{ module: 'import' | 'library' | 'baby'; page: string; receiver: ReceiverState | null; recordsOpen?: boolean }>()
const emit = defineEmits<{ 'refresh-receiver': []; navigate: ['import' | 'library' | 'baby']; 'change-page': [string]; 'close-records': []; 'processing-status': [{ running: number; unread: boolean }] }>()
const api = window.momentnest
/** 分页记录整批替换，避免为大图库中的每个嵌套字段建立响应依赖。 */
const family = shallowRef<FamilyState | null>(null), media = shallowRef<MediaPage | null>(null)
const babyMatchCounts = ref({ included: 0, candidates: 0 })
const babyCandidateCount = ref(0)
const babyUnconfirmedCount = ref(0)
const notice = ref(''), busy = ref(false), loading = ref(false), browsePage = ref(1)
const loadingMore = ref(false), loadMoreError = ref(''), mediaSentinel = ref<HTMLElement | null>(null)
const collapseNewMonths = ref(false), monthCollapseOverrides = ref(new Map<string, boolean>())
const folding = ref(false), expandingMonths = ref(false)
let foldingSequence = 0
const jobsUnread = ref(false), recordsDialog = ref<HTMLElement | null>(null)
const selected = ref(new Map<string, MediaAsset>()), thumbnails = reactive<Record<string, string>>({})
const selectedBabyId = ref(''), growthMonth = ref('all')
const babyResultFilter = ref('all'), babyMatchScope = ref<'library'|'all'>('library')
const virtualGallery = ref<InstanceType<typeof VirtualMonthGallery> | null>(null)
const visibleAssets = shallowRef<MediaAsset[]>([])
const filters = reactive({ search: '', kind: '', source: '', dateSource: '', personId: '', ungroupedFaces: false, from: '', to: '', order: 'desc' as 'asc' | 'desc' })
const similarReference = ref<{ assetId: string; faceId: string; personId?: string; name?: string } | null>(null)
const similarScope = ref<'all' | 'library'>('all'), similarResult = ref<SimilarFacePage | null>(null)
const importRoot = ref(''), importMode = ref<'index' | 'copy'>('copy'), importLibrary = ref(''), importPlan = ref<ImportPlan | null>(null)
const detail = ref<MediaAsset | null>(null), detailUrl = ref(''), detailLoading = ref(false), editedDate = ref(''), selectedFaceId = ref('')
const editedDateValid = ref(true)
const detailError = ref(''), detailActionError = ref(''), navigationError = ref(''), navigationLoading = ref(false)
const mediaPreview = ref<InstanceType<typeof MediaPreview> | null>(null)
const previewDetachedIndex = ref<number | null>(null)
const faceSelectionMode = ref(false)
const mediaVideo = ref<HTMLVideoElement | null>(null)
const profileOpen = ref(false), profileDraft = ref<BabyProfile | null>(null)
const profileError = ref(''), profileChooseAvatar = ref(false)
const profileReferencePreview = ref(false)
let profileSequence = 0
const personOpen = ref(false), personId = ref(''), personName = ref('')
const personError = ref('')
const rebuildIndexLibrary = ref('')
let personSequence = 0, personOpener: HTMLElement | null = null
const personMergeSource = ref(''), personMergeError = ref('')
let personMergeSequence = 0
const groupingOpen = ref(false), groupingLoading = ref(false), groupingError = ref(''), groupingPreview = shallowRef<PersonGroupingPreview | null>(null)
const groupingInspection = ref(false)
const inspectionMedia = shallowRef<MediaPage | null>(null), inspectionPersonId = ref('')
let groupingSequence = 0
const referenceQueue = ref<MediaAsset[]>([]), referenceIndex = ref(0), referenceBabyId = ref('')
const referencePickerError = ref('')
let referencePickerSequence = 0
const activeWatermarkId = ref(''), watermarkDialog = shallowRef<MediaAsset[] | null>(null)
const automaticWatermark = ref(true)
// 普通预览每次先显示原图，水印只在当前照片主动开启。
// 现按全局水印开关统一显示，打开或切图不再重置单张状态。
const previewWatermark = computed(() => automaticWatermark.value)
const watermarkDisplayMemory = new Map<string, boolean>()

/** 显示偏好按宝宝保存，只切换叠加层，不触发媒体处理或相册同步。 */
function toggleAutomaticWatermark(): void {
  const id = selectedBabyId.value
  if (!id) return
  automaticWatermark.value = !automaticWatermark.value
  watermarkDisplayMemory.set(id, automaticWatermark.value)
  try { localStorage.setItem(`momentnest.growth-display.v1.${id}`, automaticWatermark.value ? 'on' : 'off') } catch { /* 存储不可用时保留本次会话的显示偏好。 */ }
}
function automaticStamp(asset: MediaAsset, enabled = automaticWatermark.value) {
  return enabled && props.module === 'baby' && baby.value && !similarReference.value && props.page !== 'references'
    ? growthStamp(asset, baby.value) : null
}
watch(selectedBabyId, id => {
  let enabled = watermarkDisplayMemory.get(id) ?? true
  if (!watermarkDisplayMemory.has(id)) {
    try { const saved = localStorage.getItem(`momentnest.growth-display.v1.${id}`); if (saved === 'on' || saved === 'off') enabled = saved === 'on' } catch { /* 查看照片不依赖浏览器存储可用。 */ }
    watermarkDisplayMemory.set(id, enabled)
  }
  automaticWatermark.value = enabled
})
let pollTimer: ReturnType<typeof setInterval> | undefined, searchTimer: ReturnType<typeof setTimeout> | undefined
const progressNow = ref(Date.now())
let lastScanBrowseRefresh = 0
let familySequence = 0, querySequence = 0, detailSequence = 0, refreshing = false, kindBeforeWatermark = ''
let mediaObserver: IntersectionObserver | undefined
let mediaAppendPromise: Promise<void> | null = null, mediaAppendQuery = -1, navigationSequence = 0
let disposed = false
let restoringView = false, lastScrollTop = 0, paginationDirty = false, scrollHost: HTMLElement | null = null, viewSequence = 0
let mediaBrowseRevision: string | undefined
let failedBrowseRevision: string | undefined
let pendingBabyBrowseReset = false
let thumbnailActive = 0
const thumbnailPending = new Set<string>(), thumbnailFailed = new Set<string>()
const thumbnailImageRetries = new Set<string>(), thumbnailErrors = reactive<Record<string, boolean>>({})
const failedVisibleThumbnails = computed(() => visibleAssets.value.filter(asset => thumbnailErrors[asset.id]).length)
let thumbnailQueue: {asset:Pick<MediaAsset,'id'|'date'|'available'>;sequence:number;contextId?:string;accessId?:string;key:string;pinned?:boolean}[] = []

const today = new Date().toLocaleDateString('sv-SE')
const baby = computed(() => family.value?.babies.find(item => item.id === selectedBabyId.value) ?? null)
const modelLoading = computed(() => !family.value || !family.value.modelReady && !family.value.modelError)
const currentAge = computed(() => baby.value ? calendarAge(baby.value.birthday, today) : null)
const months = computed(() => Array.from({ length: (currentAge.value?.months ?? 0) + 1 }, (_, index) => index))
const enabledRoots = computed(() => props.receiver?.roots.filter(item => item.enabled) ?? [])
const libraryId = computed(() => props.receiver?.currentLibraryId ?? undefined)
const currentLibrary = computed(() => props.receiver?.libraries.find(item => item.id === libraryId.value))
const babyAvatarId = computed(() => baby.value?.avatarAssetId ?? baby.value?.referenceFaces.find(face => thumbnails[face.assetId])?.assetId ?? baby.value?.referenceFaces[0]?.assetId)
const visibleMonths = computed(() => months.value.slice(Math.max(0, months.value.length - 8)))
const growthRange = computed(() => baby.value && !['all', 'pending'].includes(growthMonth.value) ? monthRange(baby.value.birthday, Number(growthMonth.value)) : null)
const selectionMode = ref(false)
const enabledLibraries = computed(() => props.receiver?.libraries.filter(item => item.enabled) ?? [])
const importSourcePath = computed(() => enabledRoots.value.find(root => root.id === importRoot.value)?.path ?? '')
const copyTargetError = computed(() => importMode.value === 'copy' ? copyDirectoryError(importSourcePath.value, currentLibrary.value?.path ?? '') : null)
const items = computed(() => media.value?.items ?? [])
/** 保持查询日期顺序，在当前月份按日、较早媒体按月展示。 */
/** 月份统一分组，日期未知项独立展示，组内沿用查询的稳定顺序。 */
const dateGroups = computed(() => {
  const groups = new Map<string, MediaAsset[]>()
  for (const asset of items.value) {
    const key = asset.date?.slice(0, 7) ?? 'unknown'
    const group = groups.get(key)
    if (group) group.push(asset)
    else groups.set(key, [asset])
  }
  return [...groups].map(([key, assets]) => ({ key, assets, label: key === 'unknown' ? '日期待确认' : `${Number(key.slice(0, 4))}年${Number(key.slice(5))}月` }))
})
const monthsCollapsed = computed(() => dateGroups.value.some(group => isMonthCollapsed(group.key)))
const pageCount = computed(() => Math.max(1, Math.ceil((media.value?.total ?? 0) / (media.value?.limit ?? 50))))
const moreAvailable = computed(() => Boolean(media.value && items.value.length < media.value.total))
const peopleOverview = computed(() => props.page === 'people' && !filters.personId && !filters.ungroupedFaces && !similarReference.value)
const currentPerson = computed(() => family.value?.people.find(person => person.id === (similarReference.value?.personId ?? filters.personId)))
const babyAllScope = computed(() => props.module === 'baby' && babyMatchScope.value === 'all' && ['timeline','matches','candidates'].includes(props.page))
const mediaAccessLibraryId = computed(() => profileReferencePreview.value || similarReference.value && similarScope.value === 'all' || babyAllScope.value ? undefined : libraryId.value)
const babyMatchStatus = computed(() => family.value?.babyMatching?.find(item => item.babyId === baby.value?.id && item.scope === babyMatchScope.value && (item.scope === 'all' || item.libraryId === libraryId.value)))
const babyMatchRunning = computed(() => babyMatchStatus.value?.state === 'running' && !babyMatchStatus.value.rebuilding)
const jobs = computed(() => family.value?.jobs ?? [])
const faceAnalysisJob = computed(() => jobs.value.find(job => job.kind === 'faces' && job.state === 'running'))
const faceAnalysisBusy = computed(() => Boolean(faceAnalysisJob.value))
const currentRebuild = computed(() => family.value?.faceRebuilds?.find(status => status.libraryId === libraryId.value))
const visibleRebuilds = computed(() => (family.value?.faceRebuilds ?? []).filter(status => props.module === 'baby' && babyMatchScope.value === 'all' || status.libraryId === libraryId.value))
const babyRebuildBlocked = computed(() => visibleRebuilds.value.length > 0 || Boolean(babyMatchStatus.value?.rebuilding))
const supplementDisabled = computed(() => busy.value || !family.value?.modelReady || faceAnalysisBusy.value || babyRebuildBlocked.value)
const babySupplementPending = computed(() => babyMatchStatus.value?.coverage.supplementPending ?? (babyMatchScope.value === 'library' ? family.value?.analysis?.supplementPending ?? 0 : 0))
const supplementScopeLabel = computed(() => babyMatchScope.value === 'all' ? '全部已授权目录' : '当前照片库')
const runningJobCount = computed(() => jobs.value.filter(job => job.state === 'running').length)
const failedJobCount = computed(() => jobs.value.filter(job => job.state === 'error').length)
const activeMediaJobs = computed(() => jobs.value.filter(job => job.state === 'running' && (job.kind === 'scan' || job.kind === 'import')))
const preparing = computed(() => importPlan.value?.state === 'preparing' || family.value?.importPlans?.some(plan => plan.state === 'preparing'))
const preparationJob = computed(() => preparing.value ? activeMediaJobs.value.find(job => job.kind === 'scan') : activeMediaJobs.value[0])
const scanImportBusy = computed(() => Boolean(props.receiver?.scanning || activeMediaJobs.value.length || preparing.value))
const latestLibraryScan = computed(() => jobs.value.find(job => job.kind === 'scan' && job.libraryId === libraryId.value && job.scanPurpose !== 'import-preview'))
const prepareButtonLabel = computed(() => preparing.value ? `正在预扫描 · 已处理 ${preparationJob.value?.processed ?? 0} 项` : preparationJob.value ? `正在${preparationJob.value.kind === 'scan' ? '扫描图库' : '处理导入'} · 已处理 ${preparationJob.value.processed} 项` : props.receiver?.scanning ? '正在核对历史目录…' : '预览导入计划')
const selectedFace = computed(() => detail.value?.faces.find(face => face.id === selectedFaceId.value) ?? null)
const canSelectBabyFace = computed(() => Boolean(!profileReferencePreview.value && baby.value && (props.module === 'baby' || props.page === 'references')))
const referencePicking = computed(() => referenceQueue.value.length > 0)
const previewItems = computed(() => groupingInspection.value && inspectionMedia.value ? inspectionMedia.value.items : items.value)
const previewMoreAvailable = computed(() => groupingInspection.value && inspectionMedia.value ? inspectionMedia.value.items.length < inspectionMedia.value.total : moreAvailable.value)
const detailIndex = computed(() => previewItems.value.findIndex(asset => asset.id === detail.value?.id))
const detailCounter = computed(() => detailIndex.value >= 0 ? `${detailIndex.value + 1} / ${groupingInspection.value ? inspectionMedia.value?.total : media.value?.total ?? items.value.length}` : '')
const canPreviewPrevious = computed(() => !profileReferencePreview.value && !referencePicking.value && (detailIndex.value >= 0 ? detailIndex.value > 0 : previewDetachedIndex.value !== null && previewDetachedIndex.value > 0))
const canPreviewNext = computed(() => {
  if (profileReferencePreview.value || referencePicking.value) return false
  const nextIndex = detailIndex.value >= 0 ? detailIndex.value + 1 : previewDetachedIndex.value
  return nextIndex !== null && nextIndex >= 0 && (nextIndex < previewItems.value.length || previewMoreAvailable.value && !loading.value)
})
const referenceCandidates = computed(() => [...selected.value.values()].filter(asset => asset.kind === 'photo' && asset.available))
const activeWatermark = computed(() => items.value.find(item => item.id === activeWatermarkId.value) ?? selected.value.get(activeWatermarkId.value) ?? null)
const watermarkAssets = computed(() => selected.value.size ? [...selected.value.values()] : activeWatermark.value ? [activeWatermark.value] : [])
const titles: Record<string, string> = { folder: '导入与归档', all: '照片与视频', people: '人物', favorites: '收藏', timeline: '成长相册', matches: '宝宝匹配结果', candidates: '待确认', references: '人脸参考', watermark: '成长水印', profile: '宝宝档案' }
const title = computed(() => titles[props.page] ?? '本地照片与视频')
const dateLabel = (source: DateSource) => ({ capture: '拍摄日期', creation: '文件创建日期', manual: '手动确认日期', unknown: '日期未知' })[source]
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const errorText = userError
const ageFor = (asset: MediaAsset) => baby.value ? hasReliableDate(asset, baby.value) ? calendarAge(baby.value.birthday, asset.date)?.text : '拍摄日期待确认' : undefined
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
/** 预扫描边读取边发现数量，只有总量明确且尚有剩余时才显示百分比。 */
const successfulCount = (job: FamilyJob) => job.kind === 'faces' && !job.warningReportId ? Math.max(0, job.processed - (job.skipped ?? 0)) : job.processed
const handledCount = (job: FamilyJob) => successfulCount(job) + (job.skipped ?? 0)
const hasDeterminateProgress = (job: FamilyJob) => job.kind === 'scan' ? hasScanTotal(job) : job.total > 0
const progressValue = (job: FamilyJob) => job.kind === 'scan' ? scanProgressValue(job) : hasDeterminateProgress(job) ? job.processed : undefined
const progressMaximum = (job: FamilyJob) => Math.max(1, job.kind === 'scan' ? job.scanTotal ?? job.total : job.total)
const scanTiming = (job: FamilyJob) => scanTimingLabel(job, progressNow.value)
/** 图库与处理记录共用本轮估算，文件统计阶段不冒充已完成索引。 */
const scanStatusLabel = (job: FamilyJob) => job.scanPhase === 'counting'
  ? `正在统计文件数量 · 已发现 ${job.scanTotal ?? 0} 个文件 · ${scanTiming(job)}`
  : `正在扫描 · 已处理 ${handledCount(job)}${hasScanTotal(job) ? ` / ${job.scanTotal}` : ''} 个文件 · ${scanTiming(job)}`
/** 成功、跳过和中断后的剩余数量分开显示，目录扫描不猜测尚未发现的总量。 */
const jobProgressLabel = (job: FamilyJob) => {
  const result = `成功 ${successfulCount(job)} 项${job.skipped ? ` · 跳过 ${job.skipped} 项` : ''}`
  if (job.state === 'done') return job.kind !== 'scan' && job.total > handledCount(job) ? `已停止 · ${result} · 未处理 ${job.total - handledCount(job)} 项` : `${job.skipped ? '部分完成' : '已完成'} · ${result}`
  if (job.state === 'error') return `已中断 · ${result}${job.kind === 'scan' ? ' · 剩余范围未核对' : ` · 未处理 ${Math.max(0, job.total - handledCount(job))} 项`}`
  if (job.scanPhase === 'counting') return `正在统计文件数量 · 已发现 ${job.scanTotal ?? 0} 项`
  if (job.kind === 'scan' && hasScanTotal(job)) return `正在扫描 · 已处理 ${handledCount(job)} / ${job.scanTotal} 项 · ${result}`
  return hasDeterminateProgress(job) ? `处理中 · ${Math.min(job.total, handledCount(job))} / ${job.total} 项 · ${result}` : `${job.kind === 'scan' ? preparing.value ? '正在预扫描' : '正在扫描' : '处理中'} · ${result}`
}

/** 只刷新真实记录；分析任务完成时重新读取图库，避免每次轮询加载全库。 */
async function refreshFamily(force = false, reloadMedia = true): Promise<void> {
  if (disposed || !api || !libraryId.value || (refreshing && !force)) return
  const contextId = libraryId.value, sequence = ++familySequence
  refreshing = true
  try {
    const result = await api.getFamilyState(contextId)
    if (sequence !== familySequence || contextId !== libraryId.value) return
    const previous = family.value
    const previousStates = new Map(previous?.jobs.map(job => [job.id, job.state]) ?? [])
    // 只为新任务或新的失败展开一次，历史失败和轮询不改变用户的收起选择。
    if (result.jobs.some(job => job.state === 'running' && previousStates.get(job.id) !== 'running' || job.state === 'error' && previous !== null && previousStates.get(job.id) !== 'error')) markProcessingUnread()
    // 新跳过或本次部分完成仅提醒一次，旧记录和重复轮询仍尊重用户收起选择。
    if (previous !== null && result.jobs.some(job => (job.skipped ?? 0) > 0 && ((previous.jobs.find(item => item.id === job.id)?.skipped ?? 0) === 0 || job.state === 'done' && previousStates.get(job.id) === 'running'))) markProcessingUnread()
    family.value = result
    const finishedAnalysis = result.jobs.find(job => job.kind === 'faces' && job.state !== 'running' && previousStates.get(job.id) === 'running')
    if (finishedAnalysis) notice.value = finishedAnalysis.state === 'done' ? `人脸分析已完成 · ${jobProgressLabel(finishedAnalysis)}，结果已保存在本机。` : `人脸分析已中断 · ${jobProgressLabel(finishedAnalysis)}，可在处理记录查看原因并继续未完成项。`
    if (!family.value.babies.some(item => item.id === selectedBabyId.value)) selectedBabyId.value = family.value.babies[0]?.id ?? ''
    if (importPlan.value) importPlan.value = family.value.importPlans?.find(item => item.id === importPlan.value?.id) ?? importPlan.value
    const matchFinished = result.babyMatching?.some(status => status.babyId === selectedBabyId.value && status.scope === babyMatchScope.value && (status.scope==='all'||status.libraryId===contextId) && status.state !== 'running' && previous?.babyMatching?.find(item => item.babyId === status.babyId)?.state === 'running')
    if (matchFinished && !previous?.babyMatching?.some(status => status.rebuilding)) notice.value = matchingNotice()
    const changedExternally = !busy.value && !loading.value && media.value !== null && mediaBrowseRevision !== result.browseRevision && failedBrowseRevision !== result.browseRevision && !result.jobs.some(job=>job.state==='running') && !result.babyMatching?.some(status=>status.state==='running')
    // 首批未填满时逐步显示扫描结果，滚动、选择或预览中的图库保持原位置。
    const scanGrowing = props.module === 'library' && props.page === 'all' && !similarReference.value && !busy.value && !loading.value && !loadingMore.value && !selectionMode.value && !detail.value && (scrollHost?.scrollTop ?? 0) < 32 && browsePage.value === 1 && items.value.length < 50 && mediaBrowseRevision !== result.browseRevision && result.photoCount + result.videoCount > (previous?.photoCount ?? 0) && result.jobs.some(job => job.kind === 'scan' && job.state === 'running' && job.scanPurpose !== 'import-preview' && job.libraryId === contextId) && progressNow.value - lastScanBrowseRefresh >= 4000
    if (reloadMedia && !restoringView && previous !== null && (changedExternally || matchFinished || scanGrowing || result.jobs.some(job => job.state !== 'running' && previousStates.get(job.id) !== job.state))) { if (scanGrowing) lastScanBrowseRefresh = progressNow.value; void loadMedia() }
    /* 不可用参考图保留记录，界面提示原文件不可用。 */
    for (const profile of family.value.babies) for (const reference of profile.referenceFaces) {
      const key = `${contextId}:reference:${reference.assetId}`
      if (!thumbnails[reference.assetId]&&!thumbnailPending.has(key)&&!thumbnailFailed.has(key)) {
        thumbnailPending.add(key);thumbnailQueue.push({asset:{id:reference.assetId,date:null,available:true},sequence:querySequence,contextId,key,pinned:true})
      }
    }
    drainThumbnails()
  } catch (error) { if (sequence === familySequence) notice.value = errorText(error) } finally { if (sequence === familySequence) refreshing = false }
}

function mediaQuery(): MediaQuery {
  const query: MediaQuery = { page: 1, limit: 50, libraryId: babyAllScope.value ? undefined : libraryId.value, order: filters.order }
  if (babyAllScope.value) query.scope = 'all'
  if (filters.search.trim()) query.search = filters.search.trim()
  if (filters.kind) query.kind = filters.kind as 'photo' | 'video'
  if (filters.source) query.source = filters.source as 'folder' | 'phone'
  if (filters.dateSource) query.dateSource = filters.dateSource as DateSource
  if (filters.personId) query.personId = filters.personId
  if (filters.ungroupedFaces) query.ungroupedFaces = true
  if (filters.from) query.from = filters.from
  if (filters.to) query.to = filters.to
  if (props.module === 'library' && props.page === 'favorites') query.favorite = true
  if (props.module === 'baby' && baby.value && props.page !== 'references' && props.page !== 'profile') {
    query.babyId = baby.value.id
    if (props.page === 'candidates') query.candidates = true
    if (props.page === 'matches' || props.page === 'timeline') {
      if (babyResultFilter.value === 'unconfirmed') query.unconfirmed = true
      else if (babyResultFilter.value === 'candidate') query.candidates = true
      else if (babyResultFilter.value === 'all') query.includeCandidates = true
    }
    if (props.page === 'timeline' && babyResultFilter.value !== 'unconfirmed') {
      if (growthMonth.value === 'pending') query.datePending = true
      else if (growthMonth.value !== 'all') Object.assign(query, monthRange(baby.value.birthday, Number(growthMonth.value)), { datePending: false })
    }
    if (props.page === 'watermark') query.kind = 'photo'
  }
  return query
}

/** 相似查找只按所选人脸、范围、类型和排序分页，不沿用原分组或日期筛选。 */
function browseQuery(): MediaQuery | SimilarFaceQuery {
  const reference = similarReference.value
  if (!reference) return mediaQuery()
  return { assetId: reference.assetId, faceId: reference.faceId, scope: similarScope.value, ...(similarScope.value === 'library' ? { libraryId: libraryId.value } : {}), page: 1, limit: 50, ...(filters.kind ? { kind: filters.kind as 'photo' | 'video' } : {}), order: filters.order }
}
function queryAssets(query: MediaQuery | SimilarFaceQuery): Promise<MediaPage | SimilarFacePage> { return 'faceId' in query ? api!.querySimilarFaces(query) : api!.queryMedia(query) }

async function loadMedia(): Promise<void> {
  if (disposed) return
  const sequence = ++querySequence
  const contextId = libraryId.value
  const revision = family.value?.browseRevision
  failedBrowseRevision = undefined
  loadingMore.value = false; loadMoreError.value = ''
  if (!api || !libraryId.value || props.module === 'import' || (props.module === 'baby' && !baby.value)) { media.value = null; loading.value = false; return }
  loading.value = true
  try {
    const query = plainData(browseQuery()), pages = browsePage.value
    let result = await queryAssets(query)
    if (sequence !== querySequence || contextId !== libraryId.value) return
    if (!similarReference.value && props.module === 'baby' && baby.value) {
      const scopeQuery = { babyId: baby.value.id, ...(babyMatchScope.value === 'all' ? {scope:'all' as const} : {libraryId: contextId}), page: 1, limit: 1 }
      const [candidates, unconfirmed] = await Promise.all([api.queryMedia({ ...scopeQuery, candidates: true }), api.queryMedia({ ...scopeQuery, unconfirmed: true })])
      if (sequence !== querySequence || contextId !== libraryId.value) return
      babyCandidateCount.value = candidates.total
      babyUnconfirmedCount.value = unconfirmed.total
    }
    if (!similarReference.value && props.module === 'baby' && ['matches','timeline','candidates'].includes(props.page)) {
      const membershipQuery = { ...query } as MediaQuery
      delete membershipQuery.includeCandidates
      delete membershipQuery.candidates
      delete membershipQuery.unconfirmed
      const counts = await Promise.all([api.queryMedia({ ...membershipQuery, page: 1, limit: 1 }), api.queryMedia({ ...membershipQuery, page: 1, limit: 1, candidates: true })])
      if (sequence !== querySequence || contextId !== libraryId.value) return
      babyMatchCounts.value = { included: counts[0].total, candidates: counts[1].total }
    }
    const lastPage = Math.max(1, Math.ceil(result.total / result.limit))
    for (let page = 2; page <= Math.min(pages, lastPage); page++) {
      const next = await queryAssets({ ...query, page })
      if (sequence !== querySequence || contextId !== libraryId.value) return
      result = { ...next, items: [...result.items, ...next.items] }
    }
    browsePage.value = Math.min(pages, lastPage)
    result.items = [...new Map(result.items.map(asset => [asset.id, asset])).values()]
    preservePreviewPosition(result.items)
    media.value = result
    mediaBrowseRevision = revision
    paginationDirty = false
    similarResult.value = 'coverage' in result ? result : null
    if (detail.value) detail.value = result.items.find(asset => asset.id === detail.value?.id) ?? detail.value
    for (const asset of result.items) if (selected.value.has(asset.id)) selected.value.set(asset.id, asset)
    void loadThumbnails(visibleAssets.value, sequence, contextId)
    if (props.page === 'watermark' && !activeWatermark.value) activeWatermarkId.value = result.items.find(asset => baby.value && asset.available && hasReliableDate(asset, baby.value))?.id ?? ''
  } catch (error) { if (sequence === querySequence) { failedBrowseRevision = revision; notice.value = errorText(error) } } finally { if (sequence === querySequence) loading.value = false }
}

/** 每次只追加一批，排序、筛选或切库变化后丢弃迟到的上一批。 */
async function loadMore(): Promise<void> {
  if (mediaAppendPromise && mediaAppendQuery === querySequence) return mediaAppendPromise
  const pending = appendMediaPage()
  mediaAppendPromise = pending; mediaAppendQuery = querySequence
  try { await pending } finally { if (mediaAppendPromise === pending) mediaAppendPromise = null }
}

/** 预览切到分页末尾时复用图库追加请求，避免与自动加载重复读取。 */
async function appendMediaPage(): Promise<void> {
  if (disposed || !api || loading.value || loadingMore.value || folding.value || !moreAvailable.value || peopleOverview.value) return
  const sequence = querySequence, contextId = libraryId.value, query = plainData(browseQuery()), page = paginationDirty ? Math.max(1, Math.floor(items.value.length / (media.value?.limit ?? 50)) + 1) : browsePage.value + 1
  const identity = JSON.stringify(query)
  loadingMore.value = true; loadMoreError.value = ''
  try {
    const result = await queryAssets({ ...query, page })
    if (sequence !== querySequence || contextId !== libraryId.value || identity !== JSON.stringify(browseQuery())) return
    media.value = { ...result, items: [...new Map([...items.value, ...result.items].map(asset => [asset.id, asset])).values()] }
    similarResult.value = 'coverage' in result ? result : null
    browsePage.value = page
    paginationDirty = false
    void loadThumbnails(visibleAssets.value, sequence, contextId)
  } catch (error) { if (sequence === querySequence) loadMoreError.value = errorText(error) }
  finally { if (sequence === querySequence) loadingMore.value = false }
}

/** 限制预览请求并发，避免一批照片同时抢占解码资源。 */
async function loadThumbnails(assets: MediaAsset[], sequence: number, contextId?: string): Promise<void> {
  for (const asset of assets) {
    const key = `${sequence}:${contextId}:${asset.id}`
    if (!asset.available || thumbnails[asset.id] || thumbnailPending.has(key) || thumbnailFailed.has(key) || isMonthCollapsed(asset.date?.slice(0,7)??'unknown')) continue
    thumbnailPending.add(key); thumbnailQueue.push({asset,sequence,contextId,accessId:mediaAccessLibraryId.value,key})
  }
  drainThumbnails()
}
/** 滚动、展开和分页共用六个请求名额，离开可视区的排队照片不继续解码。 */
function drainThumbnails(): void {
  if (disposed || !api) return
  const visible = new Set(visibleAssets.value.map(asset=>asset.id))
  while (thumbnailActive<6 && thumbnailQueue.length) {
    const request = thumbnailQueue.shift()!
    if (thumbnails[request.asset.id]||request.contextId!==libraryId.value||!request.pinned&&(request.sequence!==querySequence||!visible.has(request.asset.id)||isMonthCollapsed(request.asset.date?.slice(0,7)??'unknown'))) {thumbnailPending.delete(request.key);continue}
    thumbnailActive++
    void api.mediaUrl(request.asset.id,true,request.accessId).then(url=>{if(!disposed&&(request.pinned||request.sequence===querySequence)&&request.contextId===libraryId.value){thumbnails[request.asset.id]=url;delete thumbnailErrors[request.asset.id]}}).catch(()=>{
      /* 不支持解码时保留媒体占位与原文件操作。 */
      thumbnailFailed.add(request.key)
      if (!disposed && request.contextId === libraryId.value && request.sequence === querySequence) thumbnailErrors[request.asset.id] = true
    }).finally(()=>{thumbnailActive--;thumbnailPending.delete(request.key);drainThumbnails()})
  }
}

function loadVisibleThumbnails(assets: MediaAsset[]): void { visibleAssets.value = assets; if (api) void loadThumbnails(assets, querySequence, libraryId.value) }

/** 失效的预览地址仅自动更新一次，持续失败时提供明确重试入口。 */
function thumbnailLoadFailed(asset: MediaAsset): void {
  if (disposed || !visibleAssets.value.some(item => item.id === asset.id)) return
  delete thumbnails[asset.id]
  const key = `${querySequence}:${libraryId.value}:${asset.id}`
  if (thumbnailImageRetries.has(key)) { thumbnailFailed.add(key); thumbnailErrors[asset.id] = true; return }
  thumbnailImageRetries.add(key); thumbnailFailed.delete(key)
  void loadThumbnails([asset], querySequence, libraryId.value)
}

/** 手动重试只读取当前可视区，不重新扫描原照片。 */
function retryThumbnails(): void {
  thumbnailFailed.clear(); thumbnailImageRetries.clear()
  for (const id of Object.keys(thumbnailErrors)) delete thumbnailErrors[id]
  void loadThumbnails(visibleAssets.value, querySequence, libraryId.value)
}
function babyDecision(asset: MediaAsset) { return asset.babyDecisions?.find(item => item.babyId === selectedBabyId.value) }
/** 缺少识别证据仍需核对，只有人工排除才视为用户明确判定不是宝宝。 */
function isBabyUnconfirmed(asset: MediaAsset): boolean {
  if (!baby.value || asset.babyIds.includes(baby.value.id)) return false
  const decision = babyDecision(asset)
  return decision?.state !== 'included' && decision?.state !== 'candidate' && !(decision?.state === 'excluded' && decision.origin === 'manual')
}
function babyStatus(asset: MediaAsset): string {
  if (props.module !== 'baby' || !baby.value || similarReference.value || ['references','watermark'].includes(props.page)) return ''
  const decision = babyDecision(asset)
  if (decision?.rebuildPending) return decision.state === 'candidate' ? '重扫前疑似' : '重扫前结果'
  if (decision?.state === 'excluded' && decision.origin === 'manual') return '人工排除'
  if (isBabyUnconfirmed(asset)) return '待核对'
  return decision?.state === 'candidate' ? '疑似' : decision?.origin === 'manual' ? '人工确认' : '自动匹配'
}
/** 预览保留后台给出的待核对原因，旧缓存没有说明时按可用证据提示。 */
function babyReviewReason(asset: MediaAsset): string {
  if (!isBabyUnconfirmed(asset)) return ''
  if (asset.babyReviewReason) return asset.babyReviewReason
  if (asset.faceState === 'pending') return '尚未分析人脸，仍需人工核对。'
  if (asset.faceState === 'error') return `人脸分析失败${asset.faceError ? `：${asset.faceError}` : '，仍需人工核对。'}`
  if (!asset.faces.length) return '未检测到可用人脸，仍需人工核对。'
  if (babyDecision(asset)?.score !== undefined) return '人脸相似度不足，仍需人工核对。'
  return '尚无足够的宝宝识别证据，可直接人工确认。'
}
function isBabyReference(asset: MediaAsset): boolean { return Boolean(baby.value && (asset.babyReferenceIds?.includes(baby.value.id) || baby.value.referenceFaces.some(face => face.assetId === asset.id))) }
/** 照片移出当前查询后保留原图，并按仍在列表中的前项恢复导航位置。 */
function preservePreviewPosition(nextItems: MediaAsset[]): void {
  if (!detail.value || groupingInspection.value) return
  if (nextItems.some(asset => asset.id === detail.value?.id)) { previewDetachedIndex.value = null; return }
  const currentIndex = items.value.findIndex(asset => asset.id === detail.value?.id)
  const anchor = currentIndex >= 0 ? currentIndex : previewDetachedIndex.value
  if (anchor === null) return
  const precedingIds = new Set(items.value.slice(0, anchor).map(asset => asset.id))
  previewDetachedIndex.value = nextItems.filter(asset => precedingIds.has(asset.id)).length
}
/** 记录变化直接替换当前照片，分页发生位移时补读重叠页，避免漏过下一张。 */
function patchAssets(updates: Map<string, MediaAsset>, remove: (asset: MediaAsset) => boolean = () => false, mutation?: BrowseMutation): void {
  // 局部修改使尚未返回的旧查询失效，避免追加结果恢复旧归属和旧总数。
  querySequence++; loading.value = false; loadingMore.value = false
  if (media.value) {
    const patched = items.value.map(asset => updates.get(asset.id) ?? asset), kept = patched.filter(asset => !remove(asset))
    // 当前照片移出筛选后仍保留预览，以原位置继续查看相邻的待核对项目。
    preservePreviewPosition(kept)
    if (kept.length !== patched.length) paginationDirty = true
    media.value = { ...media.value, items: kept, total: Math.max(0, media.value.total - (patched.length - kept.length)) }
    if (mutation && mutation.before === mediaBrowseRevision && mutation.after === family.value?.browseRevision) mediaBrowseRevision = mutation.after
  }
  for (const [id, asset] of updates) if (selected.value.has(id)) selected.value.set(id, asset)
  if (detail.value && updates.has(detail.value.id)) detail.value = updates.get(detail.value.id)!
}

/** 在内容滚动区接近底部时加载下一批，手动按钮保留失败后的重试入口。 */
async function observeMediaEnd(): Promise<void> {
  await nextTick(); mediaObserver?.disconnect()
  if (disposed || folding.value || !mediaSentinel.value || peopleOverview.value) return
  mediaObserver = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !loadMoreError.value) void loadMore() }, { root: mediaSentinel.value.closest('.page-content'), rootMargin: '0px 0px 240px 0px' })
  mediaObserver.observe(mediaSentinel.value)
}

/** 写入成功后读取新状态，使写入前的后台轮询回执失效。 */
async function run(action: () => Promise<unknown>, success = '', reload = true): Promise<boolean> {
  if (!api || busy.value) return false
  busy.value = true; notice.value = ''
  try { await action(); await refreshFamily(true, false); if (reload) await loadMedia(); emit('refresh-receiver'); if (success) notice.value = success; return true }
  catch (error) { notice.value = errorText(error); return false } finally { busy.value = false }
}
/** 操作完成后收起工具菜单，避免遮挡照片或下一个页面。 */
function closeToolMenu(): void { closePopupMenus() }
/** 同步原生折叠状态，让后续轮询尊重用户的选择。 */
/** 新进度只提示入口，详细记录由用户明确打开。 */
function markProcessingUnread(): void { if (!props.recordsOpen) jobsUnread.value = true }
function closeProcessingRecords(): void { emit('close-records') }
/** 原生弹窗保留键盘焦点隔离，仅点击内容框之外才关闭。 */
function handleProcessingBackdrop(event: MouseEvent): void {
  const dialog = recordsDialog.value
  if (!dialog || event.target !== dialog) return
  const bounds = dialog.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeProcessingRecords()
}
function resetQuery(): void { if (restoringView) return; closeProfile(); closePreview(); resetMonthCollapse(); browsePage.value = 1; paginationDirty = false; media.value = null; similarResult.value = null; document.querySelector('.page-content')?.scrollTo({ top: 0 }); void loadMedia() }
function viewKey(module = props.module, page = props.page, id = libraryId.value): string { return `${id ?? ''}|${module}|${page}` }
function saveBrowse(module = props.module, page = props.page, id = libraryId.value): void {
  if (!id || !media.value || similarReference.value || module === 'import') return
  rememberBrowse(viewKey(module,page,id), { media: media.value, page: browsePage.value, babyId: selectedBabyId.value, growthMonth: growthMonth.value, resultFilter: babyResultFilter.value, matchScope: babyMatchScope.value, filters: {...filters}, collapsed: collapseNewMonths.value, overrides: new Map(monthCollapseOverrides.value), selected: new Map(selected.value), selectionMode: selectionMode.value, scroll: lastScrollTop, paginationDirty, revision: mediaBrowseRevision, candidateCount: babyCandidateCount.value, unconfirmedCount: babyUnconfirmedCount.value, matchCounts: { ...babyMatchCounts.value } })
}
/** 模块返回时恢复同库的月份、筛选和浏览位置，过期查询不能覆盖恢复的内容。 */
async function restoreBrowse(): Promise<boolean> {
  const snapshot = recallBrowse(viewKey())
  if (!snapshot || props.module === 'baby' && !family.value?.babies.some(profile=>profile.id===snapshot.babyId)) return false
  let sequence = ++querySequence
  const view = viewSequence, contextId = libraryId.value
  restoringView = true
  selectedBabyId.value = snapshot.babyId; growthMonth.value = snapshot.growthMonth; babyResultFilter.value = snapshot.resultFilter; babyMatchScope.value = snapshot.matchScope
  Object.assign(filters,snapshot.filters); collapseNewMonths.value = snapshot.collapsed; monthCollapseOverrides.value = new Map(snapshot.overrides)
  media.value = snapshot.media; browsePage.value = snapshot.page; selected.value = new Map(snapshot.selected); selectionMode.value = snapshot.selectionMode
  mediaBrowseRevision = snapshot.revision
  babyCandidateCount.value = snapshot.candidateCount; babyMatchCounts.value = { ...snapshot.matchCounts }
  babyUnconfirmedCount.value = snapshot.unconfirmedCount ?? 0
  loading.value = false; loadingMore.value = false; loadMoreError.value = ''; paginationDirty = snapshot.paginationDirty
  // 其他模块改变相册记录后只更新已加载页，浏览位置和折叠状态继续保留。
  if (snapshot.revision !== family.value?.browseRevision) {
    await loadMedia()
    if (disposed || view !== viewSequence || contextId !== libraryId.value) return true
    sequence = querySequence
  }
  await nextTick(); await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))
  if (view === viewSequence && sequence === querySequence && !disposed) { lastScrollTop = snapshot.scroll; document.querySelector('.page-content')?.scrollTo({top:snapshot.scroll}); virtualGallery.value?.refresh() }
  if (view === viewSequence) restoringView = false
  return true
}
function recordScroll(): void { lastScrollTop = scrollHost?.scrollTop ?? 0 }
/** 折叠仅改变展示；暂停自动追加，避免收起照片后立即请求整个图库。 */
/** 折叠不再暂停分页；只延迟收起月份的缩略图，新增月份继承全部折叠的选择。 */
function isMonthCollapsed(key: string): boolean { return monthCollapseOverrides.value.get(key) ?? collapseNewMonths.value }
function resetMonthCollapse(): void { foldingSequence++; folding.value = false; collapseNewMonths.value = false; monthCollapseOverrides.value.clear() }
async function toggleMonth(key: string, event: MouseEvent): Promise<void> {
  if (folding.value) return
  const heading = event.currentTarget as HTMLElement, scroll = heading.closest<HTMLElement>('.page-content'), top = heading.getBoundingClientRect().top
  const collapsed = !isMonthCollapsed(key)
  monthCollapseOverrides.value.set(key, collapsed)
  await nextTick()
  if (scroll && heading.isConnected) scroll.scrollTop += heading.getBoundingClientRect().top - top
  virtualGallery.value?.refresh()
}
/** 先绘制操作提示，再更新月份；收起后回到工具栏，避免内容缩短时停在页尾。 */
async function setAllMonthsCollapsed(collapsed: boolean): Promise<void> {
  if (folding.value) return
  const sequence = ++foldingSequence, scroll = document.querySelector<HTMLElement>('.page-content')
  folding.value = true; expandingMonths.value = !collapsed
  await nextTick()
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (disposed || sequence !== foldingSequence) return
  if (collapsed && scroll) scroll.scrollTop = 0
  collapseNewMonths.value = collapsed; monthCollapseOverrides.value.clear()
  await nextTick()
  if (disposed || sequence !== foldingSequence) return
  if (collapsed && scroll) scroll.scrollTop = 0
  folding.value = false
  virtualGallery.value?.refresh()
}
function expandAllMonths(): Promise<void> { return setAllMonthsCollapsed(false) }
function collapseAllMonths(): Promise<void> { return setAllMonthsCollapsed(true) }
/** 刷新仅重读索引；重新扫描由明确点击发起，递归补齐当前库。 */
async function refreshGallery(): Promise<void> { if (!loading.value && !busy.value) { retryThumbnails(); await refreshFamily(false, false); await loadMedia() } }
async function rescanGallery(): Promise<void> {
  if (!api || !libraryId.value || !props.receiver?.currentLibraryAvailable || scanImportBusy.value) return
  const contextId = libraryId.value
  await run(() => api.scanMedia(contextId), '已开始递归扫描当前照片库及子文件夹。已有识别缓存继续复用，跳过原因可在处理记录查看。')
}
/** 全部媒体回到当前库的完整范围，避免沿用人物页和搜索条件。 */
function showLibraryPage(page: 'all' | 'favorites' | 'people'): void {
  const previous = JSON.stringify(filters), wasSimilar = Boolean(similarReference.value)
  clearSimilarFaces()
  filters.ungroupedFaces = false
  if (page === 'all') Object.assign(filters, { search: '', kind: '', source: '', dateSource: '', personId: '', from: '', to: '' })
  else filters.personId = ''
  if (props.module !== 'library') { emit('navigate', 'library'); emit('change-page', page); return }
  if (props.page !== page) emit('change-page', page)
  else if (previous === JSON.stringify(filters) && !wasSimilar) resetQuery()
}
/** 人物卡片跨旧人物分组查找相似人脸，视频占位仍明确回退原组。 */
function openPerson(id: string): void {
  filters.ungroupedFaces = false
  const person = family.value?.people.find(item => item.id === id)
  if (person?.reference?.kind === 'photo') startSimilarFaces(person.reference.assetId, person.reference.face.id, person.name || '未命名人物', person.id)
  else { clearSimilarFaces(); filters.personId = id; notice.value = '此人物尚无可用照片人脸参考，暂显示原人物分组。' }
}
function clearSimilarFaces(): void { if (similarReference.value) querySequence++; similarReference.value = null; similarResult.value = null }
/** 查找为只读结果，关闭选脸流程后按授权范围展示，不自动加入相册。 */
function startSimilarFaces(assetId: string, faceId: string, name = '', personId?: string): void {
  clearTimeout(searchTimer)
  cancelReferencePicker(); querySequence++; detail.value = null; detailSequence++; selected.value.clear(); selectionMode.value = false
  Object.assign(filters, { search: '', kind: '', source: '', dateSource: '', personId: '', ungroupedFaces: false, from: '', to: '' })
  similarScope.value = 'all'; similarResult.value = null; similarReference.value = { assetId, faceId, name, personId }; notice.value = ''
}
function backToPeople(): void { clearSimilarFaces(); filters.personId = ''; filters.ungroupedFaces = false }
/** 歧义人脸保留已有特征，可查看原照片并继续用清晰人脸查找。 */
function showUngroupedFaces(): void {
  clearSimilarFaces()
  Object.assign(filters, { search: '', kind: '', source: '', dateSource: '', personId: '', ungroupedFaces: true, from: '', to: '' })
}
function toggleSelection(asset: MediaAsset): void { selected.value.has(asset.id) ? selected.value.delete(asset.id) : selected.value.set(asset.id, asset) }
function toggleSelectionMode(): void { if (selectionMode.value||selected.value.size) {selectionMode.value=false;selected.value.clear()} else selectionMode.value=true }
function selectPage(): void { for (const asset of items.value.slice(0,500)) selected.value.set(asset.id, asset); if (items.value.length>500) notice.value = '已选择前 500 项，可分批确认，原文件始终保留。' }
async function toggleFavorite(asset: MediaAsset): Promise<void> {
  const context = libraryId.value, favorite = !asset.favorite
  let mutation: BrowseMutation | undefined
  if (await run(async () => { mutation = await api!.setFavorite(asset.id, favorite) }, '', false) && context === libraryId.value) patchAssets(new Map([[asset.id, { ...asset, favorite }]]), item => props.page === 'favorites' && !item.favorite, mutation)
}
async function addDirectory(kind: 'root' | 'library'): Promise<void> { await run(() => api!.addDirectories(kind)) }

async function prepareImport(): Promise<void> {
  if (!props.receiver?.currentLibraryAvailable) { notice.value = '当前照片库暂不可用，请连接硬盘后再导入。'; return }
  if (scanImportBusy.value) { notice.value = prepareButtonLabel.value; return }
  if (copyTargetError.value) { notice.value = copyTargetError.value; return }
  if (!enabledRoots.value.some(root => root.id === importRoot.value) || (importMode.value === 'copy' && !enabledLibraries.value.some(library => library.id === importLibrary.value))) { notice.value = '请选择来源文件夹和归档目标。'; return }
  await run(async () => { importPlan.value = await api!.prepareImport(importRoot.value, importMode.value, importMode.value === 'copy' ? importLibrary.value : undefined) })
}
async function executeImport(): Promise<void> {
  if (!importPlan.value || importPlan.value.state !== 'ready') return
  const started = await run(() => api!.executeImport(importPlan.value!.id), '已开始处理本次固定计划，可点击顶部「处理记录」查看进度。')
  if (started) importPlan.value = null
}

/** 顶部入口共用档案编辑器，换头像时直接展开照片选择。 */
function editProfile(profile: BabyProfile | null, chooseAvatar = false): void {
  if (busy.value) return
  closePopupMenus()
  profileSequence++; profileError.value = ''; profileChooseAvatar.value = chooseAvatar
  profileDraft.value = profile ? { ...profile, referenceFaces: profile.referenceFaces.map(face => ({ ...face })) } : { id: crypto.randomUUID(), name: '', birthday: '', autoMatch: true, referenceFaces: [], updatedAt: new Date().toISOString() }
  profileOpen.value = true
}
function closeProfile(): void { if (profileReferencePreview.value) closePreview(); profileSequence++; profileOpen.value = false; profileDraft.value = null; profileError.value = '' }
/** 查看参考原文件时暂时隐藏档案，返回后保留未保存的姓名、生日和参考草稿。 */
async function openProfileReference(asset: MediaAsset): Promise<void> {
  if (!profileOpen.value || busy.value || !asset.available) return
  profileReferencePreview.value = true
  await openAsset(asset, false, true)
}
/** 保存草稿后才更新当前宝宝，关闭或切库后的旧回执不会改变新页面。 */
async function saveProfile(value: BabyProfile, addReferences = false): Promise<void> {
  if (!profileDraft.value || !profileOpen.value || busy.value) return
  const sequence = profileSequence, contextId = libraryId.value
  const draft = { ...value, name: value.name.trim(), updatedAt: new Date().toISOString() }
  if (!draft.name || !validDate(draft.birthday) || draft.birthday > today) return
  profileError.value = ''
  const saved = await run(() => api!.saveBaby(plainData(draft),babyMatchScope.value))
  if (disposed || sequence !== profileSequence || contextId !== libraryId.value || !profileOpen.value) return
  if (saved) {
    selectedBabyId.value = draft.id; closeProfile()
    if (addReferences) {
      clearTimeout(searchTimer); pendingBabyBrowseReset = props.page !== 'references'
      Object.assign(filters, { search: '', kind: '', source: '', dateSource: '', personId: '', ungroupedFaces: false, from: '', to: '' })
      growthMonth.value = 'all'; babyResultFilter.value = 'all'; selected.value.clear()
      emit('change-page', 'references')
      await nextTick()
      clearTimeout(searchTimer)
      if (!disposed && contextId === libraryId.value && selectedBabyId.value === draft.id) selectionMode.value = true
    }
  }
  else profileError.value = notice.value
}
async function membership(included: boolean): Promise<void> {
  if (!baby.value || !selected.value.size) return
  const saved = await updateMembership([...selected.value.values()], included)
  if (saved) selected.value.clear()
}
/** 归属确认独立于参考，普通确认不会把每张照片都当作识别样本。 */
async function updateMembership(assets: MediaAsset[], included: boolean): Promise<boolean> {
  if (!baby.value || !api || busy.value) return false
  if (assets.length > 500) { notice.value = '每次最多确认 500 项，请分批选择。'; return false }
  const babyId = baby.value.id, context = libraryId.value
  let mutation: BrowseMutation | undefined
  const saved = await run(async () => { mutation = await api.setBabyMembership(babyId, assets.map(asset => asset.id), included) }, included ? '已确认是宝宝。可按需要另外设为人脸参考。' : '已确认不是宝宝，原文件保留。', false)
  if (!saved || context !== libraryId.value || babyId !== selectedBabyId.value) return saved
  const updates = new Map(assets.map(asset => [asset.id, { ...asset, babyIds: [...asset.babyIds.filter(id => id !== babyId), ...(included ? [babyId] : [])], babyDecisions: [...(asset.babyDecisions ?? []).filter(decision => decision.babyId !== babyId), { id: `${babyId}:${asset.id}`, babyId, assetId: asset.id, state: included ? 'included' as const : 'excluded' as const, origin: 'manual' as const, updatedAt: new Date().toISOString() }] }]))
  const candidateChange = assets.filter(asset => babyDecision(asset)?.state === 'candidate').length
  const unconfirmedChange = assets.filter(isBabyUnconfirmed).length
  const includedChange = assets.filter(asset => asset.babyIds.includes(babyId)).length
  babyMatchCounts.value = { included: Math.max(0, babyMatchCounts.value.included + (included ? assets.length - includedChange : -includedChange)), candidates: Math.max(0, babyMatchCounts.value.candidates - candidateChange) }
  babyCandidateCount.value = Math.max(0, babyCandidateCount.value - candidateChange)
  babyUnconfirmedCount.value = Math.max(0, babyUnconfirmedCount.value - unconfirmedChange)
  patchAssets(updates, asset => props.module === 'baby' && !['references','profile'].includes(props.page) && (babyResultFilter.value === 'unconfirmed' ? !isBabyUnconfirmed(asset) : props.page === 'candidates' || babyResultFilter.value === 'candidate' ? babyDecision(asset)?.state ? babyDecision(asset)?.state !== 'candidate' : asset.babyIds.includes(babyId) : babyResultFilter.value === 'all' && ['timeline','matches'].includes(props.page) ? babyDecision(asset)?.state === 'excluded' : babyDecision(asset)?.state !== 'included' && !asset.babyIds.includes(babyId)), mutation)
  return true
}
async function confirmPreviewMembership(included: boolean): Promise<void> { if (detail.value) await updateMembership([detail.value], included) }
async function removeReference(assetId: string, faceId: string): Promise<void> {
  if (!baby.value) return
  const profile = { ...baby.value, referenceFaces: baby.value.referenceFaces.filter(face => face.assetId !== assetId || face.faceId !== faceId), updatedAt: new Date().toISOString() }
  await run(() => api!.saveBaby(plainData(profile),babyMatchScope.value))
}

async function openAsset(asset: MediaAsset, chooseFace = false, inspect = false): Promise<void> {
  if (!inspect && !similarReference.value && props.page === 'watermark' && asset.kind === 'photo' && baby.value && asset.babyIds.includes(baby.value.id) && hasReliableDate(asset, baby.value) && asset.available) { activeWatermarkId.value = asset.id; return }
  closePopupMenus()
  // 重试当前原图保留已移出列表的位置，只有切到另一项才清理导航锚点。
  if (detail.value?.id !== asset.id) previewDetachedIndex.value = null
  const sequence = ++detailSequence, contextId = mediaAccessLibraryId.value
  detail.value = asset; editedDate.value = asset.date ?? ''; selectedFaceId.value = ''; faceSelectionMode.value = chooseFace; detailUrl.value = ''; detailLoading.value = true; referencePickerError.value = ''
  detailError.value = ''; detailActionError.value = ''; navigationError.value = ''
  try { if (asset.available && api) { const url = await api.mediaUrl(asset.id, false, contextId); if (sequence === detailSequence && detail.value?.id === asset.id) detailUrl.value = url } }
  catch (error) { if (sequence === detailSequence && detail.value?.id === asset.id) detailError.value = errorText(error) }
  finally { if (sequence === detailSequence && detail.value?.id === asset.id) detailLoading.value = false }
}

/** 只沿当前查询顺序切换，分页失败停留原图，关闭或切换范围后丢弃迟到结果。 */
async function navigatePreview(direction: -1 | 1): Promise<void> {
  if (!detail.value || referencePicking.value || busy.value || navigationLoading.value) return
  const sequence = ++navigationSequence, query = querySequence, contextId = libraryId.value, assetId = detail.value.id
  const currentIndex = detailIndex.value
  const detachedIndex = currentIndex < 0 ? previewDetachedIndex.value : null
  if (currentIndex < 0 && detachedIndex === null || direction < 0 && !canPreviewPrevious.value || direction > 0 && !canPreviewNext.value) return
  navigationLoading.value = true; navigationError.value = ''
  const current = () => !disposed && sequence === navigationSequence && query === querySequence && contextId === libraryId.value && detail.value?.id === assetId
  try {
    if (direction > 0 && (currentIndex === previewItems.value.length - 1 || detachedIndex !== null && detachedIndex >= previewItems.value.length)) {
      if (groupingInspection.value && inspectionMedia.value) {
        const result = await api!.queryMedia({ libraryId: contextId,personId:inspectionPersonId.value,page:inspectionMedia.value.page+1,limit:50 })
        if (!current()) return
        inspectionMedia.value = {...result,items:[...inspectionMedia.value.items,...result.items]}
      } else await loadMore()
      if (!current()) return
      if (loadMoreError.value) { navigationError.value = loadMoreError.value; return }
    }
    if (!current()) return
    const index = previewItems.value.findIndex(asset => asset.id === assetId)
    const nextIndex = index >= 0 ? index + direction : detachedIndex === null ? -1 : detachedIndex + (direction < 0 ? -1 : 0)
    const next = previewItems.value[nextIndex]
    if (next) await openAsset(next)
  } catch (error) { if (current()) navigationError.value = errorText(error) } finally { if (sequence === navigationSequence) navigationLoading.value = false }
}

function closePreview(): void {
  detailSequence++; navigationSequence++; navigationLoading.value = false; navigationError.value = ''; detailActionError.value = ''; detail.value = null; detailUrl.value = ''
  previewDetachedIndex.value = null
  profileReferencePreview.value = false
  groupingInspection.value = false
  inspectionMedia.value = null; inspectionPersonId.value = ''
}

/** 原文件读取失败可重新请求预览，不触发扫描或重新识别。 */
async function retryPreview(): Promise<void> { if (detail.value) await openAsset(detail.value, faceSelectionMode.value, profileReferencePreview.value) }

/** 定位操作仅复用既有受限接口，失败在信息面板内提示。 */
async function revealDetail(): Promise<void> {
  if (!detail.value || !api || busy.value) return
  const sequence = detailSequence, id = detail.value.id
  detailActionError.value = ''
  const saved = await run(() => api.revealMedia(id, mediaAccessLibraryId.value), '', false)
  if (!saved && sequence === detailSequence && detail.value?.id === id) detailActionError.value = notice.value
}

async function togglePreviewFavorite(): Promise<void> {
  if (!detail.value || !api || busy.value) return
  const sequence = detailSequence, asset = detail.value
  detailActionError.value = ''
  let mutation: BrowseMutation | undefined
  const saved = await run(async () => { mutation = await api.setFavorite(asset.id, !asset.favorite) }, '', false)
  if (saved && sequence === detailSequence && detail.value?.id === asset.id) patchAssets(new Map([[asset.id, { ...asset, favorite: !asset.favorite }]]), item => props.page === 'favorites' && !item.favorite, mutation)
  if (!saved && sequence === detailSequence && detail.value?.id === asset.id) detailActionError.value = notice.value
}
async function saveDate(): Promise<void> {
  if (!detail.value || !editedDateValid.value || !validDate(editedDate.value)) { detailActionError.value = '请输入有效的拍摄日期。'; return }
  const id = detail.value.id, date = editedDate.value, sequence = detailSequence
  detailActionError.value = ''
  const saved = await run(() => api!.setMediaDate(id, date), '拍摄日期已确认，后续归档与月龄使用此日期。')
  if (!saved && sequence === detailSequence && detail.value?.id === id) detailActionError.value = notice.value
  if (saved && detail.value?.id === id) detail.value = items.value.find(asset => asset.id === id) ?? { ...detail.value, date, dateSource: 'manual', dateConfirmed: true }
}
async function saveReference(): Promise<void> {
  if (!baby.value || !detail.value?.available || !selectedFace.value) return
  const babyId = baby.value.id, assetId = detail.value.id, faceId = selectedFace.value.id, contextId = libraryId.value, sequence = referencePickerSequence, preview = detailSequence
  if (baby.value.referenceFaces.length >= 20 && !baby.value.referenceFaces.some(face => face.faceId === faceId)) { notice.value = '最多保留 20 张参考人脸，请先移除不再需要的参考。'; referencePickerError.value = notice.value; return }
  referencePickerError.value = ''
  const asset = detail.value
  const wasUnconfirmed = isBabyUnconfirmed(asset)
  const scope = babyMatchScope.value
  const saved = await run(async () => { await api!.setBabyReference(babyId, assetId, faceId); if (scope === 'all') await api!.matchBaby(babyId,undefined,'all') }, '', false)
  if (saved && !disposed && contextId === libraryId.value && baby.value?.id === babyId) {
    patchAssets(new Map([[assetId, { ...asset, babyIds: [...new Set([...asset.babyIds,babyId])], babyReferenceIds: [...new Set([...(asset.babyReferenceIds??[]),babyId])], babyDecisions: [...(asset.babyDecisions??[]).filter(item=>item.babyId!==babyId), {id:`${babyId}:${assetId}`,babyId,assetId,state:'included',origin:'manual',updatedAt:new Date().toISOString()}] }]]), item => babyResultFilter.value === 'unconfirmed' && !isBabyUnconfirmed(item))
    if (wasUnconfirmed) babyUnconfirmedCount.value = Math.max(0, babyUnconfirmedCount.value - 1)
    const matching = family.value?.babyMatching?.find(status=>status.babyId===babyId&&status.scope===scope&&(scope==='all'||status.libraryId===contextId))
    if (matching?.state === 'done' && !referencePicking.value && preview === detailSequence) {
      await loadMedia()
      if (disposed || contextId !== libraryId.value || baby.value?.id !== babyId || preview !== detailSequence) return
    }
    notice.value = `已确认并设为参考。${matchingNotice() || '正在用已有缓存匹配宝宝照片。'}`
    if (!referencePicking.value && preview === detailSequence) exitFaceSelection()
  }
  if (!saved && sequence === referencePickerSequence && preview === detailSequence && contextId === libraryId.value && detail.value?.id === assetId && baby.value?.id === babyId) referencePickerError.value = notice.value
  if (saved && referencePicking.value && sequence === referencePickerSequence && contextId === libraryId.value && babyId === referenceBabyId.value) {
    selected.value.delete(assetId)
    await advanceReferencePicker()
  }
}

/** 按用户多选的顺序打开参考照片，每张必须明确选择宝宝的人脸。 */
async function startReferencePicker(): Promise<void> {
  if (!baby.value || busy.value) return
  if (!referenceCandidates.value.length) { notice.value = '请选择可用的宝宝照片。'; return }
  if (referenceCandidates.value.length > 20) { notice.value = '每次最多选择 20 张参考照片。'; return }
  referencePickerSequence++; referenceQueue.value = [...referenceCandidates.value]; referenceIndex.value = 0; referenceBabyId.value = baby.value.id; referencePickerError.value = ''
  await openAsset(referenceQueue.value[0], true)
}

/** 保存成功或明确跳过后进入下一张，失败时保留当前照片及所选人脸。 */
async function advanceReferencePicker(): Promise<void> {
  referencePickerError.value = ''
  referenceIndex.value++
  const next = referenceQueue.value[referenceIndex.value]
  if (next) await openAsset(items.value.find(asset => asset.id === next.id) ?? selected.value.get(next.id) ?? next, true)
  else { cancelReferencePicker(); detail.value = null; selectionMode.value = selected.value.size > 0; notice.value = matchingNotice() || '参考已保存，宝宝相册会显示重新匹配的已加入和疑似照片。' }
}

/** 关闭预览、切库或切宝宝时停止选脸流程，已保存参考保持不变。 */
function cancelReferencePicker(): void { referencePickerSequence++; referenceQueue.value = []; referenceIndex.value = 0; referenceBabyId.value = ''; referencePickerError.value = ''; exitFaceSelection() }
/** 普通预览不标脸，用户明确选择宝宝参考时才进入选脸模式。 */
function startFaceSelection(): void { if (detail.value?.available && detail.value.faces.length && (canSelectBabyFace.value || filters.ungroupedFaces)) { selectedFaceId.value = ''; faceSelectionMode.value = true; referencePickerError.value = '' } }
function exitFaceSelection(): void { faceSelectionMode.value = false; selectedFaceId.value = ''; referencePickerError.value = '' }

/** 用户明确补检无脸缓存，宝宝结果沿用当前选择的查找范围。 */
async function supplementFaces(scope: 'library' | 'all' = 'library'): Promise<void> {
  if (!api || supplementDisabled.value || (scope === 'library' && !libraryId.value)) return
  const scopeLabel = scope === 'all' ? '全部已授权目录' : '当前照片库'
  await run(() => api.supplementFaces(scope === 'library' ? libraryId.value : undefined), `已开始补检${scopeLabel}中未发现人脸的项目；补检命中的宝宝照片会作为疑似，需人工确认。请在处理记录查看进度。`)
}

/** 清理前明确展示范围，重建只重新生成识别记录并保留原媒体。 */
function requestFaceIndexRebuild(): void {
  if (!libraryId.value || busy.value || faceAnalysisBusy.value || scanImportBusy.value || !props.receiver?.currentLibraryAvailable) return
  if (currentRebuild.value) { void resumeFaceRebuild(); return }
  rebuildIndexLibrary.value = libraryId.value
}
/** 继续入口复用分析接口，只处理未完成部分，避免迟到点击发起新的清空重建。 */
async function resumeFaceRebuild(): Promise<void> {
  const contextId = libraryId.value
  if (!api || !contextId || !currentRebuild.value || currentRebuild.value.state !== 'interrupted' || busy.value || faceAnalysisBusy.value || scanImportBusy.value || !family.value?.modelReady || !props.receiver?.currentLibraryAvailable) return
  await run(() => api.analyzeFaces(contextId), '已继续重建，已完成的新特征保持缓存；宝宝结果完成后自动更新。')
}
function focusRebuildCancel(element: HTMLElement): void { element.querySelector<HTMLButtonElement>('button')?.focus() }
async function confirmFaceIndexRebuild(): Promise<void> {
  const contextId = rebuildIndexLibrary.value
  if (!api || !contextId || contextId !== libraryId.value || busy.value || faceAnalysisBusy.value || scanImportBusy.value || !props.receiver?.currentLibraryAvailable) return
  rebuildIndexLibrary.value = ''
  filters.personId = ''; filters.ungroupedFaces = false; selected.value.clear(); closePreview()
  await run(() => api.rebuildFaceIndex(contextId), '已开始从原文件重建人脸和人物索引，请在处理记录查看进度及跳过原因。')
}

/** 使用当前宝宝的全部参考匹配缓存，完成后直接打开对应结果页。 */
async function findBabyMatches(): Promise<void> {
  if (!baby.value || !api || babyRebuildBlocked.value) return
  const babyId = baby.value.id, contextId = libraryId.value, sourcePage = props.page
  const matched = await run(() => api.matchBaby(babyId, babyMatchScope.value === 'library' ? contextId : undefined, babyMatchScope.value))
  if (matched && contextId === libraryId.value && baby.value?.id === babyId && props.page === sourcePage) {
    notice.value = matchingNotice() || `共找到 ${babyMatchCounts.value.included+babyMatchCounts.value.candidates} 项：已加入 ${babyMatchCounts.value.included} 项，待确认 ${babyMatchCounts.value.candidates} 项。`
    if (props.page === 'references') {
      clearTimeout(searchTimer);pendingBabyBrowseReset=true
      Object.assign(filters,{search:'',kind:'',source:'',dateSource:'',personId:'',ungroupedFaces:false,from:'',to:''});growthMonth.value='all';babyResultFilter.value='all'
      selected.value.clear();selectionMode.value=false
      emit('change-page','timeline')
    }
  }
}
function matchingNotice(): string {
  const status = babyMatchStatus.value
  if (!status) return ''
  if (status.rebuilding) return status.error || '宝宝结果等待人脸重建完成后更新。'
  if (status.state === 'running') return `正在匹配已有缓存 · ${status.processed} / ${status.total} 项，完成后自动更新相册。`
  if (status.state === 'error') return status.error || '匹配未完成，请重试。'
  if (status.state === 'superseded') return '参考已变化，旧匹配停止；新匹配会继续处理。'
  return `匹配完成：已加入 ${status.included} 项，疑似 ${status.candidates} 项；新增 ${status.addedIncluded + status.addedCandidates} 项${status.invalidReferences ? ` · ${status.invalidReferences} 张参考不可用` : ''}。`
}
function showBabyResults(filter: string): void {
  babyResultFilter.value = filter
  if (filter === 'unconfirmed') growthMonth.value = 'all'
  if (props.page === 'candidates') { if (filter === 'unconfirmed') pendingBabyBrowseReset = true; emit('change-page','timeline') }
}
function editPerson(id: string, name = ''): void {
  closePopupMenus()
  void mediaPreview.value?.exitFullscreen()
  personSequence++; personOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  personId.value = id; personName.value = name; personError.value = ''; personOpen.value = true
}
/** 关闭命名弹窗保留原名称，已发出的保存完成后不重开弹窗。 */
function closePerson(): void {
  personSequence++
  const wasOpen = personOpen.value
  personOpen.value = false
  if (wasOpen && personOpener?.isConnected) personOpener.focus({ preventScroll: true })
  personOpener = null
}
/** 人物命名时让键盘焦点停留在当前弹窗，避免进入后方的图片和图库。 */
function trapPersonFocus(event: KeyboardEvent): void {
  if (!(event.currentTarget instanceof HTMLElement)) return
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')).filter(control => control.getClientRects().length > 0)
  const first = controls[0], last = controls.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
/** 合并前先让用户用头像核对目标，保留媒体和宝宝相册关联。 */
function openPersonMerge(id: string): void {
  if (busy.value || !libraryId.value) return
  closePopupMenus()
  personMergeSequence++; personMergeSource.value = id; personMergeError.value = ''
}
function closePersonMerge(): void { personMergeSequence++; personMergeSource.value = ''; personMergeError.value = '' }
/** 明确确认后只合并人物记录，切库或关闭后不处理迟到的界面回执。 */
async function mergePersons(targetId: string): Promise<void> {
  if (!api || !libraryId.value || !personMergeSource.value || busy.value) return
  const sourceId = personMergeSource.value, contextId = libraryId.value, sequence = personMergeSequence
  personMergeError.value = ''
  const merged = await run(() => api.mergePersons(sourceId, targetId, contextId), '已合并为同一人物，原照片和宝宝相册关联保留。')
  if (disposed || sequence !== personMergeSequence || contextId !== libraryId.value || personMergeSource.value !== sourceId) return
  if (merged) { if (filters.personId === sourceId) filters.personId = targetId; closePersonMerge() }
  else personMergeError.value = notice.value
}
/** 先生成只读整理方案，关闭、换页或切库后丢弃迟到的方案。 */
async function openPersonGrouping(): Promise<void> {
  if (!api || !libraryId.value || busy.value || faceAnalysisBusy.value) return
  closePopupMenus(); closePerson(); closePersonMerge()
  const contextId = libraryId.value, sequence = ++groupingSequence
  groupingOpen.value = true; groupingLoading.value = true; groupingError.value = ''; groupingPreview.value = null
  try {
    const preview = await api.preparePersonGrouping(contextId)
    if (disposed || !groupingOpen.value || sequence !== groupingSequence || contextId !== libraryId.value) return
    groupingPreview.value = preview
  } catch (error) {
    if (!disposed && groupingOpen.value && sequence === groupingSequence && contextId === libraryId.value) groupingError.value = errorText(error)
  } finally { if (sequence === groupingSequence) groupingLoading.value = false }
}
function closePersonGrouping(): void { groupingSequence++; groupingOpen.value = false; groupingLoading.value = false; groupingError.value = ''; groupingPreview.value = null; groupingInspection.value = false }
/** 只有明确点击确认才应用人物别名，原照片和人脸参考不改写。 */
async function applyPersonGrouping(sourceIds: string[]): Promise<void> {
  const plan = groupingPreview.value, contextId = libraryId.value, sequence = groupingSequence
  if (!api || !plan || !contextId || plan.libraryId !== contextId || !groupingOpen.value || groupingLoading.value || busy.value || !sourceIds.length) return
  groupingError.value = ''
  const saved = await run(() => api.applyPersonGrouping(plan.id, contextId, sourceIds), `已整理 ${sourceIds.length} 组重复人物；其余建议已跳过。`)
  if (disposed || sequence !== groupingSequence || contextId !== libraryId.value || !groupingOpen.value) return
  if (saved) closePersonGrouping()
  else groupingError.value = notice.value
}
async function undoPersonGrouping(): Promise<void> {
  const undo = family.value?.personGroupingUndo
  if (undo && libraryId.value === undo.libraryId) await run(() => api!.undoPersonGrouping(undo.token, undo.libraryId), '已撤销本次人物整理。')
}
async function inspectGroupingPerson(person: import('../../../shared/family').PersonProfile): Promise<void> {
  const contextId = libraryId.value, sequence = groupingSequence
  groupingInspection.value = true
  try {
    const result = await api!.queryMedia({ libraryId: libraryId.value, personId: person.id, page:1, limit:50 })
    if (disposed || sequence !== groupingSequence || contextId !== libraryId.value) return
    if (result.items[0]) { inspectionMedia.value = result; inspectionPersonId.value = person.id; await openAsset(result.items[0]) }
    else { groupingInspection.value = false; groupingError.value = '此人物的原照片暂不可用。' }
  } catch (error) { if (sequence === groupingSequence && contextId === libraryId.value) { groupingInspection.value = false; groupingError.value = errorText(error) } }
}
async function savePerson(): Promise<void> {
  if (!personId.value || !personName.value.trim()) return
  const id = personId.value, name = personName.value.trim(), contextId = libraryId.value, sequence = personSequence
  personError.value = ''
  const saved = await run(() => api!.namePerson(id, name), '人物名称已保存。')
  if (disposed || sequence !== personSequence || contextId !== libraryId.value || personId.value !== id || !personOpen.value) return
  if (saved) closePerson()
  else personError.value = notice.value
}
const faceStyle = (face: MediaFace) => ({ left: `${face.x * 100}%`, top: `${face.y * 100}%`, width: `${face.width * 100}%`, height: `${face.height * 100}%` })
function selectFace(face: MediaFace): void {
  if (!faceSelectionMode.value) return
  selectedFaceId.value = face.id
  if (face.frameTime !== undefined && mediaVideo.value) { mediaVideo.value.pause(); mediaVideo.value.currentTime = face.frameTime }
}

/** 水印预览与导出均调用真实后端；过期的预览响应不会覆盖当前选择。 */
async function openWatermark(assets: MediaAsset[]): Promise<void> {
  if (!baby.value || !assets.length) return
  const context = libraryId.value, babyId = baby.value.id, view = viewSequence, preview = detailSequence
  const detailId = detail.value?.id
  closePopupMenus()
  await mediaPreview.value?.exitFullscreen()
  if (disposed || context !== libraryId.value || baby.value?.id !== babyId || view !== viewSequence || preview !== detailSequence || detailId !== detail.value?.id) return
  watermarkDialog.value = plainData(assets)
}
function watermarkFinished(results: WatermarkResult[]): void {
  const success = results.filter(result => result.path && !result.error).length, failed = results.filter(result => result.error).length
  if (results.length) notice.value = `已保存 ${success} 张成长水印副本${failed ? `，失败 ${failed} 张` : ''}，原图保留。`
}
async function inspectWatermarkAsset(asset: MediaAsset): Promise<void> { watermarkDialog.value = null; await openAsset(asset, false, true) }

/** 切库立即清理当前选择和预览，并拒绝上一库迟到的查询响应。 */
watch(libraryId, async (id, previousId) => {
  const view = ++viewSequence
  rebuildIndexLibrary.value = ''
  if (previousId) saveBrowse(props.module,props.page,previousId)
  restoringView = true
  clearTimeout(searchTimer)
  closePopupMenus()
  closePerson()
  closeProfile()
  cancelReferencePicker()
  closePersonMerge()
  closePersonGrouping()
  clearSimilarFaces()
  familySequence++; querySequence++; detailSequence++
  refreshing = false; family.value = null; media.value = null; detail.value = null; detailUrl.value = ''; selected.value.clear(); selectionMode.value = false; resetMonthCollapse(); babyCandidateCount.value = 0; babyUnconfirmedCount.value = 0; babyMatchCounts.value = { included: 0, candidates: 0 }
  lastScanBrowseRefresh = 0
  watermarkDialog.value = null; activeWatermarkId.value = ''; importPlan.value = null; importLibrary.value = id ?? ''
  for (const key of Object.keys(thumbnails)) delete thumbnails[key]
  thumbnailQueue=[];thumbnailPending.clear();thumbnailFailed.clear()
  thumbnailImageRetries.clear(); for (const key of Object.keys(thumbnailErrors)) delete thumbnailErrors[key]
  browsePage.value = 1; notice.value = ''; jobsUnread.value = false; filters.personId = ''; filters.ungroupedFaces = false; if (previousId !== undefined) closeProcessingRecords()
  babyMatchScope.value = 'library'; babyResultFilter.value = 'all'; lastScrollTop = 0
  pendingBabyBrowseReset=false
  if (id) { await refreshFamily(true); if (disposed||view!==viewSequence||id!==libraryId.value) return; const restored = previousId === undefined && await restoreBrowse(); if(view!==viewSequence)return; restoringView = false; if (!restored) await loadMedia() }
  else restoringView = false
}, { immediate: true })
watch(() => [props.module, props.page] as const, async ([module, page], previous) => {
  const view = ++viewSequence
  rebuildIndexLibrary.value = ''
  const resetBaby = pendingBabyBrowseReset;pendingBabyBrowseReset=false
  if (previous&&!resetBaby) saveBrowse(previous[0],previous[1])
  restoringView=true
  closePopupMenus(); closePerson(); closeProfile(); closeProcessingRecords(); closePersonMerge(); closePersonGrouping(); clearSimilarFaces(); exitFaceSelection(); resetMonthCollapse(); closePreview(); watermarkDialog.value = null
  querySequence++; browsePage.value = 1; media.value = null; filters.ungroupedFaces = false
  await refreshFamily(true)
  if (disposed || view !== viewSequence) return
  if (!resetBaby&&await restoreBrowse()) return
  if (disposed||view!==viewSequence) return
  restoringView = false
  if (module !== previous?.[0]) Object.assign(filters, { search: '', kind: '', source: '', dateSource: '', personId: '', from: '', to: '' })
  else if (module === 'library' && page !== 'people') filters.personId = ''
  else if (previous?.[1] === 'watermark' && page !== 'watermark') filters.kind = kindBeforeWatermark
  if (page === 'watermark') { kindBeforeWatermark = filters.kind; filters.kind = 'photo' }
  if (!resetBaby) babyResultFilter.value = 'all'
  lastScrollTop = 0; document.querySelector('.page-content')?.scrollTo({top:0}); void loadMedia()
})
watch(selectedBabyId, closeProfile)
watch(selectedBabyId, () => { watermarkDialog.value = null; activeWatermarkId.value = ''; previewDetachedIndex.value = null })
watch(selectedBabyId, () => { if (!restoringView && props.module === 'baby') { resetMonthCollapse(); browsePage.value = 1; media.value = null; growthMonth.value = 'all'; if (!detail.value) { selected.value.clear(); document.querySelector('.page-content')?.scrollTo({ top: 0 }) } void loadMedia() } })
watch(selectedBabyId, id => { if (referencePicking.value && id !== referenceBabyId.value) { cancelReferencePicker(); detail.value = null } })
watch(personOpen, async open => { if (open) { await nextTick(); document.querySelector<HTMLInputElement>('.person-name-backdrop input')?.focus() } })
watch(detail, asset => { if (!asset) { detailSequence++; navigationSequence++; navigationLoading.value = false; exitFaceSelection(); if (referencePicking.value) cancelReferencePicker() } })
watch(() => [runningJobCount.value, jobsUnread.value], () => { emit('processing-status', { running: runningJobCount.value, unread: jobsUnread.value }) }, { immediate: true })
watch(() => props.recordsOpen, async open => {
  if (!open) return
  closePopupMenus()
  jobsUnread.value = false
  await nextTick()
  if (!disposed && props.recordsOpen) recordsDialog.value?.querySelector<HTMLElement>('[autofocus]')?.focus()
}, { immediate: true })
watch(() => [filters.kind, filters.source, filters.dateSource, filters.personId, filters.ungroupedFaces, filters.from, filters.to, filters.order, growthMonth.value, babyResultFilter.value, babyMatchScope.value], resetQuery)
watch(() => filters.personId, id => { if (id) filters.ungroupedFaces = false })
watch(() => [similarReference.value?.assetId, similarReference.value?.faceId, similarScope.value], resetQuery)
watch(() => [importRoot.value, importMode.value, importLibrary.value], () => { importPlan.value = null })
// 来源改变后清除不再允许的归档目标，避免沿用重叠目录的旧选择。
// 当前库保持固定，重叠来源只阻止执行，不改用其他目录。
watch(copyTargetError, error => { if (error) { notice.value = error; importPlan.value = null } })
watch(() => filters.search, () => { clearTimeout(searchTimer); if (!restoringView && !similarReference.value) searchTimer = setTimeout(resetQuery, 300) })
watch(() => [mediaSentinel.value, peopleOverview.value, loading.value, loadingMore.value, folding.value, items.value.length, collapseNewMonths.value, [...monthCollapseOverrides.value]], () => { void observeMediaEnd() })
onMounted(async () => { scrollHost = document.querySelector('.page-content'); scrollHost?.addEventListener('scroll',recordScroll,{passive:true}); if (!api) { notice.value = '请在桌面程序中使用图库与宝宝相册。'; return } pollTimer = setInterval(() => { progressNow.value = Date.now(); void refreshFamily() }, 2000) })
onUnmounted(() => { saveBrowse(); scrollHost?.removeEventListener('scroll',recordScroll); disposed = true; profileSequence++; closePerson(); closePersonMerge(); closePersonGrouping(); cancelReferencePicker(); clearInterval(pollTimer); clearTimeout(searchTimer); mediaObserver?.disconnect(); familySequence++; querySequence++; detailSequence++ })
</script>

<template>
  <section class="family-workspace">
    <div class="page-intro family-heading"><h1>{{title}}</h1><p v-if="module==='library'">{{family?.photoCount??0}} 张照片 · {{family?.videoCount??0}} 个视频</p></div>
    <FaceAnalysisProgress v-if="faceAnalysisJob" :job="faceAnalysisJob" :processed="handledCount(faceAnalysisJob)" :face-count="family?.analysis?.faceCount??0" :now="progressNow" />
    <div v-if="notice" class="notice" role="status">{{notice}}<button @click="notice=''" aria-label="关闭提示">×</button></div>

    <template v-if="module==='import'">
      <div class="compact-page-heading"><button class="text-button" @click="emit('change-page','receive')">← 返回</button><h1>从电脑文件夹导入</h1></div>
      <section class="directory-panel"><div class="section-heading"><h2>来源与目标</h2><button class="secondary-button" :disabled="busy" @click="addDirectory('root')">＋ 登记来源文件夹</button></div>
        <div class="family-form-grid"><label class="field"><span>来源文件夹</span><UiSelect v-model="importRoot" label="来源文件夹" :options="[{value:'',label:'请选择已授权来源'},...enabledRoots.map(root=>({value:root.id,label:root.path}))]" /></label><div class="field"><span>归档目标 · 当前照片库</span><strong>{{currentLibrary?.name}}</strong><small>{{currentLibrary?.path}}</small></div></div>
        <p v-if="copyTargetError" class="error-text">{{copyTargetError}}</p><button class="primary-button" :disabled="busy||scanImportBusy||!importRoot||Boolean(copyTargetError)||!importLibrary||!receiver?.currentLibraryAvailable" @click="prepareImport">{{prepareButtonLabel}}</button><details class="compact-help"><summary>日期与归档规则</summary><p>来源日期在准备计划时读取并固定，复制后不会使用新的文件创建时间。</p><p>归档目标必须与来源目录相互独立，同目录或父子目录不可复制。当前库已有文件直接扫描索引，无需复制。</p><p>拍摄日期优先；缺失时使用来源文件创建日期。来源仍无可用日期时保留“日期未知”标记，宝宝月龄需另行确认。</p></details>
      </section>
      <section v-if="importPlan" class="directory-panel"><div class="section-heading"><h2>{{importPlan.mode==='copy'?'复制归档计划':'加入图库计划'}}</h2><span class="state-pill">{{importPlan.state==='ready'?'已固定，等待确认':importPlan.state==='error'?'准备失败':'正在读取来源'}}</span></div><p>来源：{{receiver?.roots.find(root=>root.id===importPlan?.rootId)?.path??'来源目录不可用'}}<br v-if="importPlan.mode==='copy'"><template v-if="importPlan.mode==='copy'">归档目标：{{receiver?.libraries.find(library=>library.id===importPlan?.libraryId)?.path??'归档目标不可用'}}</template></p><p v-if="importPlan.state==='preparing'">正在预扫描授权文件夹，已处理 {{preparationJob?.processed??0}} 项。正在读取媒体与来源日期，窗口仍可浏览其他模块。</p><p v-if="importPlan.error" class="error-text">{{importPlan.error}}</p><div v-if="importPlan.skipped||importPlan.warnings?.length" class="section-tip"><strong>本次预扫描跳过 {{importPlan.skipped??0}} 项，来源文件保留。</strong><ProcessingWarnings :report-id="importPlan.warningReportId" :warnings="importPlan.warnings" :skipped="importPlan.skipped" :library-id="libraryId" :running="importPlan.state==='preparing'" /></div><template v-if="importPlan.state==='ready'"><div class="plan-summary"><div><strong>{{importPlan.count}}</strong><span>项媒体 · {{size(importPlan.bytes)}}</span></div><div><strong>{{importPlan.creationDates}}</strong><span>项采用来源创建日期</span></div><div><strong>{{importPlan.unknownDates}}</strong><span>项日期未知</span></div></div><div class="table-scroll"><table class="family-table"><thead><tr><th>文件</th><th>归档日期</th><th>日期来源</th><th>{{importPlan.mode==='copy'?'相对路径':'图库日期分组'}}</th></tr></thead><tbody><tr v-for="(item,index) in importPlan.preview" :key="`${item.filename}-${index}`"><td>{{item.filename}}</td><td>{{item.date??'日期未知'}}</td><td>{{dateLabel(item.dateSource)}}</td><td>{{item.relativePath||'保留原位置'}}</td></tr></tbody></table></div><p>继续使用此计划中的来源日期与路径。修改来源、整理方式或目标后需要重新预览。</p><button class="primary-button" :disabled="busy||scanImportBusy" @click="executeImport">{{importPlan.mode==='copy'?'确认复制归档':'确认加入照片库'}}</button><button class="text-button" :disabled="busy" @click="importPlan=null">放弃此计划</button></template></section>
    </template>

    <template v-else>
      <div class="workspace-header" :class="{'baby-gallery-header':module==='baby'&&baby&&!similarReference&&['timeline','matches','candidates'].includes(page)}">
        <section v-if="module==='baby'" class="baby-profile-banner">
          <button v-if="baby" type="button" class="baby-avatar-action" aria-label="更换宝宝头像" :disabled="busy" @click="editProfile(baby,true)"><PhotoAvatar :size="36" :asset-id="babyAvatarId" :library-id="libraryId" :available="receiver?.currentLibraryAvailable!==false" /><span>更换头像</span></button>
          <PhotoAvatar v-else :size="48" />
          <div class="baby-profile-summary"><label class="baby-selector"><span class="visually-hidden">宝宝</span><UiSelect v-model="selectedBabyId" label="当前宝宝" :options="[{value:'',label:family?.babies.length?'选择宝宝':'尚未创建'},...(family?.babies??[]).map(profile=>({value:profile.id,label:profile.name}))]" /></label><div v-if="baby" class="baby-summary-meta"><span class="baby-age">{{currentAge?.text??'出生日期待确认'}}</span><span class="baby-birthday">{{baby.birthday}} 出生</span></div></div>
          <div class="baby-profile-actions"><button v-if="baby" class="text-button auto-growth-watermark" role="switch" aria-label="自动显示成长水印" :aria-checked="automaticWatermark" title="查看照片时显示成长年龄和拍摄日期" @click="toggleAutomaticWatermark"><span class="growth-switch-track" aria-hidden="true"></span>自动水印</button><button v-if="baby" class="secondary-button" :disabled="busy" @click="editProfile(baby)">编辑档案</button><button class="text-button" :disabled="busy" @click="editProfile(null)"><UiIcon name="plus" :size="14" />新建档案</button></div>
          <UiPopover  class="baby-tools"  label="宝宝工具"><template #trigger="{open}"><button type="button" class="menu-trigger" aria-label="宝宝工具" title="宝宝工具" :aria-expanded="open"><UiIcon name="more" /></button></template><div class="tools-menu" @click="closeToolMenu"><button @click="emit('change-page','timeline')">成长时间线</button><button @click="emit('change-page','matches')">全部匹配结果</button><button @click="emit('change-page','candidates')">人物待确认{{babyCandidateCount?` · ${babyCandidateCount}`:''}}</button><button @click="emit('change-page','references')">人物查找与参考</button><button @click="emit('change-page','watermark')">成长水印</button><button @click="emit('change-page','profile')">宝宝档案详情</button></div></UiPopover>
        </section>
        <div v-if="module==='library'" class="library-view-tabs"><button :class="{selected:page==='all'}" @click="showLibraryPage('all')">全部媒体</button><button :class="{selected:page==='favorites'}" @click="showLibraryPage('favorites')">收藏</button><button :class="{selected:page==='people'}" @click="showLibraryPage('people')">人物</button></div>
        <div v-if="(module!=='baby'||baby)&&!(module==='baby'&&page==='profile'&&!similarReference)" class="media-search-toolbar" :class="{'baby-results-toolbar':module==='baby'&&page==='matches'&&!similarReference}"><div class="media-toolbar-heading"><h1>{{similarReference?'相似人脸':module==='baby'&&babyResultFilter==='unconfirmed'?'待核对照片与视频':module==='library'?(page==='favorites'?'收藏':page==='people'?'人物':'全部媒体'):page==='timeline'?'成长相册':title}}</h1><span>{{peopleOverview?`${family?.people.length??0} 组`:`${media?.total??0} 项`}}</span></div><label v-if="!similarReference" class="gallery-search"><UiIcon name="search" :size="17" /><input v-model="filters.search" type="search" aria-label="搜索照片、人物" placeholder="搜索照片、人物…"></label><div class="media-kind-filter" aria-label="类型筛选"><button :class="{selected:!filters.kind}" :disabled="page==='watermark'" @click="filters.kind=''">全部</button><button :class="{selected:filters.kind==='photo'}" @click="filters.kind='photo'">照片</button><button :class="{selected:filters.kind==='video'}" :disabled="page==='watermark'" @click="filters.kind='video'">视频</button></div>
        <label v-if="!peopleOverview" class="gallery-order"><span class="visually-hidden">日期排序</span><UiSelect v-model="filters.order" aria-label="日期排序" :options="[{value:'desc',label:'最新在前'},{value:'asc',label:'最早在前'}]" /></label><UiPopover v-if="!similarReference"  class="advanced-filters gallery-tools"  label="更多筛选"><template #trigger="{open}"><button type="button" class="menu-trigger" aria-label="更多筛选" title="更多筛选" :aria-expanded="open"><UiIcon name="filter" :size="20" /><i v-if="filters.source||filters.dateSource||filters.personId||filters.from||filters.to" class="filter-dot"></i></button></template><div class="advanced-filter-fields"><label><span>来源</span><UiSelect v-model="filters.source" label="来源" :options="[{value:'',label:'全部来源'},{value:'phone',label:'手机传入'},{value:'folder',label:'电脑文件夹'}]" /></label><label><span>日期来源</span><UiSelect v-model="filters.dateSource" label="日期来源" :options="[{value:'',label:'全部日期'},{value:'capture',label:'拍摄日期'},{value:'creation',label:'文件创建日期'},{value:'manual',label:'手动确认日期'},{value:'unknown',label:'日期未知'}]" /></label><label><span>人物</span><UiSelect v-model="filters.personId" label="人物" :options="[{value:'',label:'全部人物'},...(family?.people??[]).map(person=>({value:person.id,label:`${person.name||'尚未命名'} · ${person.assetCount} 项`}))]" /></label><label><span>从</span><UiDatePicker v-model="filters.from"  label="从" /></label><label><span>到</span><UiDatePicker v-model="filters.to"  label="到" /></label><button class="text-button" @click="emit('change-page','people')">管理人物名称</button><div class="tools-menu gallery-actions" @click="closeToolMenu"><template v-if="module==='library'"><button @click="showLibraryPage('all')">全部照片与视频</button><button @click="showLibraryPage('favorites')">我的收藏</button><button @click="showLibraryPage('people')">按人物查找</button></template><button @click="toggleSelectionMode">{{selectionMode||selected.size?'结束选择':'选择照片'}}</button><button @click="selectPage" :disabled="!items.length">选择此页</button><button @click="selected.clear()" :disabled="!selected.size">清空选择</button><button :disabled="busy||scanImportBusy" @click="rescanGallery">重新扫描图库</button></div></div></UiPopover>
        </div>
        <div v-if="module==='baby'&&baby&&page==='timeline'&&babyResultFilter!=='unconfirmed'&&!similarReference" class="growth-toolbar"><div class="growth-months" aria-label="成长月份"><button :class="{selected:growthMonth==='all'}" @click="growthMonth='all'">全部</button><button v-for="month in visibleMonths" :key="month" :class="{selected:growthMonth===String(month)}" @click="growthMonth=String(month)">{{month===0?'出生':`${month}个月`}}</button></div><div class="growth-context"><span v-if="growthMonth!=='all'">{{growthRange?`${growthRange.from} – ${growthRange.to}`:'拍摄日期待确认'}}</span><button class="text-button" @click="emit('change-page','references')">用照片查找</button><button class="text-button candidate-entry" @click="emit('change-page','candidates')">待确认 <b v-if="babyCandidateCount">{{babyCandidateCount}}</b></button><UiPopover  class="compact-help growth-extra"  label="更多成长月份"><template #trigger="{open}"><button type="button" class="menu-trigger" aria-label="更多成长月份" title="更多成长月份" :aria-expanded="open"><UiIcon name="chevron" :size="16" /></button></template><label>成长月份<UiSelect v-model="growthMonth" label="成长月份" :options="[{value:'all',label:'全部成长照片与视频'},...months.map(month=>({value:String(month),label:month===0?'出生未满1个月':`${month}个月`})),{value:'pending',label:'拍摄日期待确认'}]" /></label><p>确认实际拍摄日期后才显示准确月龄。</p></UiPopover></div></div>
        <div v-if="module==='baby'&&baby&&!similarReference&&['timeline','matches','candidates'].includes(page)" class="baby-review-toolbar"><div class="baby-result-filter" aria-label="宝宝照片结果"><button :class="{selected:babyResultFilter==='all'&&page!=='candidates'}" @click="showBabyResults('all')">全部</button><button :class="{selected:babyResultFilter==='included'&&page!=='candidates'}" @click="showBabyResults('included')">已加入 {{babyMatchCounts.included}}</button><button :class="{selected:babyResultFilter==='candidate'||page==='candidates'}" @click="showBabyResults('candidate')">疑似 {{babyMatchCounts.candidates}}</button><button :class="{selected:babyResultFilter==='unconfirmed'&&page!=='candidates'}" title="查看缺少识别证据、尚未人工确认的照片与视频" @click="showBabyResults('unconfirmed')">待核对 {{babyUnconfirmedCount}}</button></div><label><span class="visually-hidden">宝宝查找范围</span><UiSelect v-model="babyMatchScope" aria-label="宝宝查找范围" :options="[{value:'library',label:'当前照片库'},{value:'all',label:'全部已授权目录'}]" /></label><button class="text-button" :disabled="busy||babyMatchRunning||babyRebuildBlocked||!baby.referenceFaces.length" @click="findBabyMatches">{{babyMatchRunning?'匹配中…':'重新匹配'}}</button>
            <UiPopover class="baby-recognition-details" label="整理与识别详情" :width="360">
              <template #trigger="{open}"><button type="button" class="text-button recognition-details-trigger" aria-label="整理与识别详情" :aria-expanded="open"><span>{{babyMatchRunning?'匹配中…':faceAnalysisBusy?'分析中…':'整理详情'}}</span><b v-if="babyMatchStatus?.coverage.error??family?.analysis?.error">{{babyMatchStatus?.coverage.error??family?.analysis?.error}} 失败</b><UiIcon name="chevron" :size="14" /></button></template>
      <div v-if="module==='baby'&&baby&&page==='timeline'&&!similarReference&&!babyRebuildBlocked" class="baby-recognition-status" role="status"><template v-if="!baby.referenceFaces.length"><span>选择宝宝的人脸后，自动整理成长照片</span><button class="text-button" @click="emit('change-page','references')">选择宝宝人脸</button></template><template v-else-if="!baby.autoMatch"><span>自动整理已关闭</span><button class="text-button" @click="editProfile(baby)">开启自动整理</button></template><template v-else-if="!family?.modelReady"><span>{{modelLoading?'正在加载本地人物模型，可继续浏览相册':'本地人物模型不可用，可继续手动整理'}}</span><button v-if="!modelLoading" class="text-button" @click="emit('change-page','references')">查看原因</button></template><template v-else><span>{{jobs.find(job=>job.kind==='faces'&&job.state==='running')?`正在分析新增媒体 · ${family?.analysis?.done??0} 项已完成`:family?.analysis?.pending?`等待分析 ${family.analysis.pending} 项新媒体`:'自动整理已开启，新增照片会继续匹配'}}</span><button v-if="family?.analysis?.error" class="text-button" @click="emit('change-page','references')">{{family.analysis.error}} 项识别失败</button></template></div>
        <div v-if="babyMatchStatus&&!similarReference&&module==='baby'" class="baby-match-coverage" role="status"><span v-if="babyMatchStatus.rebuilding">宝宝结果等待重建完成</span><span v-else-if="babyMatchRunning">正在匹配 {{babyMatchStatus.processed}} / {{babyMatchStatus.total}} 项</span><span v-else>已分析 {{babyMatchStatus.coverage.done}} / {{babyMatchStatus.coverage.total}} 项</span><span v-if="babyMatchStatus.coverage.pending"> · 未分析 {{babyMatchStatus.coverage.pending}}</span><span v-if="babyMatchStatus.coverage.error"> · 失败 {{babyMatchStatus.coverage.error}}</span><span v-if="babyMatchStatus.coverage.noFaces"> · 未检测到人脸 {{babyMatchStatus.coverage.noFaces}}</span><span v-if="babyMatchStatus.invalidReferences"> · 参考不可用 {{babyMatchStatus.invalidReferences}}</span><span v-if="babyMatchScope==='all'&&(babyMatchStatus.coverage.pending||babyMatchStatus.coverage.error)"> · 分析未完成项请切换对应照片库</span><button v-if="babyMatchStatus.coverage.pending" class="text-button" :disabled="busy||faceAnalysisBusy||babyMatchScope==='all'" @click="run(()=>api!.analyzeFaces(libraryId),'继续分析未完成的媒体。')">继续分析</button><button v-if="babyMatchStatus.coverage.error" class="text-button" :disabled="busy||faceAnalysisBusy||babyMatchScope==='all'" @click="run(()=>api!.analyzeFaces(libraryId,true),'只重试识别失败的项目。')">仅重试失败</button><button v-if="babyMatchStatus.coverage.supplementPending" class="text-button supplement-faces-button" :disabled="supplementDisabled" @click="supplementFaces(babyMatchScope)">补检漏识别 · {{supplementScopeLabel}} {{babyMatchStatus.coverage.supplementPending}} 项</button><button v-if="babyMatchStatus.invalidReferences" class="text-button" @click="emit('change-page','references')">补充参考</button></div>
              <button v-if="['timeline','matches'].includes(page)&&babySupplementPending&&!babyMatchStatus" class="text-button supplement-faces-button" :disabled="supplementDisabled" :title="`${supplementScopeLabel} · 待补检 ${babySupplementPending} 项`" @click="supplementFaces(babyMatchScope)">补检漏识别 · {{babySupplementPending}}</button>
              <p v-if="!babyMatchStatus" class="recognition-details-tip">识别进度与失败明细可在顶部「处理记录」查看。</p>
            </UiPopover>
        </div>
      </div>
      <div v-if="module==='baby'&&!baby" class="family-empty"><span>♡</span><h2>先为宝宝建立档案</h2><p>设置出生日期后，可以关联已有照片与视频，按月龄回看并导出照片水印副本。</p><button class="primary-button" @click="editProfile(null)">建立宝宝档案</button></div>
      <template v-if="!similarReference"><FaceRebuildNotice v-for="status in visibleRebuilds" :key="status.libraryId" :status="status" :current-library-id="libraryId" :disabled="busy||faceAnalysisBusy||scanImportBusy||!family?.modelReady||!receiver?.currentLibraryAvailable" @resume="resumeFaceRebuild" /></template>
      <template v-if="module!=='baby'||baby">
        <section v-if="module==='baby'&&page==='profile'&&!similarReference" class="directory-panel"><h2>宝宝档案</h2><dl v-if="baby" class="profile-details"><div><dt>昵称</dt><dd>{{baby.name}}</dd></div><div><dt>出生日期</dt><dd>{{baby.birthday}}</dd></div><div><dt>自动匹配</dt><dd>{{baby.autoMatch?'已开启':'未开启'}}</dd></div><div><dt>人脸参考</dt><dd>{{baby.referenceFaces.length}} 个</dd></div></dl><button class="secondary-button" @click="editProfile(baby)">修改档案与自动匹配</button><details class="compact-help"><summary>出生日期用途</summary><p>出生日期用于月龄分组和水印。修改出生日期后重新计算显示，已有水印副本保留。</p></details></section>
        <template v-else>
          <section v-if="!similarReference&&(page==='people'||page==='references'||page==='candidates')" class="directory-panel recognition-panel"><div class="section-heading"><div><h2>本地人物查找</h2><span class="recognition-state">{{family?.modelReady?(family.analysis?`已分析 ${family.analysis.done} 项 · 检测到 ${family.analysis.faceCount} 张人脸`:'模型已就绪'):(modelLoading?'正在加载模型，已有照片可浏览':'模型不可用，可手动整理')}}</span></div><div class="header-actions"><button class="secondary-button" :disabled="busy||!family?.modelReady||jobs.some(job=>job.kind==='faces'&&job.state==='running')||Boolean(family.analysis&&!family.analysis.pending&&!family.analysis.error)" @click="run(()=>api!.analyzeFaces(libraryId),'已开始本地人脸分析，请查看处理进度。')">{{family?.analysis&&!family.analysis.pending&&!family.analysis.error?'分析已完成':family?.analysis?.error&&!family.analysis.pending?'重试识别失败的项目':'分析图库人脸'}}</button><button v-if="family?.analysis?.error" class="text-button" :disabled="busy||faceAnalysisBusy" @click="run(()=>api!.analyzeFaces(libraryId,true),'只重试识别失败的项目，已完成缓存保留。')">仅重试失败</button><button v-if="family?.analysis?.supplementPending" class="text-button supplement-faces-button" :disabled="supplementDisabled" :title="`当前照片库 · 待补检 ${family.analysis.supplementPending} 项`" @click="supplementFaces()">补检漏识别 · {{family.analysis.supplementPending}}</button><button v-if="baby" class="primary-button" :disabled="busy||babyMatchRunning||babyRebuildBlocked||!baby.referenceFaces.length" @click="findBabyMatches">{{babyMatchRunning?'正在匹配缓存…':'查找宝宝照片'}}</button></div></div><p v-if="family?.modelError" class="error-text">{{family.modelError}}</p><div v-if="page==='references'&&baby" class="reference-picker-entry"><button class="secondary-button" aria-label="选择参考照片" :disabled="busy" @click="selectionMode=true">选择参考照片</button><span>已选 {{baby.referenceFaces.length}} 张参考人脸 · 可以添加不同角度和成长阶段的照片</span></div><div v-if="page==='references'&&baby" class="reference-list"><div v-for="reference in baby.referenceFaces" :key="`${reference.assetId}-${reference.faceId}`" class="reference-item"><img v-if="thumbnails[reference.assetId]" :src="thumbnails[reference.assetId]" alt="已选宝宝人脸参考"><span v-else>原文件不可用</span><button class="text-button" :disabled="busy" @click="removeReference(reference.assetId,reference.faceId)">移除参考</button></div><p v-if="!baby.referenceFaces.length">还没有参考，打开下方照片并选择宝宝的人脸。</p></div><details class="compact-help"><summary>{{page==='references'?'参考照片怎么选':'人物查找说明'}}</summary><p>照片与人脸特征在电脑本地处理。</p><template v-if="page==='references'"><p>可选择不同成长阶段的参考。人脸分析完成后，照片详情会显示可选的人脸框；多人照片需明确选中宝宝的脸。</p><p>此处的电脑人脸参考独立于手机上的参考，不随相册记录同步。</p></template></details></section>

          <details v-if="page==='candidates'&&!similarReference" class="compact-help"><summary>候选确认规则</summary><p>识别结果只是候选。勾选确认后才关联宝宝相册；不确定的项目可以继续保留，识别不能作为备份成功或原图重复的依据。</p></details>

          <GrowthWatermarkEditor v-if="page==='watermark'&&!similarReference&&baby" :key="`${libraryId}-${baby.id}`" inline :assets="watermarkAssets" :baby="baby" :library-id="libraryId" :library-name="currentLibrary?.name" @inspect="inspectWatermarkAsset" @finished="watermarkFinished" />
          <div v-if="peopleOverview" class="person-grouping-tools"><span>人物按相似人脸分组</span><button v-if="family?.ungrouped?.assets" class="text-button" @click="showUngroupedFaces">待归组 · {{family.ungrouped.assets}} 张照片与视频</button><button class="secondary-button" :disabled="busy||faceAnalysisBusy||!receiver?.currentLibraryAvailable||!family?.people.length" @click="openPersonGrouping">{{faceAnalysisBusy?'正在识别人脸…':'整理已识别人脸'}}</button><button class="text-button" :disabled="busy||faceAnalysisBusy||scanImportBusy||!receiver?.currentLibraryAvailable" @click="requestFaceIndexRebuild">{{currentRebuild?'继续重建':'重建人脸索引'}}</button></div>
          <button v-if="peopleOverview&&family?.personGroupingUndo" class="text-button" :disabled="busy" @click="undoPersonGrouping">撤销本次人物整理（{{family.personGroupingUndo.count}} 组）</button><PersonBrowser v-if="peopleOverview" :people="family?.people??[]" :library-id="libraryId" :search="filters.search" @select="openPerson" @rename="editPerson" @merge="openPersonMerge" /><div v-if="page==='people'&&(filters.personId||filters.ungroupedFaces)&&!similarReference" class="person-context"><button class="text-button" @click="backToPeople">← 全部人物</button><button class="text-button" @click="showLibraryPage('all')">全部媒体</button><strong>{{filters.ungroupedFaces?'待归组的人脸':currentPerson?.name||'未命名人物'}}</strong><span v-if="filters.ungroupedFaces">照片和识别特征已保留</span><button v-else class="text-button" @click="editPerson(filters.personId,currentPerson?.name)">修改名称</button></div>
          <div v-if="similarReference" class="similar-face-context">
            <button class="text-button" @click="backToPeople">← 返回</button><button class="text-button" @click="showLibraryPage('all')">全部媒体</button><strong>{{similarReference.name||'所选人脸'}}</strong><span>{{similarScope==='all'?'全部已授权目录':'当前照片库'}}</span>
            <label><span class="visually-hidden">相似人脸查找范围</span><UiSelect v-model="similarScope" aria-label="相似人脸查找范围" :options="[{value:'all',label:'全部已授权目录'},{value:'library',label:'当前照片库'}]" /></label>
            <button class="text-button" @click="toggleSelectionMode">{{selectionMode||selected.size?'结束选择':'选择照片'}}</button>
          </div>
          <div v-if="similarReference&&similarResult" class="similar-face-coverage" role="status">已分析 {{similarResult.coverage.done}} / {{similarResult.coverage.total}} 项<span v-if="similarResult.coverage.pending"> · 待分析 {{similarResult.coverage.pending}} 项</span><span v-if="similarResult.coverage.error"> · 失败 {{similarResult.coverage.error}} 项</span></div>
          <div v-if="!similarReference&&module==='baby'&&page==='matches'" class="baby-match-context" role="status"><strong>全部匹配 {{babyMatchCounts.included+babyMatchCounts.candidates}} 项</strong><button class="text-button" @click="showBabyResults('included')">已加入 {{babyMatchCounts.included}} 项</button><button class="text-button" @click="emit('change-page','candidates')">待确认 {{babyMatchCounts.candidates}} 项</button><span>待确认尚未加入宝宝相册，请核对后确认。</span></div>
          <button v-if="!similarReference&&module==='baby'&&page==='candidates'" class="text-button" @click="emit('change-page','matches')">查看全部匹配</button>
          <p v-if="similarReference&&similarResult&&!similarResult.coverage.done&&!similarResult.total" class="similar-face-empty-analysis">范围内尚无可匹配的人脸结果，暂无匹配不代表没有此人的照片。</p>
          <details v-if="similarReference&&similarResult&&(similarResult.coverage.pending||similarResult.coverage.error)" class="compact-help similar-face-help"><summary>查看未处理范围</summary><p>仅比较已建立索引、当前仍授权可用目录中的有效人脸。未分析或失败部分可能尚未完整匹配，已有有效缓存仍参与查找；未找到结果不代表照片中没有此人。</p><p>相似结果只用于浏览，不会自动加入宝宝相册或合并人物。需要分析其他目录时，请切换对应照片库并明确启动人物分析。</p></details>
          <div v-if="selected.size" class="selection-toolbar"><strong>已选 {{selected.size}} 项</strong><template v-if="!similarReference&&page==='references'"><button class="primary-button" :disabled="busy||!referenceCandidates.length" @click="startReferencePicker">逐张选择宝宝人脸</button><span>仅使用所选可用照片，合照请明确选择宝宝的脸</span></template><template v-else-if="!similarReference&&module==='baby'&&['candidates','matches','timeline'].includes(page)"><button class="primary-button" :disabled="busy" @click="membership(true)">确认加入宝宝相册</button><button class="secondary-button" :disabled="busy" @click="membership(false)">确认不是宝宝</button></template><template v-else-if="!similarReference&&module==='baby'&&page!=='references'&&page!=='watermark'"><button class="secondary-button" :disabled="busy" @click="membership(false)">从宝宝相册移除关联</button></template><template v-else-if="module==='library'||similarReference"><UiSelect v-model="selectedBabyId" aria-label="加入的宝宝相册" :options="[{value:'',label:family?.babies.length?'选择宝宝':'尚未创建'},...(family?.babies??[]).map(profile=>({value:profile.id,label:profile.name}))]" /><button class="primary-button" :disabled="busy||!baby" @click="membership(true)">加入宝宝相册</button><button v-if="!family?.babies.length" class="text-button" @click="editProfile(null)">先建立宝宝档案</button></template><button v-if="module==='baby'&&baby&&!similarReference&&['timeline','matches','candidates'].includes(page)" class="secondary-button" :disabled="busy" @click="openWatermark([...selected.values()])">成长水印</button><span>关联不复制原文件</span></div>
          <div v-if="!similarReference||(items.length&&!peopleOverview)" class="gallery-browse-toolbar" :class="{'scan-active':latestLibraryScan?.state==='running'||latestLibraryScan?.state==='error'}">
            <div v-if="items.length&&!peopleOverview" class="month-group-actions"><span :title="similarReference?'相同内容合并展示':`${babyAllScope?'全部已授权目录':'当前库及所有子文件夹'} · 相同内容合并展示`">按月浏览 · 已加载 {{items.length}} 项</span></div>
            <div v-if="!similarReference&&(latestLibraryScan?.state==='running'||latestLibraryScan?.state==='error'||!items.length||peopleOverview)" class="gallery-scan-status"><UiLoading v-if="latestLibraryScan?.state==='running'" :label="scanStatusLabel(latestLibraryScan)" /><span v-else-if="latestLibraryScan?.state==='error'" class="scan-interrupted" role="status">{{latestLibraryScan.scanPurpose==='library'?'上次扫描中断，当前仅显示已有索引，请重新扫描。':'上次扫描或预扫描中断，可重新扫描补查当前库。'}}</span><span v-else>当前库及所有子文件夹 · 相同内容合并展示</span></div>
            <div class="gallery-browse-actions">
              <div v-if="!similarReference" class="gallery-scan-actions"><UiProvider><NButton quaternary type="primary" size="small" :loading="loading" :disabled="busy||loading" @click="refreshGallery">刷新列表</NButton><NButton quaternary type="primary" size="small" :loading="latestLibraryScan?.state==='running'" :disabled="busy||scanImportBusy||!receiver?.currentLibraryAvailable" @click="rescanGallery">{{latestLibraryScan?.state==='running'?'正在扫描…':'重新扫描'}}</NButton></UiProvider></div>
              <div v-if="items.length&&!peopleOverview" class="month-view-actions"><UiProvider><NButton quaternary type="primary" size="small" :loading="folding&&expandingMonths" :disabled="folding||(!monthsCollapsed&&!collapseNewMonths)" @click="expandAllMonths">展开全部</NButton><NButton quaternary type="primary" size="small" :loading="folding&&!expandingMonths" :disabled="folding||(collapseNewMonths&&dateGroups.every(group=>isMonthCollapsed(group.key)))" @click="collapseAllMonths">折叠全部</NButton></UiProvider></div>
            </div>
          </div>
          <UiLoading v-if="folding" class="month-fold-status" :label="expandingMonths?'正在展开月份…':'正在收起月份…'" />
          <UiLoading v-if="loading" class="loading-status" label="正在读取照片…" />
          <div v-if="loading&&!items.length&&!peopleOverview" class="gallery-loading-placeholders" aria-hidden="true"><UiProvider><div v-for="index in 10" :key="index" class="gallery-loading-tile"><NSkeleton width="100%" height="100%" :animated="false" /></div></UiProvider></div>
          <div v-if="items.length&&!peopleOverview" class="media-date-groups">
            <div v-if="failedVisibleThumbnails" class="thumbnail-load-error" role="status"><span>有 {{failedVisibleThumbnails}} 项缩略图未能显示</span><button class="text-button" :disabled="busy||loading" @click="retryThumbnails">重试缩略图</button></div>
            <VirtualMonthGallery ref="virtualGallery" :aria-busy="folding||loading" :groups="dateGroups" :collapsed="isMonthCollapsed" :folding="folding" :thumbnails="thumbnails" :selected="selected" :selection-mode="selectionMode||selected.size>0" :status="babyStatus" :reference="isBabyReference" :stamp="automaticStamp" @toggle="toggleMonth" @open="openAsset" @select="toggleSelection" @favorite="toggleFavorite" @visible="loadVisibleThumbnails" @thumbnail-error="thumbnailLoadFailed" />
          </div>
          <div v-else-if="!loading&&!peopleOverview" class="family-empty"><span>{{!similarReference&&page==='candidates'?'✓':'▧'}}</span><h2>{{similarReference?'暂无相似照片与视频':page==='candidates'?'暂无人物待确认结果':module==='baby'&&babyResultFilter==='unconfirmed'?'当前范围暂无待核对项目':'这里还没有符合条件的照片与视频'}}</h2><p>{{similarReference?'可切换查找范围，或选一张清晰的人脸参考重试。':page==='candidates'?'先设置宝宝人脸参考并执行本地匹配。':module==='baby'?'从照片库手动加入照片，或设置参考后查找宝宝。':'先从手机传入，或将电脑文件夹加入图库。'}}</p><button v-if="!similarReference" class="secondary-button" @click="emit('navigate',module==='baby'?'library':'import')">{{module==='baby'?'打开照片与视频':'去导入与归档'}}</button></div>
          <div v-if="!peopleOverview&&items.length" ref="mediaSentinel" class="media-load-more" :aria-busy="loadingMore"><UiLoading v-if="loadingMore" :label="`正在加载更多… · 已加载 ${items.length} / ${media?.total??0} 项`" /><span v-else class="media-load-summary" role="status"><UiIcon v-if="!moreAvailable" name="check" :size="15" />{{moreAvailable?`已加载 ${items.length} / ${media?.total??0} 项`:`已加载当前索引的全部 ${items.length} 项`}}</span><UiProvider><NButton v-if="moreAvailable" class="gallery-load-button" secondary type="primary" size="small" :disabled="loading||loadingMore" @click="loadMore">{{loadMoreError?'重试加载':'加载更多'}}</NButton></UiProvider><p v-if="loadMoreError" class="error-text" role="alert">{{loadMoreError}}</p></div>
        </template>
      </template>
    </template>

    <UiDialog v-if="rebuildIndexLibrary" content-class="family-dialog small" label="重建人脸索引" @opened="focusRebuildCancel" @close="rebuildIndexLibrary=''">
      <div class="section-heading"><h2>重建人脸索引</h2><button class="text-button" @click="rebuildIndexLibrary=''">取消</button></div>
      <p>当前照片库：{{currentLibrary?.name}}</p><p>先备份，再清理旧人脸与自动人物分组，从原照片和视频重新检测。原文件、宝宝档案和人工相册记录保留。</p>
      <p class="section-tip">宝宝参考会按原来选中的脸重新对应；无法可靠对应的参考需要再次选择。重建进度与跳过原因在处理记录查看。</p>
      <button class="primary-button" :disabled="busy||faceAnalysisBusy||scanImportBusy||rebuildIndexLibrary!==libraryId" @click="confirmFaceIndexRebuild">备份并重建</button>
    </UiDialog>
    <UiDialog v-if="recordsOpen" content-class="processing-records-dialog" label="本地处理记录" @opened="recordsDialog=$event" @close="closeProcessingRecords">
      <header class="processing-records-heading"><div><h2>本地处理记录</h2><p>{{currentLibrary?.name??'当前照片库'}} · {{runningJobCount?runningJobCount+' 项处理中':failedJobCount?failedJobCount+' 条失败记录':'最近 '+jobs.length+' 次'}}</p></div><button class="text-button" aria-label="关闭处理记录" autofocus @click="closeProcessingRecords">关闭</button></header>
      <div class="processing-records-body"><section v-if="jobs.length" class="family-jobs"><p class="section-tip">已结束的任务保留为历史记录，不会因打开页面或刷新而重新执行。</p><div v-for="job in jobs" :key="job.id" class="job-row"><div><strong>{{job.kind==='scan'?'扫描图库':job.kind==='import'?'导入与归档':job.kind==='matching'?'匹配宝宝照片':'分析人物'}}</strong><span>{{jobProgressLabel(job)}}</span></div><p v-if="job.kind==='scan'&&job.state==='running'" class="section-tip scan-timing">{{scanTiming(job)}}</p><p v-if="!job.libraryId" class="section-tip">历史任务 · 未记录照片库范围</p><p v-if="job.label" class="section-tip">{{job.state==='running'?'当前进度':'最后进度'}}：{{job.label}}</p><progress v-if="job.state==='running'" :value="progressValue(job)" :max="progressMaximum(job)"></progress><p v-if="job.skipped" class="section-tip">已跳过 {{job.skipped}} 项，请检查下方原因；来源文件保留。</p><p v-if="job.sourceFiles!==undefined" class="section-tip">来源文件 {{job.sourceFiles}} 项 · 去重后媒体 {{job.uniqueMedia??0}} 项 · 跳过 {{job.skipped??0}} 项</p><p v-if="job.duplicates" class="section-tip">相同内容合并 {{job.duplicates}} 项；文件已处理，图库按内容展示一次。</p><ProcessingWarnings v-if="job.skipped||job.warnings?.length" :report-id="job.warningReportId" :warnings="job.warnings" :skipped="job.skipped" :library-id="libraryId" :running="job.state==='running'" /><p v-if="job.error" class="error-text">{{job.error}}</p></div></section><p v-else class="processing-records-empty">暂无本地处理记录</p>
    <details class="compact-help"><summary>原文件保留规则</summary><p class="media-preservation-tip">照片与视频均保留；移出相册、取消收藏和移除人脸参考只修改记录，不删除文件。</p></details>
      </div>
    </UiDialog>

    <PersonMergeDialog v-if="personMergeSource" :people="family?.people??[]" :source-id="personMergeSource" :library-id="libraryId" :busy="busy" :error="personMergeError" @close="closePersonMerge" @confirm="mergePersons" />
    <PersonGroupingDialog v-if="groupingOpen" :preview="groupingPreview" :loading="groupingLoading" :busy="busy" :error="groupingError" :library-id="libraryId" :suspended="groupingInspection" @close="closePersonGrouping" @retry="openPersonGrouping" @confirm="applyPersonGrouping" @inspect="inspectGroupingPerson" />
    <BabyProfileDialog v-if="profileOpen&&profileDraft" :key="profileDraft.id" :profile="profileDraft" :creating="!family?.babies.some(item=>item.id===profileDraft?.id)" :library-id="libraryId" :library-available="receiver?.currentLibraryAvailable!==false" :busy="busy" :error="profileError" :choose-avatar="profileChooseAvatar" :suspended="profileReferencePreview" @close="closeProfile" @save="saveProfile" @view-reference="openProfileReference" />
    <UiDialog v-if="personOpen" content-class="family-dialog small person-name-backdrop" label="人物名称" @keydown.tab="trapPersonFocus" @close="closePerson"><div class="section-heading"><h2>人物名称</h2><button class="text-button" @click="closePerson">关闭</button></div><label class="field"><span>给这个人物一个名字</span><input v-model="personName" maxlength="32" placeholder="例如：妈妈"></label><button class="primary-button" :disabled="busy||!personName.trim()" @click="savePerson">保存名称</button><p v-if="personError" class="error-text" role="alert">{{personError}}</p></UiDialog>
    <MediaPreview v-if="detail" ref="mediaPreview" :asset="detail" :src="detailUrl" :loading="detailLoading" :error="detailError" :poster="thumbnails[detail.id]" :counter="referencePicking||profileReferencePreview?'':detailCounter" :close-label="profileReferencePreview?'返回档案':undefined" :caption="[detail.date??'日期未知',canSelectBabyFace?ageFor(detail):undefined].filter(Boolean).join(' · ')" :can-previous="canPreviewPrevious&&!busy" :can-next="canPreviewNext&&!busy" :navigation-loading="navigationLoading" :face-selection="faceSelectionMode" :reference-picking="referencePicking" :suspended="Boolean(watermarkDialog)||personOpen||(groupingOpen&&!groupingInspection)" @close="closePreview" @previous="navigatePreview(-1)" @next="navigatePreview(1)" @retry="retryPreview" @video-ready="mediaVideo=$event">
      <template #header-actions><button class="text-button preview-family-action" :class="{'preview-is-favorite':detail.favorite}" :aria-label="detail.favorite?'取消收藏':'收藏照片'" :title="detail.favorite?'取消收藏':'收藏照片'" :disabled="busy" @click="togglePreviewFavorite"><UiIcon name="heart" :size="18" /></button><button v-if="canSelectBabyFace&&detail.kind==='photo'&&!faceSelectionMode&&!referencePicking" class="secondary-button preview-family-action" :disabled="busy" @click="openWatermark([detail])">成长水印</button><button v-if="canSelectBabyFace&&!faceSelectionMode" class="secondary-button preview-family-action" :disabled="busy||!detail.available||!detail.faces.length" @click="startFaceSelection">选择宝宝人脸</button><button v-else-if="filters.ungroupedFaces&&!faceSelectionMode" class="secondary-button preview-family-action" :disabled="busy||!detail.available" @click="startFaceSelection">选择人脸查找</button><button v-if="faceSelectionMode&&!referencePicking" class="text-button preview-family-action" @click="exitFaceSelection">退出选脸</button></template>
      <template #progress><FaceAnalysisProgress v-if="faceAnalysisJob" :job="faceAnalysisJob" :processed="handledCount(faceAnalysisJob)" :face-count="family?.analysis?.faceCount??0" :now="progressNow" /><div v-if="referencePicking" class="reference-picker-progress"><strong>选择宝宝人脸 · {{referenceIndex+1}} / {{referenceQueue.length}}</strong><button class="text-button" :disabled="busy" @click="advanceReferencePicker">跳过这张照片</button></div><p v-if="referencePickerError" class="reference-picker-error error-text" role="alert">{{referencePickerError}}</p></template>
      <template #feedback="{informationOpen}"><div v-if="canSelectBabyFace&&!faceSelectionMode&&!referencePicking" class="preview-baby-review"><span>{{babyStatus(detail)}}<small v-if="isBabyReference(detail)"> · 已作参考</small></span><button class="secondary-button" :disabled="busy" @click="confirmPreviewMembership(true)">是宝宝</button><button class="text-button" :disabled="busy" @click="confirmPreviewMembership(false)">不是宝宝</button><button class="secondary-button" :disabled="busy||!detail.available||!detail.faces.length" @click="startFaceSelection">确认并设为参考</button></div><p v-if="detailActionError&&!informationOpen" class="error-text" role="alert">{{detailActionError}}</p><div v-if="navigationError" class="preview-navigation-error" role="alert"><span>{{navigationError}}</span><button class="text-button" aria-label="重试切换" :disabled="navigationLoading||busy" @click="navigatePreview(1)">重试切换</button></div></template>
      <template #overlay><div v-if="faceSelectionMode&&detail.faces.length&&detail.kind==='photo'" class="face-layer"><button v-for="(face,index) in detail.faces" :key="face.id" class="face-box" :class="{chosen:selectedFaceId===face.id}" :style="faceStyle(face)" :aria-label="`选择人脸 ${index+1}${face.personName?` ${face.personName}`:''}`" @click="selectFace(face)"><span>{{face.personName||`人脸 ${index+1}`}}</span></button></div></template>
      <template #media-overlay><GrowthWatermarkStamp v-if="automaticStamp(detail, previewWatermark)" :stamp="automaticStamp(detail, previewWatermark)!" /></template>
      <template #toolbar-actions><button v-if="module==='baby'&&baby&&detail.kind==='photo'&&page!=='references'&&!similarReference&&!faceSelectionMode" class="text-button auto-growth-watermark" role="switch" aria-label="预览显示成长水印" :aria-checked="previewWatermark" title="全局开启或关闭成长水印" @click="toggleAutomaticWatermark"><span class="growth-switch-track" aria-hidden="true"></span>水印</button></template>
      <template #face-tools>
        <FaceSelector v-if="detail.faces.length" :faces="detail.faces" :src="detailUrl" :kind="detail.kind" :selected-id="selectedFaceId" @select="id=>{const face=detail?.faces.find(item=>item.id===id);if(face)selectFace(face)}" />
        <p v-if="detail.faces.length" class="section-tip">{{canSelectBabyFace?'点击头像或人脸框选择宝宝。':'选择待归组人脸，在全部已授权目录查找相似照片。'}}{{detail.kind==='video'?'视频框来自分析帧，请结合下方时间核对。':''}}</p><p v-else-if="detail.faceState==='pending'">{{faceAnalysisBusy?'本地人脸分析正在进行，结果更新后可选择人脸。':'尚未分析人脸，可在人物查找页面开始本地分析。'}}</p><p v-else-if="detail.faceState==='done'">本次未检测到可供选择的人脸。</p><p v-if="detail.faceError" class="error-text">{{detail.faceError}}</p>
        <button v-if="canSelectBabyFace&&detail.faces.length&&!selectedFace" class="primary-button" disabled>设为宝宝人脸参考</button><div v-if="selectedFace" class="face-actions"><span>已选 {{selectedFace.personName||'未命名人脸'}}{{selectedFace.frameTime!==undefined?` · 视频 ${duration(selectedFace.frameTime)}`:''}}</span><small v-if="selectedFace.reviewRequired" class="supplement-face-label">补检人脸</small><UiSelect v-if="canSelectBabyFace" v-model="selectedBabyId" :disabled="referencePicking" aria-label="此人脸对应的宝宝" :options="[{value:'',label:family?.babies.length?'选择宝宝':'尚未创建'},...(family?.babies??[]).map(profile=>({value:profile.id,label:profile.name}))]" /><button v-if="canSelectBabyFace" class="primary-button" :disabled="busy||!baby" @click="saveReference">设为宝宝人脸参考</button><button class="secondary-button" :disabled="busy||!detail.available" @click="startSimilarFaces(detail.id,selectedFace.id,selectedFace.personName,selectedFace.personId)">查找相似照片</button><button v-if="selectedFace.personId" class="secondary-button" @click="editPerson(selectedFace.personId,selectedFace.personName)">给人物命名</button></div>
      </template>
      <template #information><dl class="detail-metadata"><div v-if="detail.faces.some(face=>face.reviewRequired)"><dt>人脸补检</dt><dd>补检人脸 · 宝宝匹配结果需人工确认</dd></div><div v-if="canSelectBabyFace"><dt>宝宝识别结果</dt><dd>{{babyStatus(detail)||'未匹配'}}<span v-if="isBabyReference(detail)"> · 已作参考</span><small v-if="babyReviewReason(detail)">{{babyReviewReason(detail)}}</small><small v-if="babyDecision(detail)?.score!==undefined">特征相似程度 {{Number(babyDecision(detail)?.score).toFixed(2)}}，不是身份概率。</small></dd></div><div><dt>文件信息</dt><dd>{{detail.kind==='video'?'视频':'照片'}} · {{size(detail.size)}}<template v-if="detail.width&&detail.height"> · {{detail.width}} × {{detail.height}}</template><template v-if="detail.kind==='video'"> · {{duration(detail.duration)}}</template></dd></div><div><dt>拍摄与归档日期</dt><dd>{{detail.date??'日期未知'}} · {{dateLabel(detail.dateSource)}}{{detail.dateConfirmed?' · 已确认':''}}</dd></div><div v-if="baby"><dt>{{baby.name}}的月龄</dt><dd>{{ageFor(detail)}}</dd></div><div><dt>来源日期记录</dt><dd>拍摄日期：{{detail.captureDate??'缺失'}}<br>来源创建日期：{{detail.creationDate??'缺失'}}</dd></div><div><dt>宝宝相册关联</dt><dd>{{detail.babyIds.map(id=>family?.babies.find(profile=>profile.id===id)?.name??'宝宝档案').join('、')||'尚未加入'}}</dd></div><div><dt>原文件保存位置</dt><dd v-for="location in detail.locations" :key="location.id"><strong>{{location.available?'可用':'不可用'}} · {{location.source==='phone'?'手机来源':'电脑文件夹'}}</strong><br>{{location.path}}<small>{{location.receiptId?'具有该目标的保存回执':'索引位置，不代表本次目标的保存回执'}}</small></dd></div></dl><label class="field"><span>确认或修正实际拍摄日期</span><UiDatePicker v-model="editedDate" :max="today" label="确认或修正实际拍摄日期" @validity-change="editedDateValid=$event" /></label><button class="secondary-button" :disabled="busy||!editedDate||!editedDateValid" @click="saveDate">保存确认日期</button><button class="text-button" :disabled="!detail.available||busy" @click="revealDetail">打开原文件位置</button><p v-if="detailActionError" class="error-text" role="alert">{{detailActionError}}</p><p v-if="!detail.available" class="error-text">原文件当前不可用。请重新连接来源硬盘或核对授权目录；历史记录仍保留。</p><p v-if="detail.kind==='video'" class="section-tip">视频显示拍摄时的月龄，照片水印导出不处理视频。</p></template>
    </MediaPreview>
    <GrowthWatermarkEditor v-if="watermarkDialog&&baby" :assets="watermarkDialog" :baby="baby" :library-id="libraryId" :library-name="currentLibrary?.name" @close="watermarkDialog=null" @inspect="inspectWatermarkAsset" @finished="watermarkFinished" />
  </section>
</template>

<style scoped>
.auto-growth-watermark{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:11px}.growth-switch-track{position:relative;display:inline-block;width:24px;height:14px;flex:none;border-radius:8px;background:#c6d0c9}.growth-switch-track::after{content:"";position:absolute;left:2px;top:2px;width:10px;height:10px;border-radius:50%;background:#fff}.auto-growth-watermark[aria-checked=true] .growth-switch-track{background:#3b755c}.auto-growth-watermark[aria-checked=true] .growth-switch-track::after{left:12px}.auto-growth-watermark:focus-visible{outline:2px solid #76ac8d;outline-offset:2px}
.watermark-problems{font-size:11px;margin:10px 0;color:#89672d;max-height:150px;overflow:auto}.watermark-problems ul{padding:0;list-style:none;margin:5px 0}.watermark-problems li{display:flex;align-items:center;gap:6px;min-width:0}.watermark-problems .text-button{max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;padding:4px 0}.watermark-problems span{font-size:10px}
.baby-review-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0;font-size:11px}.baby-result-filter{display:flex;gap:3px;background:#f0f4f1;border-radius:20px;padding:3px}.baby-result-filter button{border:0;background:transparent;border-radius:16px;padding:5px 10px;min-height:30px;color:#63766a;font-size:11px}.baby-result-filter .selected{background:#3b755c;color:#fff}.baby-review-toolbar select{width:auto;min-height:30px;font-size:11px;padding:4px 8px}.baby-review-toolbar>.text-button{margin-left:auto;font-size:11px}.baby-match-coverage{font-size:11px;color:#6c7b71;line-height:1.7;margin-bottom:10px}.baby-match-coverage button{font-size:11px;padding:4px 8px}.preview-baby-review{display:flex;gap:6px;align-items:center;padding:6px 12px;font-size:11px;flex-wrap:wrap}.preview-baby-review>span{margin-right:auto;color:#496654}.preview-baby-review button{font-size:11px;min-height:30px;padding:5px 8px}.preview-baby-review small{font-size:10px}@media(max-width:450px){.baby-review-toolbar{gap:6px}.baby-result-filter button{padding:5px 8px}.preview-baby-review{padding:5px 8px;gap:4px}.preview-baby-review>span{display:none}.preview-baby-review button{padding:4px 6px;font-size:10px}}
.person-grouping-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0 14px;font-size:11px;color:#718078}.person-grouping-tools>span{margin-right:auto}.person-grouping-tools .secondary-button{min-height:30px;padding:5px 10px;font-size:11px}.person-grouping-tools .text-button{min-height:30px;font-size:11px}
.family-workspace .baby-profile-banner{display:flex;flex-wrap:wrap;gap:12px;padding:10px 12px;align-items:center;background:#f3f6f4}
.family-workspace .baby-profile-summary{flex:1 1 160px;gap:5px;flex-direction:column;align-items:flex-start}.family-workspace .baby-profile-summary .baby-selector{flex:none;width:100%;max-width:220px}.baby-summary-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.family-workspace .baby-age{font-size:12px;font-weight:500}.baby-birthday{font-size:11px;color:#7c8b82}
.baby-avatar-action{display:flex;flex:none;flex-direction:column;align-items:center;gap:3px;padding:0;border:0;background:transparent;color:#47735c;cursor:pointer}.baby-avatar-action span{font-size:10px}.baby-avatar-action:hover:not(:disabled){color:#2f6147}.baby-avatar-action:focus-visible{outline:2px solid #689b80;outline-offset:4px}.baby-profile-actions{display:flex;gap:6px;flex-wrap:wrap;min-width:0}.baby-profile-actions button{flex:none;padding:7px 10px;min-height:32px;font-size:12px;white-space:nowrap}.baby-profile-actions .text-button{display:flex;gap:4px;align-items:center}
@media(max-width:600px){.family-workspace .baby-profile-banner{gap:8px;padding:8px 10px}.family-workspace .baby-profile-summary{flex-basis:calc(100% - 76px)}.baby-profile-actions{margin-left:58px;flex:1}.baby-profile-actions button{padding:6px 9px;min-height:30px}.baby-birthday{font-size:10px}}
.family-workspace .preview-backdrop.person-name-backdrop{z-index:70}.preview-navigation-error{display:flex;align-items:center;gap:8px;padding:6px 14px;background:#fff7ec;color:#8c6338;font-size:12px;overflow-wrap:anywhere}.preview-navigation-error span{flex:1;min-width:0}.preview-navigation-error button{flex:none}.reference-picker-progress{margin:0;padding:6px 14px}.reference-picker-error{margin:0;padding:6px 14px}.preview-family-action{flex:none}.preview-is-favorite :deep(svg){fill:#dce8df;stroke:#3b755c}
:global(.processing-records-dialog){width:min(760px,calc(100vw - 32px));max-width:none;max-height:calc(100vh - 32px);padding:0;border:1px solid #e2e8e3;border-radius:12px;background:#fff;color:#232b27;box-shadow:0 16px 50px #17241b24;overflow:hidden}:global(.processing-records-dialog){display:flex;flex-direction:column}.processing-records-dialog::backdrop{background:#17241b55}.processing-records-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:16px 20px;border-bottom:1px solid #e5eae6}.processing-records-heading h2{margin:0;font-size:18px;font-weight:600}.processing-records-heading p{margin:6px 0 0;font-size:11px;color:#718078;overflow-wrap:anywhere}.processing-records-heading .text-button{flex:none;font-size:12px}.processing-records-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px 20px 18px;font-size:12px}.processing-records-body .family-jobs{margin:0;border:0;padding:0;background:none}.processing-records-body .job-row{overflow-wrap:anywhere}.processing-records-empty{padding:24px 0;text-align:center;color:#718078}@media(max-width:450px){.processing-records-heading{padding:14px}.processing-records-body{padding:10px 14px 14px}.processing-records-heading h2{font-size:16px}}
@media(max-width:450px){.baby-results-toolbar .media-toolbar-heading{flex:0 0 100%}.baby-results-toolbar .media-toolbar-heading h1{white-space:nowrap}}
.gallery-scan-status,.baby-match-context{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px;font-size:11px;color:#718078;min-width:0}.gallery-scan-status>span{flex:1;min-width:0;overflow-wrap:anywhere}.baby-match-context .text-button{font-size:11px;padding:5px 8px;white-space:nowrap}.gallery-scan-status .scan-interrupted{color:#89672d}.baby-match-context strong{font-weight:500;color:#3b755c}.baby-match-context>span{flex-basis:100%}
.family-jobs .section-tip{margin:6px 0;padding:0;border:0;background:none;line-height:1.6}
.month-group-actions{display:flex;align-items:center;min-width:0;color:#718078;font-size:11px}.month-view-actions .n-button,.gallery-scan-actions .n-button{height:28px;font-size:11px;padding:0 8px}
/* 说明文字与月份标题共用文字起点，右侧操作与数量标签共用内边距。 */
.family-workspace{--gallery-row-padding:10px;--gallery-heading-gap:9px}
.gallery-browse-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:2px 12px;min-height:28px;margin:0 0 4px;padding:0 var(--gallery-row-padding) 0 calc(var(--gallery-row-padding) + 16px + var(--gallery-heading-gap));line-height:1.4}
.gallery-browse-toolbar .month-group-actions{flex:1 1 150px;min-height:28px}
.gallery-browse-toolbar .gallery-scan-status{flex:1 1 180px;margin:0;min-height:24px}
/* 日常浏览只占一行，扫描进度和中断原因按需独立展示。 */
.gallery-browse-toolbar.scan-active .gallery-scan-status{order:3;flex-basis:100%}
.gallery-browse-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:2px 8px;max-width:100%;margin-left:auto}
.gallery-scan-actions,.month-view-actions{display:flex;align-items:center;gap:4px}
.gallery-scan-actions+.month-view-actions{border-left:1px solid #e5eae6;padding-left:8px}
@media(max-width:450px){.family-workspace{--gallery-row-padding:7px;--gallery-heading-gap:6px}}
.gallery-scan-status>.ui-loading{flex:1;font-size:11px;gap:7px}.month-fold-status.ui-loading{position:sticky;top:0;z-index:3;padding:7px 10px;margin:0 0 8px;border:1px solid #e0ebe3;border-radius:8px;background:#f4f8f5;color:#436851;min-height:34px}.loading-status.ui-loading{margin:4px 0 10px;font-size:12px}.gallery-loading-placeholders{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;margin:0 0 12px}.gallery-loading-tile{aspect-ratio:1;min-width:0;overflow:hidden;border-radius:6px}.media-load-summary{display:flex;align-items:center;gap:6px;font-size:11px}.media-load-summary .ui-icon{color:#64846f}.media-load-more .ui-loading{font-size:11px}.gallery-load-button.n-button{height:30px;font-size:11px;padding:0 12px}
@media(max-width:760px){.gallery-loading-placeholders{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:450px){.gallery-loading-placeholders{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(prefers-reduced-motion:reduce){.gallery-scan-actions :deep(.n-base-loading),.month-view-actions :deep(.n-base-loading),.gallery-scan-actions :deep(.n-base-wave),.month-view-actions :deep(.n-base-wave){display:none!important}}
.similar-face-context{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;margin:0 0 8px;font-size:12px}.similar-face-context strong{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.similar-face-context>span,.similar-face-coverage{color:#718078;font-size:11px}.similar-face-context>label{margin-left:auto;min-width:0}.similar-face-context select{max-width:100%;height:32px;border:1px solid #e5eae6;border-radius:7px;background:#fff;padding:0 8px;color:#52675b;font:inherit;font-size:11px}.similar-face-context .text-button{font-size:11px}.similar-face-coverage{margin-bottom:10px}.similar-face-empty-analysis{font-size:11px;color:#896b48;margin:0 0 10px}.similar-face-help{margin:0 0 10px}@media(max-width:450px){.month-group-actions{gap:4px}.month-group-toggle{gap:6px}.month-group-toggle>span{font-size:9px}.similar-face-context{gap:6px}.similar-face-context strong{max-width:120px}.similar-face-context>span{flex-basis:calc(100% - 70px)}.similar-face-context>label{margin-left:0}}

/* 宝宝浏览工具集中在顶部，识别说明按需展开，滚动时保留档案和筛选。 */
:global(.app-shell .page-content:has(.baby-gallery-header)){padding-top:0}
.baby-gallery-header{--header-inset:22px;position:sticky;top:0;z-index:4;margin:0 calc(-1 * var(--header-inset)) 4px;padding:6px var(--header-inset) 5px;background:#fff;border-bottom:1px solid #e5eae6;box-shadow:0 3px 6px #23382b06}
.baby-gallery-header .baby-profile-banner{gap:10px;padding:6px 10px;margin:0 0 6px;border-radius:6px}
.baby-gallery-header .baby-profile-summary{display:flex;flex-direction:row;align-items:center;flex-wrap:wrap;gap:4px 12px;flex:1 1 180px}
.baby-gallery-header .baby-profile-summary .baby-selector{width:150px;max-width:100%}
.baby-gallery-header .baby-summary-meta{gap:8px}
.baby-gallery-header .baby-avatar-action{gap:2px}
.baby-gallery-header .baby-avatar-action span{font-size:9px}
.baby-gallery-header .baby-profile-actions{margin:0;gap:4px}
.baby-gallery-header .baby-profile-actions button{min-height:30px;padding:5px 8px;font-size:11px}
.baby-gallery-header .baby-tools{align-self:center}
.baby-gallery-header .media-search-toolbar{gap:8px;margin:0 0 4px}
.baby-gallery-header .gallery-search{margin-left:0}
.baby-gallery-header .growth-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;margin:0 0 3px}
.baby-gallery-header .growth-months{flex:1;min-width:0;border:0;gap:18px}
.baby-gallery-header .growth-months button{padding:6px 0;font-size:11px}
.baby-gallery-header .growth-context{flex:none;gap:10px;margin:0;font-size:10px}
.baby-gallery-header .growth-context>span{margin:0}
.baby-gallery-header .growth-context .text-button{min-height:28px;padding:4px 0;font-size:11px}
.baby-gallery-header .baby-review-toolbar{gap:6px;margin:0;min-height:32px}
.baby-gallery-header .baby-result-filter{padding:2px}
.baby-gallery-header .baby-result-filter button{min-height:28px;padding:4px 9px}
.baby-gallery-header .baby-review-toolbar :deep(.ui-select){width:144px}
.baby-gallery-header .baby-review-toolbar>.text-button{margin-left:0;padding:4px 6px;min-height:28px}
.baby-recognition-details{margin-left:auto}
.recognition-details-trigger{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:4px 0;font-size:11px;white-space:nowrap}
.recognition-details-trigger b{font-size:10px;font-weight:400;color:#a25f40;background:#f8eee7;border-radius:8px;padding:1px 5px}
.baby-recognition-status{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 8px;font-size:11px;color:#718078}
.baby-recognition-status .text-button{font-size:11px;padding:4px 0}
.baby-match-coverage{margin:0;line-height:1.8}
.recognition-details-tip{font-size:11px;color:#718078;margin:0}
@media(max-width:1000px){.baby-gallery-header{--header-inset:18px}.baby-gallery-header .baby-profile-summary{gap:4px 8px}.baby-gallery-header .baby-profile-summary .baby-selector{width:140px}.baby-gallery-header .baby-birthday{display:none}}
@media(max-width:760px){.baby-gallery-header{--header-inset:14px}.baby-gallery-header .media-search-toolbar{flex-wrap:wrap}.baby-gallery-header .gallery-search{order:5;flex-basis:100%;max-width:none}.baby-gallery-header .growth-toolbar{gap:2px 8px}.baby-gallery-header .growth-months{flex-basis:100%}.baby-gallery-header .growth-context{width:100%;justify-content:flex-end}.baby-gallery-header .baby-profile-summary{flex-direction:column;align-items:flex-start;flex-basis:calc(100% - 90px)}.baby-gallery-header .baby-profile-actions{margin-left:0;flex:1}.baby-gallery-header .baby-profile-actions button{padding:4px 7px}.baby-gallery-header .baby-review-toolbar{gap:4px}}
@media(max-width:450px){.baby-gallery-header{--header-inset:10px}.baby-gallery-header .baby-profile-banner{gap:6px;padding:6px 8px}.baby-gallery-header .growth-months{gap:16px}.baby-gallery-header .baby-result-filter button{padding:4px 7px;font-size:10px}.baby-gallery-header .media-toolbar-heading h1{font-size:14px}}

@media(max-width:760px){
  .baby-gallery-header .baby-profile-banner{display:grid;grid-template-columns:36px minmax(0,1fr) 34px;gap:6px 10px}
  .baby-gallery-header .baby-avatar-action{grid-column:1;grid-row:1}
  .baby-gallery-header .baby-profile-summary{grid-column:2;grid-row:1}
  .baby-gallery-header .baby-tools{grid-column:3;grid-row:1}
  .baby-gallery-header .baby-profile-actions{grid-column:1/-1;grid-row:2}
  .baby-gallery-header .media-search-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px}
  .baby-gallery-header .media-toolbar-heading{grid-column:1;grid-row:1}
  .baby-gallery-header .media-kind-filter{grid-column:2/4;grid-row:1;justify-self:end}
  .baby-gallery-header .gallery-search{grid-column:1;grid-row:2;order:0;min-width:0}
  .baby-gallery-header .gallery-order{grid-column:2;grid-row:2;margin:0}
  .baby-gallery-header .gallery-tools{grid-column:3;grid-row:2}
  .baby-gallery-header .baby-review-toolbar :deep(.ui-select){width:134px}
}
</style>

<style scoped>
.thumbnail-load-error{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;color:#a25f40;font-size:12px}.thumbnail-load-error button{white-space:nowrap}
.reference-picker-mode{max-width:720px}.reference-picker-mode .section-heading h2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}.reference-picker-mode .media-detail-layout{grid-template-columns:1fr}.reference-picker-mode .detail-media-stage{width:min(100%,calc(320px * var(--media-aspect-ratio)));margin:0 auto}.reference-picker-mode .face-actions{margin-top:8px}.reference-picker-mode .section-tip{padding:4px 0;background:none;border:0;font-size:11px}.reference-picker-error{margin:8px 0 12px}
.reference-picker-entry,.reference-picker-progress{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px}.reference-picker-entry{margin:12px 0 8px;color:#718078}.reference-picker-entry button{white-space:nowrap}.reference-picker-progress{justify-content:space-between;margin-bottom:12px;padding:8px 0;border-bottom:1px solid #e5eae6;color:#3b755c}
.gallery-order{display:flex;flex:0 0 auto}.gallery-order select{height:32px;max-width:110px;border:1px solid #e5eae6;border-radius:8px;background:#fff;padding:0 6px;color:#52675b;font:inherit;font-size:11px}.media-load-more{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:8px;padding:18px 0;color:#718078;font-size:12px;min-height:52px}.media-load-more .error-text{width:100%;text-align:center}.person-context{display:flex;align-items:center;gap:12px;padding:8px 0 16px;font-size:13px}.baby-recognition-status{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:-8px 0 12px;color:#718078;font-size:11px;min-width:0}.baby-recognition-status span{min-width:0;overflow-wrap:anywhere}.baby-recognition-status button{white-space:nowrap;font-size:11px}@media(max-width:760px){.gallery-order{margin-left:auto}.gallery-order select{max-width:108px}}
</style>
