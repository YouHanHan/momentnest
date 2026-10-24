<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { BabyProfile, MediaAsset } from '../../../shared/family'
import { plainData } from '../family-ui'
import { closePopupMenus } from '../popup-dismiss'
import { userError } from '../ui-error'
import PhotoAvatar from './PhotoAvatar.vue'
import UiDatePicker from './UiDatePicker.vue'
import UiDialog from './UiDialog.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ profile: BabyProfile; creating: boolean; libraryId?: string; libraryAvailable: boolean; busy: boolean; error: string; chooseAvatar?: boolean; suspended?: boolean }>()
const emit = defineEmits<{ close: []; save: [BabyProfile, boolean]; 'view-reference': [MediaAsset] }>()
const draft = reactive({ ...props.profile, referenceFaces: props.profile.referenceFaces.map(face => ({ ...face })) })
const choosingAvatar = ref(Boolean(props.chooseAvatar)), search = ref('')
const photos = ref<MediaAsset[]>([]), total = ref(0), loading = ref(false), photoError = ref('')
const urls = reactive<Record<string, string>>({}), unavailable = reactive(new Set<string>())
const referencePhotos = ref<MediaAsset[]>([]), referencesLoading = ref(false), referencesError = ref('')
const referenceUrls = reactive<Record<string, string>>({}), failedReferences = reactive(new Set<string>())
const referenceAssets = computed(() => new Map(referencePhotos.value.map(photo => [photo.id, photo])))
const today = new Date().toLocaleDateString('sv-SE')
const avatarId = computed(() => draft.avatarAssetId ?? draft.referenceFaces[0]?.assetId)
let page = 0, contextSequence = 0, requestSequence = 0, disposed = false
let referenceSequence = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined

