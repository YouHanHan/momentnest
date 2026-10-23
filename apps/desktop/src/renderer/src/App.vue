<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PairingInfo, ReceiverState } from '../../shared/desktop-api'
import type { DateSource, MediaAsset } from '../../shared/family'
import FamilyWorkspace from './components/FamilyWorkspace.vue'
import MediaPreview from './components/MediaPreview.vue'
import UiIcon from './components/UiIcon.vue'
import UiLoading from './components/UiLoading.vue'
import UiPopover from './components/UiPopover.vue'
import momentnestLogo from '../../../../../assets/branding/momentnest-icon.png'
import { userError } from './ui-error'
import { closePopupMenus } from './popup-dismiss'

type Module = 'import' | 'library' | 'baby'
type Page = 'receive' | 'directories' | 'history' | 'folder' | 'all' | 'people' | 'favorites' | 'timeline' | 'matches' | 'candidates' | 'references' | 'watermark' | 'profile'
const module = ref<Module>('library')
const page=ref<Page>('all'),notice=ref(''),busy=ref(false),state=ref<ReceiverState|null>(null)
const stateReadError=ref(''),refreshing=ref(false)
const appVersion = ref(''), versionError = ref(''), versionLoading = ref(false)
const libraryMenu = ref(false), settingsOpen = ref(false), transferDetail = ref('')
const processingRecordsOpen = ref(false), processingStatus = ref({ running: 0, unread: false })
const pairing=ref<PairingInfo|null>(null),preview=ref(''),currentTime=ref(Date.now())
const previewContext = ref<TransferPreviewContext | null>(null), previewAsset = ref<MediaAsset | null>(null)
const previewLoading = ref(false), previewError = ref(''), previewActionError = ref('')
const pageContent = ref<HTMLElement | null>(null)
let timer:ReturnType<typeof setInterval>|undefined
let refreshSequence=0, previewSequence=0
const api=window.momentnest!
const active=computed(()=>state.value?.sessions.filter(item=>item.libraryId===state.value?.currentLibraryId&&!['cancelled','failed'].includes(item.state)&&!hasSavedReceipt(item))??[])
const enabledLibraries=computed(()=>state.value?.libraries.filter(item=>item.enabled)??[])
const currentLibrary = computed(() => state.value?.libraries.find(item => item.id === state.value?.currentLibraryId) ?? null)
type SavedTransfer = ReceiverState['files'][number] & { reused?: boolean; receiptOnly?: boolean }
type TransferPreviewContext = { receipt: SavedTransfer; libraryId: string; libraryName: string; libraryPath: string }
const transferPreviewMedia = computed(() => previewContext.value ? {
  // 使用稳定回执身份，索引读取完成后保留用户已打开的信息面板。
  id: previewContext.value.receipt.id,
  filename: previewContext.value.receipt.filename,
  kind: previewAsset.value?.kind ?? (isVideoTransfer(previewContext.value.receipt.filename) ? 'video' as const : 'photo' as const),
  width: previewAsset.value?.width ?? 0, height: previewAsset.value?.height ?? 0,
  available: previewAsset.value?.available ?? true,
} : null)
const transferPreviewLocation = computed(() => {
  const context = previewContext.value
  if (!context) return ''
  const location = previewAsset.value?.locations.find(item => item.receiptId === context.receipt.id)
  return location?.path ?? `${context.libraryPath.replace(/[\\/]+$/, '')}/${context.receipt.relativePath}`
})
/** 只有当前目标库的完整回执才代表保存成功，完整字节进度不作为回执。 */
function hasSavedReceipt(session: ReceiverState['sessions'][number]): boolean {
  return session.state === 'complete' && Boolean(session.receipt?.id && session.receipt.libraryId === currentLibrary.value?.id && session.receipt.relativePath && Number.isFinite(Date.parse(session.receipt.savedAt)))
}
const localDay = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('sv-SE') : '日期未知'
const taskLabel = (session: ReceiverState['sessions'][number]) => !hasSavedReceipt(session) && (session.state === 'complete' || (session.state !== 'failed' && session.offset >= session.size)) ? '等待电脑确认' : label(session.state)
const currentFiles = computed(() => state.value?.files.filter(item => item.libraryId === currentLibrary.value?.id) ?? [])
/** 手机记录按真实批次收纳；没有批次标识的旧归档记录仅按日期展示。 */
const taskGroups = computed(() => {
  const groups = new Map<string, { files: NonNullable<ReceiverState>['files']; sessions: NonNullable<ReceiverState>['sessions'] }>()
  for (const file of currentFiles.value) {
    const key = file.batchId ? `batch:${file.batchId}` : `archive:${localDay(file.savedAt)}`
    const group = groups.get(key) ?? { files: [], sessions: [] }; group.files.push(file); groups.set(key, group)
  }
  for (const session of state.value?.sessions.filter(item=>item.libraryId===currentLibrary.value?.id&&item.state!=='cancelled') ?? []) {
    const key = session.batchId ? `batch:${session.batchId}` : `task:${session.id}`
    const group = groups.get(key) ?? { files: [], sessions: [] }; group.sessions.push(session); groups.set(key, group)
  }
  return [...groups].map(([id, group]) => {
    const results = new Map<string, SavedTransfer>(group.files.map(file => [file.id, { ...file }]))
    // 旧回执可能在新批次复用，也可能因快照截断不在 files 中；保留真实回执身份去重。
    for (const session of group.sessions.filter(hasSavedReceipt)) {
      const receipt = session.receipt!
      if (results.has(receipt.id)) continue
      const existing = currentFiles.value.find(file => file.id === receipt.id)
      results.set(receipt.id, existing
        ? { ...existing, filename: session.filename, reused: existing.batchId !== session.batchId }
        : { id: receipt.id, filename: session.filename, size: session.size, libraryId: receipt.libraryId, relativePath: receipt.relativePath, savedAt: receipt.savedAt, receiptOnly: true })
    }
    const startedAt = group.sessions[group.sessions.length-1]?.updatedAt ?? group.files[group.files.length-1]?.savedAt ?? ''
    const pendingSessions = group.sessions.filter(item => !['cancelled','failed'].includes(item.state) && !hasSavedReceipt(item))
    const pending = pendingSessions.length
    const failed = group.sessions.filter(item => item.state==='failed').length
    const savedResults = [...results.values()]
    const total = savedResults.length + pending + failed
    return { ...group, results: savedResults, pendingSessions, id, day: localDay(startedAt), startedAt, batch: id.startsWith('batch:'), pending, failed, total }
  }).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))
})
const receivingGroups = computed(() => taskGroups.value.filter(group=>group.pending>0))
const historyGroups = computed(() => taskGroups.value.filter(group=>!group.pending))
const selectedTransfer = computed(() => taskGroups.value.find(item => item.id === transferDetail.value))
const groupSummary = (group: typeof taskGroups.value[number]) => `已保存 ${group.results.length}${group.pending?` · 待处理 ${group.pending}`:''}${group.failed?` · 失败 ${group.failed}`:''}`
const remaining=computed(()=>Math.max(0,Math.ceil(((pairing.value?.expiresAt??0)-currentTime.value)/1000)))
const labels:Record<string,string>={pending:'待扫描',scanning:'扫描中',ready:'核对就绪',partial:'部分完成',unavailable:'目录不可用',interrupted:'扫描中断',receiving:'接收中',committing:'校验保存中',complete:'已保存',failed:'失败'}
const label=(value:string)=>labels[value]??value
const size=(bytes:number)=>bytes>1024**2?`${(bytes/1024**2).toFixed(1)} MB`:`${(bytes/1024).toFixed(0)} KB`
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{hour12:false})
const dateLabel = (source: DateSource) => ({ capture: '拍摄日期', creation: '文件创建日期', manual: '手动确认日期', unknown: '日期未知' })[source]