/** 按页读取现有照片索引，选头像不会创建人脸参考或启动扫描。 */
async function loadPhotos(append = false): Promise<void> {
  if (disposed || !props.libraryId || !props.libraryAvailable || !window.momentnest || append && loading.value) return
  if (!append) {
    clearTimeout(searchTimer)
    contextSequence++; photos.value = []; total.value = 0; page = 0; unavailable.clear()
    for (const id of Object.keys(urls)) delete urls[id]
  }
  const context = contextSequence, request = ++requestSequence, libraryId = props.libraryId, nextPage = append ? page + 1 : 1
  loading.value = true; photoError.value = ''
  try {
    const result = await window.momentnest.queryMedia({ libraryId, kind: 'photo', page: nextPage, limit: 24, order: 'desc', ...(search.value.trim() ? { search: search.value.trim() } : {}) })
    if (disposed || context !== contextSequence || request !== requestSequence || libraryId !== props.libraryId) return
    const existing = new Set(photos.value.map(photo => photo.id))
    photos.value = append ? [...photos.value, ...result.items.filter(photo => !existing.has(photo.id))] : result.items
    total.value = result.total; page = nextPage
    await Promise.all(result.items.filter(photo => photo.kind === 'photo' && photo.available).map(async photo => {
      try {
        const url = await window.momentnest!.mediaUrl(photo.id, true, libraryId)
        if (!disposed && context === contextSequence && libraryId === props.libraryId) urls[photo.id] = url
      } catch { if (!disposed && context === contextSequence) unavailable.add(photo.id) }
    }))
  } catch (error) { if (!disposed && context === contextSequence && request === requestSequence) photoError.value = userError(error) }
  finally { if (!disposed && context === contextSequence && request === requestSequence) loading.value = false }
}
/** 选择先进入草稿，只有保存档案才会写入宝宝记录。 */
function selectAvatar(photo: MediaAsset): void {
  if (props.busy || !props.libraryAvailable || photo.kind !== 'photo' || !photo.available || !urls[photo.id] || unavailable.has(photo.id)) return
  draft.avatarAssetId = photo.id
}
function useDefaultAvatar(): void { if (!props.busy) delete draft.avatarAssetId }
function save(event: SubmitEvent): void { if (!props.busy) emit('save', plainData(draft), (event.submitter as HTMLButtonElement | null)?.value === 'add-references') }
/** 参考从全部仍授权目录按标识读取，头像选图和相册筛选不影响此列表。 */
async function loadReferences(): Promise<void> {
  if (disposed || props.creating || !draft.referenceFaces.length || !window.momentnest) return
  const sequence = ++referenceSequence
  referencesLoading.value = true; referencesError.value = ''; failedReferences.clear()
  try {
    const result = await window.momentnest.queryMedia({ referenceBabyId: props.profile.id, scope: 'all', page: 1, limit: 20 })
    if (disposed || sequence !== referenceSequence) return
    referencePhotos.value = result.items
    await Promise.all(result.items.filter(photo => photo.available).map(async photo => {
      try {
        const url = await window.momentnest!.mediaUrl(photo.id, true)
        if (!disposed && sequence === referenceSequence) referenceUrls[photo.id] = url
      } catch { if (!disposed && sequence === referenceSequence) failedReferences.add(photo.id) }
    }))
  } catch (error) { if (!disposed && sequence === referenceSequence) referencesError.value = userError(error) }
  finally { if (!disposed && sequence === referenceSequence) referencesLoading.value = false }
}
/** 移除只修改档案草稿，取消编辑会保留原参考和媒体文件。 */
function removeReference(reference: BabyProfile['referenceFaces'][number]): void {
  if (!props.busy) draft.referenceFaces = draft.referenceFaces.filter(face => face.assetId !== reference.assetId || face.faceId !== reference.faceId)
}
function viewReference(assetId: string): void {
  const asset = referenceAssets.value.get(assetId)
  if (asset?.available && !props.busy) emit('view-reference', asset)
}
/** 只有点击原生遮罩才关闭，弹窗自身的边框和空白保留草稿。 */
function dismissBackdrop(): void { emit('close') }
watch(choosingAvatar, open => { if (open && !photos.value.length && !loading.value) void loadPhotos() }, { immediate: true })
watch(search, () => {
  clearTimeout(searchTimer); contextSequence++; requestSequence++; loading.value = false
  searchTimer = setTimeout(() => { void loadPhotos() }, 250)
})
onMounted(() => { closePopupMenus(); void loadReferences() })
onUnmounted(() => { disposed = true; contextSequence++; requestSequence++; referenceSequence++; clearTimeout(searchTimer) })
</script>

<template>
  <UiDialog label="宝宝档案" content-class="family-dialog baby-profile-dialog" :suspended="suspended" @close="dismissBackdrop">
    <header class="baby-profile-title"><h2>{{creating?'建立宝宝档案':'编辑宝宝档案'}}</h2><button type="button" class="profile-close" aria-label="关闭宝宝档案" @click="emit('close')"><UiIcon name="close" :size="18" /></button></header>
    <form id="baby-profile-form" @submit.prevent="save">
      <div class="baby-profile-body">
        <section class="profile-avatar-section" aria-label="宝宝头像设置">
          <PhotoAvatar :asset-id="avatarId" :library-id="libraryId" :available="libraryAvailable" :size="64" />
          <div class="profile-avatar-controls"><strong>宝宝头像</strong><div><button type="button" class="secondary-button" :disabled="busy||!libraryId||!libraryAvailable" :aria-expanded="choosingAvatar" @click="choosingAvatar=!choosingAvatar">{{choosingAvatar?'收起照片':'选择照片'}}</button><button v-if="draft.avatarAssetId" type="button" class="text-button" :disabled="busy" @click="useDefaultAvatar">使用默认头像</button></div><small>{{draft.avatarAssetId?'已选择照片，保存后生效':'可从当前照片库选择'}}</small></div>
        </section>
        <section v-if="choosingAvatar" class="profile-avatar-picker" aria-label="选择宝宝头像照片">
          <label class="profile-photo-search"><UiIcon name="search" :size="16" /><input v-model="search" type="search" aria-label="搜索头像照片" placeholder="搜索照片文件名…" :disabled="busy||!libraryAvailable" @keydown.enter.prevent="loadPhotos()"></label>
          <p v-if="!libraryAvailable" class="section-tip" role="status">当前照片库暂不可用，请连接原目录后选择头像。</p>
          <div v-if="photos.length" class="profile-avatar-grid" :aria-busy="loading">
            <button v-for="photo in photos" :key="photo.id" type="button" class="profile-photo-option" :class="{selected:draft.avatarAssetId===photo.id}" :aria-label="`使用 ${photo.filename} 作为头像`" :aria-pressed="draft.avatarAssetId===photo.id" :disabled="busy||!libraryAvailable||!photo.available||!urls[photo.id]||unavailable.has(photo.id)" @click="selectAvatar(photo)">
              <span class="profile-photo-image"><img v-if="urls[photo.id]&&!unavailable.has(photo.id)" :src="urls[photo.id]" alt="" @error="unavailable.add(photo.id)"><UiIcon v-else name="photo" :size="22" /><span v-if="draft.avatarAssetId===photo.id" class="profile-photo-check"><UiIcon name="check" :size="14" /></span></span><span class="profile-photo-name" :title="photo.filename">{{photo.filename}}</span><small v-if="!photo.available||unavailable.has(photo.id)">暂不可用</small>
            </button>
          </div>
          <p v-if="photoError" class="error-text" role="alert">{{photoError}} <button type="button" class="text-button" :disabled="loading||busy||!libraryAvailable" @click="loadPhotos(page>0)">重试加载</button></p>
          <div class="profile-photo-loading" role="status"><span v-if="loading">正在加载照片…</span><span v-else-if="!photos.length&&!photoError">{{libraryAvailable?'当前条件下没有照片':'当前照片库暂不可用'}}</span><button v-else-if="photos.length<total" type="button" class="text-button" :disabled="busy||!libraryAvailable" @click="loadPhotos(true)">加载更多照片</button></div>
        </section>
        <label class="field"><span>宝宝昵称</span><input v-model="draft.name" maxlength="32" required :disabled="busy"></label>
        <label class="field"><span>出生日期</span><UiDatePicker v-model="draft.birthday" label="出生日期" min="1900-01-01" :max="today" required :disabled="busy" /></label>
        <label class="check-field"><input v-model="draft.autoMatch" type="checkbox" :disabled="busy">自动匹配新照片</label>
        <section class="profile-reference-section" aria-label="宝宝人脸参考">
          <div class="profile-reference-heading"><div><strong>人脸参考</strong><small>已设置 {{draft.referenceFaces.length}} / 20 个</small></div><button type="submit" value="add-references" class="secondary-button" :disabled="busy||!libraryId||!libraryAvailable||draft.referenceFaces.length>=20">保存并添加参考</button></div>
          <p class="profile-reference-note">选择清晰、不同角度和成长阶段的宝宝人脸，用于自动匹配。宝宝头像单独设置。</p>
          <p v-if="referencesLoading" class="profile-reference-note" role="status">正在读取参考照片…</p>
          <p v-if="referencesError" class="error-text" role="alert">{{referencesError}} <button type="button" class="text-button" :disabled="busy||referencesLoading" @click="loadReferences">重新读取参考</button></p>
          <div v-if="draft.referenceFaces.length" class="profile-reference-list">
            <div v-for="(reference,index) in draft.referenceFaces" :key="`${reference.assetId}-${reference.faceId}`" class="profile-reference-item">
              <button type="button" class="profile-reference-preview" :aria-label="`查看参考照片 ${referenceAssets.get(reference.assetId)?.filename??`参考 ${index+1}`}`" :disabled="busy||!referenceAssets.get(reference.assetId)?.available" @click="viewReference(reference.assetId)"><img v-if="referenceUrls[reference.assetId]&&!failedReferences.has(reference.assetId)" :src="referenceUrls[reference.assetId]" alt="" @error="failedReferences.add(reference.assetId)"><UiIcon v-else name="photo" :size="22" /></button>
              <div class="profile-reference-meta"><strong :title="referenceAssets.get(reference.assetId)?.filename">{{referenceAssets.get(reference.assetId)?.filename??`参考 ${index+1}`}}</strong><small v-if="referencesLoading">正在读取…</small><small v-else-if="referencesError">参考读取失败，可重试</small><small v-else-if="!referenceAssets.get(reference.assetId)?.available">原文件暂不可用，记录保留</small><small v-else-if="!referenceAssets.get(reference.assetId)?.faces.some(face=>face.id===reference.faceId)">人脸参考已失效，请重新选脸</small><small v-else>{{failedReferences.has(reference.assetId)?'缩略图不可用，仍可查看原图':'点击照片查看原图'}}</small></div>
              <button type="button" class="text-button" :aria-label="`移除参考 ${referenceAssets.get(reference.assetId)?.filename??`参考 ${index+1}`}`" :disabled="busy" @click="removeReference(reference)">移除</button>
            </div>
          </div>
          <p v-else class="profile-reference-note">还没有人脸参考，添加后才能按宝宝人脸匹配照片。</p>
          <p class="profile-reference-note">移除参考在保存档案后生效，只解除参考关联，原照片和手工相册归属保留。</p>
        </section>
        <p v-if="error" class="error-text" role="alert">{{error}}</p>
        <details class="compact-help"><summary>自动匹配与同步说明</summary><p>需先选定本机的宝宝人脸参考。高匹配度照片关联相册，存疑结果保留为候选；相册记录不代表备份成功。</p><p>宝宝档案、相册归属与确认日期可通过局域网同步，人脸模型在各设备本地运行，特征与参考在手机和电脑分别建立。</p></details>
      </div>
      <footer class="baby-profile-footer"><button type="button" class="secondary-button" @click="emit('close')">取消</button><button class="primary-button" type="submit" :disabled="busy">{{busy?'正在保存…':'保存宝宝档案'}}</button></footer>
    </form>
  </UiDialog>