/** 三个模块共享原文件和保存记录，切换模块只改变当前视图。 */
function setModule(value: Module): void {
  settingsOpen.value = false
  module.value = value
  page.value = value === 'import' ? 'receive' : value === 'library' ? 'all' : 'timeline'
}

// 切换页面后从内容顶部开始，导航位置不随内容滚动。
watch(() => state.value?.currentLibraryId, () => { closeTransferPreview(); pairing.value = null; transferDetail.value = '' })
watch(page, () => { if (module.value === 'import' && page.value !== 'folder') pageContent.value?.scrollTo({ top: 0, left: 0 }) }, { flush: 'post' })
watch([() => state.value?.currentLibraryId, module, page, settingsOpen, transferDetail], () => { closePopupMenus(); closeTransferPreview(); processingRecordsOpen.value = false })

/** 首次读取成功前显示读取状态，失败时保留重试入口，避免误提示重新选目录。 */
async function refresh(force=false):Promise<void> {
  if(refreshing.value&&!force) return
  if(!api){stateReadError.value='无法读取照片库，请使用拾光匣桌面程序打开。';return}
  const sequence=++refreshSequence
  refreshing.value=true
  if(force)stateReadError.value=''
  try {
    const result=await api.getState()
    if(sequence===refreshSequence){state.value=result;stateReadError.value=''}
  } catch(error) {
    if(sequence===refreshSequence){if(state.value)notice.value=userError(error);else stateReadError.value=userError(error)}
  } finally {if(sequence===refreshSequence)refreshing.value=false}
}
/** 读取当前运行程序的实际版本，独立于照片库状态并允许失败后重试。 */
async function loadAppVersion(): Promise<void> {
  if (versionLoading.value) return
  versionError.value = ''
  if (!api) { versionError.value = '请使用拾光匣桌面程序查看版本。'; return }
  versionLoading.value = true
  try {
    const info = await api.getAppInfo()
    if (!info.version.trim()) throw new Error('无法读取当前应用版本。')
    appVersion.value = info.version
  } catch (error) { versionError.value = userError(error) }
  finally { versionLoading.value = false }
}
async function run(action:()=>Promise<unknown>):Promise<void> {
  if(busy.value) return
  busy.value=true;notice.value=''
  try {await action();await refresh(true)} catch(error) {notice.value=userError(error)} finally {busy.value=false}
}
/** 通过桌面桥接打开系统目录选择器，仅保留本次会话选择。 */
// 目录现在由接收服务持久化，历史扫描仍需用户主动开始。
async function chooseDirectory(multiple:boolean):Promise<void> {
  if(!api){notice.value='请在桌面程序中管理接收目录。';return}
  closePopupMenus()
  await run(()=>api.addDirectories(multiple?'root':'library'))
}
/** 当前照片库独立于功能模块，并由接收端持久保存。 */
async function switchLibrary(id: string): Promise<void> {
  if (id === currentLibrary.value?.id) { libraryMenu.value = false; return }
  pairing.value = null; closeTransferPreview(); transferDetail.value = ''
  await run(() => api.setCurrentLibrary(id))
  libraryMenu.value = false
}
async function makePairing():Promise<void> {
  await run(async()=>{pairing.value=await api.createPairing();currentTime.value=Date.now()})
}
/** 建立当前目录索引后直接打开图库，持续处理进度在图库中显示。 */
async function useLibraryFiles(): Promise<void> {
  if (!currentLibrary.value || !state.value?.currentLibraryAvailable) return
  await run(() => api.scanMedia(currentLibrary.value!.id))
  if (!notice.value) setModule('library')
}
/** 按保存回执定位内容，文件名相同或归档改名时也不会预览另一份文件。 */
async function receiptAsset(receiptId: string, contextId: string, sequence: number): Promise<MediaAsset | undefined> {
  let queryPage = 1
  while (true) {
    const result = await api.queryMedia({ page: queryPage, limit: 100, libraryId: contextId })
    if (!isCurrentTransferPreview(sequence, contextId)) return undefined
    const asset = result.items.find(item => item.locations.some(location => location.receiptId === receiptId))
    if (asset) return asset
    if (!result.items.length || queryPage * result.limit >= result.total) return undefined
    queryPage++
  }
}
async function showPhoto(id:string,name:string):Promise<void> {
  if (busy.value||!currentLibrary.value) return
  const receipt = selectedTransfer.value?.results.find(item => item.id === id) ?? currentFiles.value.find(item => item.id === id)
  if (!receipt) { notice.value = '这条保存记录已更新，请重新打开批次详情。'; return }
  closePopupMenus()
  closeTransferPreview()
  const context = { receipt: { ...receipt, filename: name }, libraryId: currentLibrary.value.id, libraryName: currentLibrary.value.name, libraryPath: currentLibrary.value.path }
  previewContext.value = context
  await loadTransferPreview(context, true)
}
function isVideoTransfer(filename: string): boolean { return /\.(mp4|mov|m4v|webm|avi|mkv|3gp|mts|m2ts)$/i.test(filename) }
/** 回执与照片库固定在打开时，重试读取不会改目标或重复发起扫描。 */
async function loadTransferPreview(context: TransferPreviewContext, allowScan = false): Promise<void> {
  const sequence = ++previewSequence
  previewLoading.value = true; previewError.value = ''; preview.value = ''
  try {
    const asset = await receiptAsset(context.receipt.id, context.libraryId, sequence)
    if (!isCurrentTransferPreview(sequence, context.libraryId)) return
    previewAsset.value = asset ?? null
    if (!asset && isVideoTransfer(context.receipt.filename)) {
      if (allowScan) await api.scanMedia(context.libraryId)
      if (!isCurrentTransferPreview(sequence, context.libraryId)) return
      previewError.value = allowScan
        ? '这条视频保存记录尚未建立媒体索引，已开始扫描。请在照片与视频中等待核对完成后再预览，也可打开原文件位置。'
        : '这条视频保存记录尚未建立媒体索引，请等待当前扫描完成后重新读取，或打开原文件位置。'
      return
    }
    const url = asset ? await api.mediaUrl(asset.id, false, context.libraryId) : await api.previewFile(context.receipt.id)
    if (isCurrentTransferPreview(sequence, context.libraryId)) preview.value = url
  } catch (error) {
    if (isCurrentTransferPreview(sequence, context.libraryId)) previewError.value = userError(error)
  } finally {
    if (isCurrentTransferPreview(sequence, context.libraryId)) previewLoading.value = false
  }
}
function isCurrentTransferPreview(sequence: number, libraryId: string): boolean {
  return sequence === previewSequence && previewContext.value?.libraryId === libraryId && currentLibrary.value?.id === libraryId
}
function retryTransferPreview(): void {
  if (previewContext.value && !previewLoading.value) void loadTransferPreview(previewContext.value)
}
/** 位置操作使用原保存回执，不以相同文件名或共享内容位置替代。 */
async function revealTransferPreview(): Promise<void> {
  const context = previewContext.value, sequence = previewSequence
  if (!context || busy.value) return
  previewActionError.value = ''
  try { await api.revealFile(context.receipt.id) }
  catch (error) { if (isCurrentTransferPreview(sequence, context.libraryId)) previewActionError.value = userError(error) }
}
/** 关闭只收起预览并拒绝迟到的读取结果，已保存的媒体保持不变。 */
function closeTransferPreview(): void {
  previewSequence++
  preview.value = ''; previewContext.value = null; previewAsset.value = null
  previewLoading.value = false; previewError.value = ''; previewActionError.value = ''
}
onMounted(()=>{void loadAppVersion();void refresh();timer=setInterval(()=>{currentTime.value=Date.now();void refresh()},2000)})
onUnmounted(()=>{clearInterval(timer);previewSequence++})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="header-brand"><span class="brand-symbol"><img class="brand-logo" :src="momentnestLogo" alt="拾光匣" width="28" height="28" /></span><strong>拾光匣</strong></div>
      <nav class="module-navigation" aria-label="功能模块">
        <button aria-label="照片与视频" title="照片与视频" :class="{selected:module==='library'&&!settingsOpen}" @click="setModule('library')"><UiIcon :name="module==='library'&&!settingsOpen?'photo-filled':'photo'" /><span>照片与视频</span></button>
        <button aria-label="宝宝相册" title="宝宝相册" :class="{selected:module==='baby'&&!settingsOpen}" @click="setModule('baby')"><UiIcon name="baby" /><span>宝宝相册</span></button>
        <button aria-label="导入与归档" title="导入与归档" :class="{selected:module==='import'&&!settingsOpen}" @click="setModule('import')"><UiIcon name="transfer" /><span>导入与归档</span></button>
      </nav>
      <button aria-label="设置" title="设置" class="settings-link" :class="{selected:settingsOpen}" @click="settingsOpen=!settingsOpen"><UiIcon name="settings" /><span>设置</span></button>
      <small class="app-version" :title="appVersion?`当前版本：${appVersion}`:versionError">{{appVersion?`v${appVersion}`:versionError?'版本未知':'读取版本…'}}</small>
    </aside>
    <main>
      <header class="topbar">
        <UiPopover v-model:show="libraryMenu" class="library-switcher" label="切换照片库" content-class="library-menu" placement="bottom-start">
          <template #trigger="{ open }">
            <div class="library-switcher-trigger">
              <button class="library-toggle" aria-label="当前照片库" :title="currentLibrary?.path" :aria-expanded="open" :disabled="busy||!state"><span>当前照片库：</span><strong>{{state?(currentLibrary?.name??'选择照片库'):(stateReadError?'读取失败':'正在读取…')}}</strong><UiIcon name="chevron" :size="15" /></button>
              <button class="library-change text-button" aria-label="切换照片库" :aria-expanded="open" :disabled="busy||!state"><UiIcon name="transfer" :size="16" />切换</button>
            </div>
          </template>
          <button v-for="library in enabledLibraries" :key="library.id" :class="{selected:library.id===currentLibrary?.id}" :disabled="busy" @click="switchLibrary(library.id)"><strong>{{library.name}}</strong><small>{{library.path}}</small><UiIcon v-if="library.id===currentLibrary?.id" name="check" :size="17" /></button><button class="add-library" :disabled="busy||!state" @click="chooseDirectory(false)">＋ 选择照片库文件夹</button>
        </UiPopover>
        <button v-if="!settingsOpen&&state?.currentLibraryId&&(module!=='import'||page==='folder')" class="text-button processing-records-entry" aria-label="处理记录" :aria-expanded="processingRecordsOpen" @click="processingRecordsOpen=true;libraryMenu=false"><UiIcon name="clock" :size="16" /><span>处理记录</span><b v-if="processingStatus.running" class="processing-records-badge" aria-hidden="true">{{processingStatus.running}}</b><i v-else-if="processingStatus.unread" class="processing-records-unread" aria-hidden="true"></i></button>
        <span class="dev-tag"><i class="status-dot" :class="{paused:!state?.accepting}"></i>{{!state?'正在启动':state.accepting?'接收已开启':'接收已暂停'}}</span>
      </header>
      <div ref="pageContent" class="page-content">
        <div v-if="notice" class="notice" role="alert">{{notice}}<button aria-label="关闭提示" @click="notice=''">×</button></div>
        <div v-if="state?.currentLibraryId&&!state.currentLibraryAvailable" class="notice" role="alert">当前照片库暂不可用：{{currentLibrary?.path}}。请连接硬盘，或从顶部切换照片库。</div>
        <section v-if="!state" class="receiver-startup family-empty">
          <template v-if="stateReadError"><UiIcon name="folder" :size="38" /><h2>读取照片库失败</h2><p role="alert">{{stateReadError}}</p><button class="primary-button" :disabled="refreshing||!api" @click="refresh(true)">重新读取照片库</button></template>
          <UiLoading v-else label="正在读取照片库…" :size="24" />
        </section>
        <template v-else-if="settingsOpen">
          <div class="compact-page-heading"><h1>设置</h1></div>
          <section class="directory-panel" aria-label="关于拾光匣">
            <h2>关于拾光匣</h2>
            <p>当前版本 <strong class="about-version">{{appVersion?`v${appVersion}`:versionLoading?'正在读取…':'暂时无法读取'}}</strong></p>
            <p v-if="versionError" role="alert">{{versionError}} <button class="text-button" :disabled="versionLoading||!api" @click="loadAppVersion">重新读取版本</button></p>
          </section>
          <section class="directory-panel"><div class="section-heading"><h2>接收服务</h2><button class="secondary-button" :disabled="busy||!state" @click="run(()=>api.setAccepting(!state!.accepting))">{{state?.accepting?'暂停接收':'继续接收'}}</button></div><p>{{state?.name??'正在启动'}} · {{state?.addresses.join(' / ')}}</p><button class="text-button" @click="settingsOpen=false;module='import';page='directories'">管理照片库与历史目录 →</button><details class="compact-help"><summary>原文件保留规则</summary><p>照片、视频、归档与水印副本均保留；移出相册、取消收藏及移除参考只修改记录。</p></details></section>
        </template>
        <div v-else-if="!state?.currentLibraryId" class="library-empty family-empty"><UiIcon name="folder" :size="38" /><h2>选择照片库文件夹</h2><p>直接查看这个文件夹中的照片与视频，也可以从其他目录或手机导入。</p><button class="primary-button" :disabled="busy" @click="chooseDirectory(false)">选择照片库文件夹</button><button v-if="enabledLibraries.length" class="text-button" @click="libraryMenu=true">使用已有照片库</button></div>
        <FamilyWorkspace v-else-if="module!=='import'||page==='folder'" :module="module" :page="page" :receiver="state" :records-open="processingRecordsOpen" @close-records="processingRecordsOpen=false" @processing-status="processingStatus=$event" @refresh-receiver="refresh" @navigate="setModule" @change-page="page=$event as Page" />
        <template v-else-if="page==='receive'">
          <div class="compact-page-heading"><h1>导入与归档</h1><button class="text-button" @click="page='history'">任务与记录 →</button></div>
          <div class="import-actions">
            <button class="import-source-action" :disabled="!state?.currentLibraryAvailable" @click="page='folder'"><UiIcon name="folder" :size="26" /><span><strong>从电脑文件夹导入</strong><small>复制到当前照片库，按日期归档</small></span><span>›</span></button>
            <button class="import-source-action" :disabled="busy||!state?.currentLibraryAvailable" @click="useLibraryFiles"><UiIcon name="photo" :size="26" /><span><strong>查看当前库已有照片</strong><small>建立索引，原文件保持原位置</small></span><span>›</span></button>
          </div>
          <section class="directory-panel mobile-receive-panel"><div class="section-heading"><h2>手机上传</h2><button class="secondary-button" :disabled="busy||!currentLibrary||!state?.currentLibraryAvailable" @click="makePairing">{{pairing?'重新生成配对信息':'连接新手机'}}</button></div><p class="receive-target">保存到：<strong>{{currentLibrary?.name}}</strong><span>{{currentLibrary?.path}}</span></p>
            <div v-if="pairing" class="pairing-block"><img v-if="remaining>0" :src="pairing.qr" alt="手机配对二维码" class="qr-image"><p>{{remaining>0?`有效期剩余 ${remaining} 秒 · 使用后失效`:'二维码已过期，请重新生成'}}</p><details><summary>无法扫码？显示手动配对信息</summary><textarea aria-label="手动配对信息" readonly :value="remaining>0?pairing.payload:'配对信息已过期'"></textarea></details></div>
            <p v-if="state&&!state.addresses.length" class="error-text">未检测到可用局域网，请连接 Wi-Fi 或有线网络。</p>
            <ul v-if="state?.devices.some(d=>!d.revoked)" class="directory-list"><li v-for="device in state.devices.filter(d=>!d.revoked)" :key="device.id"><UiIcon name="photo" /><span>{{device.name}}<small class="block">已配对</small></span><UiPopover class="device-tools" label="设备操作" content-class="device-menu" placement="left-start"><template #trigger="{ open }"><button class="menu-trigger" aria-label="设备操作" :aria-expanded="open" :disabled="busy"><UiIcon name="more" /></button></template><button class="text-button" :disabled="busy" @click="run(()=>api.revokeDevice(device.id))">撤销授权</button></UiPopover></li></ul>
            <details class="compact-help"><summary>连接与归档说明</summary><p>手机扫描二维码或粘贴配对信息，同一局域网传输。新任务确认当前照片库，已有任务保持原目标和日期；完整校验并保存后才计入已保存。</p><code v-for="address in state?.addresses" :key="address">{{address}}</code></details>
          </section>
          <section v-if="receivingGroups.length" class="transfer-summary"><h2>正在接收</h2><button v-for="group in receivingGroups" :key="group.id" class="transfer-row" @click="transferDetail=group.id;page='history'"><UiIcon name="clock" /><span><strong>{{group.batch?'当前批次':'接收任务'}} · {{group.total}} 项</strong><small :class="{'error-text':group.failed>0}">{{groupSummary(group)}}</small><progress style="accent-color:#899aa1" :value="group.sessions.reduce((sum,item)=>sum+item.offset,0)" :max="group.sessions.reduce((sum,item)=>sum+item.size,0)||1"></progress></span><span>›</span></button></section>
          <section class="transfer-summary"><div class="section-heading"><h2>历史记录</h2><button class="text-button" @click="page='history'">查看全部 →</button></div><button v-for="group in historyGroups.slice(0,3)" :key="group.id" class="transfer-row" @click="transferDetail=group.id;page='history'"><UiIcon :name="group.failed?'clock':'check'" :class="{'error-text':group.failed>0}" /><span><strong>{{group.day}}{{group.batch?` ${time(group.startedAt).split(' ').pop()}`:' · 归档记录'}} · {{group.total}} 项</strong><small :class="{'error-text':group.failed>0}">{{groupSummary(group)}}</small></span><span>›</span></button><p v-if="!historyGroups.length">当前照片库暂无接收记录</p></section>
        </template>
        <template v-else-if="page==='directories'">
          <div class="page-intro"><h1>保存位置</h1><details class="compact-help"><summary>目录说明</summary><p>历史目录仅建立索引。停用目录保留照片与历史记录。</p></details></div>
          <section class="directory-panel"><div class="section-heading"><h2>接收目录</h2><button class="secondary-button" :disabled="busy" @click="chooseDirectory(false)">＋ 添加接收目录</button></div><div v-if="!state?.libraries.length" class="inline-empty">尚未添加接收目录</div><ul class="directory-list"><li v-for="library in state?.libraries" :key="library.id"><span>▤</span><span>{{library.path}}<small class="block">{{library.enabled?'可接收':'已停用'}}</small></span><button class="text-button" :disabled="busy" @click="run(()=>api.toggleDirectory('library',library.id,!library.enabled))">{{library.enabled?'停用':'启用'}}</button></li></ul><details class="compact-help"><summary>归档规则</summary><p>顶部当前库是新任务目标；手机确认日期规则，已有任务保持原库。</p><code>所选目录 / YYYY-MM-DD / 原图__内容指纹.jpg</code></details></section>
          <section class="directory-panel"><div class="section-heading"><h2>历史目录</h2><button class="secondary-button" :disabled="busy" @click="chooseDirectory(true)">＋ 添加历史目录</button></div><ul class="directory-list"><li v-for="root in state?.roots" :key="root.id"><span>▤</span><span>{{root.path}}<small class="block">{{root.enabled?label(root.state):'已停用'}} · {{root.count}} 项{{root.scannedAt?` · ${time(root.scannedAt)}`:''}}</small><small v-if="root.error" class="block error-text">{{root.error}}</small></span><button class="text-button" :disabled="busy||state?.scanning" @click="run(()=>api.toggleDirectory('root',root.id,!root.enabled))">{{root.enabled?'停用':'启用'}}</button></li></ul><div v-if="!state?.roots.length" class="inline-empty">尚未添加历史目录</div><button class="primary-button scan-button" :disabled="busy||state?.scanning||!state?.roots.some(r=>r.enabled)" @click="run(()=>api.scan())">{{state?.scanning?'正在扫描…':'扫描 / 重新核对'}}</button><details class="compact-help"><summary>扫描说明</summary><p>包含普通子目录；不跟随目录联接。上传前会再次核实匹配文件。</p></details></section>
        </template>
        <template v-else-if="page==='history'">
          <div class="compact-page-heading"><button class="text-button" @click="transferDetail?transferDetail='':page='receive'">← 返回</button><h1>{{transferDetail?(selectedTransfer?.batch?'批次详情':selectedTransfer?.sessions.length?'任务详情':'归档记录'):'任务与记录'}}</h1></div>
          <template v-if="selectedTransfer"><p>{{selectedTransfer.day}} · {{selectedTransfer.total}} 项 · {{groupSummary(selectedTransfer)}}</p><ul class="directory-list"><li v-for="file in selectedTransfer.results" :key="file.id"><button class="photo-symbol" aria-label="预览照片或视频" :disabled="busy" @click="showPhoto(file.id,file.filename)"><UiIcon name="photo" /></button><span><strong>{{file.filename}}</strong><small class="block">{{file.relativePath}}</small><small class="block">{{file.reused?'已保存 · 已有原文件':file.receiptOnly?'已保存 · 保存回执':'已保存'}} · {{size(file.size)}} · {{time(file.savedAt)}}</small></span><button class="text-button" @click="run(()=>api.revealFile(file.id))">打开位置</button></li></ul><details v-for="item in [...selectedTransfer.pendingSessions,...selectedTransfer.sessions.filter(session=>session.state==='failed')]" :key="item.id" class="transfer-task"><summary><UiIcon name="clock" /><span><strong>{{item.filename}}</strong><small>{{taskLabel(item)}}</small></span><span>›</span></summary><p>{{size(item.offset)}} / {{size(item.size)}} · {{item.archiveDate}}</p><progress style="accent-color:#899aa1" :value="item.offset" :max="item.size"></progress><p v-if="item.error" class="error-text">{{item.error}}</p></details></template>
          <template v-else><section v-if="active.length" class="transfer-summary"><h2>未完成任务</h2><details v-for="item in active" :key="item.id" class="transfer-task"><summary><UiIcon name="clock" /><span><strong>{{item.filename}}</strong><small>{{taskLabel(item)}}</small></span><span>›</span></summary><p>{{size(item.offset)}} / {{size(item.size)}} · {{item.archiveDate}}</p><progress style="accent-color:#899aa1" :value="item.offset" :max="item.size"></progress><p v-if="item.error" class="error-text">{{item.error}}</p></details></section><section class="transfer-summary"><h2>已保存记录</h2><button v-for="group in historyGroups" :key="group.id" class="transfer-row" @click="transferDetail=group.id"><UiIcon :name="group.failed?'clock':'check'" :class="{'error-text':group.failed>0}" /><span><strong>{{group.day}}{{group.batch?` ${time(group.startedAt).split(' ').pop()}`:' · 归档记录'}} · {{group.total}} 项</strong><small :class="{'error-text':group.failed>0}">{{groupSummary(group)}}</small></span><span>›</span></button><p v-if="!historyGroups.length">当前照片库暂无接收记录</p></section></template>
        </template>
      </div>
    </main>
    <MediaPreview v-if="previewContext&&transferPreviewMedia" :key="previewContext.libraryId+previewContext.receipt.id" :asset="transferPreviewMedia" :src="preview" :loading="previewLoading" :error="previewError" :can-previous="false" :can-next="false" close-label="返回记录" :caption="`${size(previewContext.receipt.size)} · 已保存 ${time(previewContext.receipt.savedAt)}`" @close="closeTransferPreview" @retry="retryTransferPreview">
      <template #information>
        <dl class="detail-metadata">
          <div><dt>文件名</dt><dd>{{previewContext.receipt.filename}}</dd></div>
          <div><dt>文件信息</dt><dd>{{transferPreviewMedia.kind==='video'?'视频':'照片'}} · {{size(previewContext.receipt.size)}}<template v-if="previewAsset?.width&&previewAsset.height"> · {{previewAsset.width}} × {{previewAsset.height}}</template></dd></div>
          <template v-if="previewAsset"><div><dt>拍摄与归档日期</dt><dd>{{previewAsset.date??'日期未知'}} · {{dateLabel(previewAsset.dateSource)}}{{previewAsset.dateConfirmed?' · 已确认':''}}</dd></div><div><dt>来源日期记录</dt><dd>拍摄日期：{{previewAsset.captureDate??'缺失'}}<br>来源创建日期：{{previewAsset.creationDate??'缺失'}}</dd></div></template>
          <div v-else><dt>媒体索引</dt><dd>尚未建立媒体索引，拍摄日期和尺寸暂不可用。保存回执时间不作为拍摄日期。</dd></div>
          <div><dt>保存回执时间</dt><dd>{{time(previewContext.receipt.savedAt)}}</dd></div>
          <div><dt>保存照片库</dt><dd>{{previewContext.libraryName}}<br>{{previewContext.libraryPath}}</dd></div>
          <div><dt>原文件保存位置</dt><dd>{{transferPreviewLocation}}<small>以这条保存回执的实际位置为准</small></dd></div>
        </dl>
        <button class="text-button" :disabled="busy" @click="revealTransferPreview">打开原文件位置</button>
        <p v-if="previewActionError" class="error-text" role="alert">{{previewActionError}}</p>
      </template>
    </MediaPreview>
  </div>
</template>

<style scoped>
.brand-logo{display:block;width:100%;height:100%;object-fit:contain}
.app-version{display:block;flex:none;margin:4px 0 0;color:#65706a;font-size:10px;line-height:1.6;text-align:center;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.about-version{margin-left:8px;font-variant-numeric:tabular-nums}
.library-switcher-trigger{display:flex;align-items:center;gap:12px;min-width:0}
.processing-records-entry{display:flex;align-items:center;gap:6px;flex:none;min-height:32px;padding:5px 9px;border:1px solid #e5eae6;border-radius:7px;background:#fff;color:#52675b;font-size:11px;white-space:nowrap}.processing-records-entry:hover{background:#edf2f0}.processing-records-badge{display:grid;place-items:center;min-width:16px;height:16px;padding:0 3px;border-radius:8px;background:#edf2f0;color:#3b755c;font-size:10px;font-weight:500}.processing-records-unread{width:6px;height:6px;flex:none;border-radius:50%;background:#ad7949}@media(max-width:450px){.processing-records-entry{gap:5px;padding:5px 7px}.processing-records-entry>.ui-icon{display:none}}
</style>