</template>

<style scoped>
:global(.family-dialog.baby-profile-dialog){display:flex;flex-direction:column;width:min(480px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;margin:auto;overflow:hidden;background:var(--theme-surface);border:1px solid var(--theme-line);border-radius:12px;color:var(--theme-ink)}
.baby-profile-title{display:flex;align-items:center;justify-content:space-between;flex:none;gap:12px;padding:14px 18px;border-bottom:1px solid var(--theme-line)}.baby-profile-title h2{margin:0;font-size:16px}
.profile-close{display:flex;align-items:center;justify-content:center;width:30px;height:30px;min-height:30px;padding:0;border:0;background:transparent;color:var(--theme-muted)}.profile-close:hover{background:var(--theme-raised)}
#baby-profile-form{display:flex;flex-direction:column;min-height:0;overflow:hidden;margin:0}.baby-profile-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:18px}.baby-profile-footer{display:flex;justify-content:flex-end;gap:8px;flex:none;padding:12px 18px;border-top:1px solid var(--theme-line);background:var(--theme-surface)}
.profile-avatar-section{display:flex;align-items:center;gap:14px;margin-bottom:16px}.profile-avatar-controls{min-width:0;display:flex;flex-direction:column;gap:7px}.profile-avatar-controls strong{font-size:13px}.profile-avatar-controls>div{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.profile-avatar-controls button{font-size:12px;padding:6px 10px;min-height:30px}.profile-avatar-controls small{font-size:11px;color:var(--theme-muted)}
.profile-avatar-picker{padding:10px;margin-bottom:16px;background:var(--theme-background);border:1px solid var(--theme-line);border-radius:8px}.profile-photo-search{display:flex;align-items:center;gap:7px;padding:7px 10px;margin-bottom:10px;background:var(--theme-surface);border:1px solid var(--theme-line);border-radius:7px;color:var(--theme-muted)}.profile-photo-search input{min-width:0;flex:1;padding:0;border:0;outline:none;font:inherit;font-size:12px;background:transparent;color:var(--theme-ink)}.profile-photo-search:focus-within{border-color:var(--theme-accent)}
.profile-avatar-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;max-height:260px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:2px}
.profile-photo-option{display:flex;flex-direction:column;gap:5px;align-items:stretch;min-width:0;padding:4px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--theme-secondary);cursor:pointer;text-align:left}.profile-photo-option:hover:not(:disabled){background:var(--theme-selected)}.profile-photo-option.selected{border-color:var(--theme-accent);background:var(--theme-selected)}.profile-photo-option:disabled{opacity:.45;cursor:default}.profile-photo-option:focus-visible{outline:2px solid var(--theme-accent);outline-offset:-2px}
.profile-photo-image{position:relative;display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:1;overflow:hidden;border-radius:5px;background:var(--theme-selected)}.profile-photo-image>img{width:100%;height:100%;object-fit:cover}.profile-photo-check{position:absolute;right:3px;bottom:3px;display:flex;padding:2px;border-radius:50%;background:var(--theme-primary);color:var(--theme-on-primary)}.profile-photo-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.profile-photo-option small{font-size:10px}.profile-photo-loading{display:flex;justify-content:center;min-height:24px;align-items:center;font-size:11px;color:var(--theme-muted);margin-top:7px}.profile-photo-loading button{font-size:11px;padding:4px 8px;min-height:24px}
.baby-profile-body>.field{margin:14px 0}.baby-profile-body .check-field{margin:16px 0 8px}.baby-profile-body .compact-help{margin-bottom:0}.baby-profile-footer button{min-height:34px;font-size:12px}.baby-profile-body .error-text{font-size:12px;overflow-wrap:anywhere}
.profile-reference-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--theme-line)}.profile-reference-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.profile-reference-heading>div{display:flex;align-items:baseline;gap:8px}.profile-reference-heading strong{font-size:13px}.profile-reference-heading small,.profile-reference-note{font-size:11px;color:var(--theme-muted)}.profile-reference-heading button{flex:none;min-height:30px;padding:6px 10px;font-size:12px}.profile-reference-note{margin:8px 0;line-height:1.6}
.profile-reference-list{display:flex;flex-direction:column;gap:8px;max-height:230px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.profile-reference-item{display:flex;align-items:center;gap:10px;padding:7px;background:var(--theme-background);border:1px solid var(--theme-line);border-radius:8px}.profile-reference-preview{display:flex;align-items:center;justify-content:center;flex:none;width:48px;height:48px;padding:0;overflow:hidden;border:0;border-radius:6px;background:var(--theme-selected);color:var(--theme-muted)}.profile-reference-preview img{width:100%;height:100%;object-fit:cover}.profile-reference-preview:focus-visible{outline:2px solid var(--theme-accent);outline-offset:2px}.profile-reference-meta{display:flex;flex:1;flex-direction:column;min-width:0;gap:5px}.profile-reference-meta strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile-reference-meta small{font-size:10px;color:var(--theme-muted)}.profile-reference-item>.text-button{flex:none;font-size:11px;min-height:28px;padding:4px 6px}
@media(max-width:420px){.baby-profile-title{padding:12px 14px}.baby-profile-body{padding:14px}.baby-profile-footer{padding:10px 14px}.profile-avatar-grid{grid-template-columns:repeat(3,minmax(0,1fr));max-height:230px}.profile-avatar-controls button{padding:5px 8px}}
</style>
