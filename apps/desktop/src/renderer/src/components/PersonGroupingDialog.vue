<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { PersonGroupingPreview, PersonProfile } from '../../../shared/family'
import { closePopupMenus } from '../popup-dismiss'
import FaceAvatar from './FaceAvatar.vue'
import UiDialog from './UiDialog.vue'
import UiIcon from './UiIcon.vue'

const props = defineProps<{ preview?: PersonGroupingPreview | null; loading: boolean; busy: boolean; error: string; libraryId?: string; suspended?: boolean }>()
const emit = defineEmits<{ close: []; confirm: [sourceIds: string[]]; retry: []; inspect: [person: PersonProfile] }>()
const dialog = ref<HTMLElement | null>(null), shown = ref(12)
const urls = reactive<Record<string, string>>({}), failed = reactive(new Set<string>()), selected = reactive(new Set<string>())
const plan = computed(() => props.preview && (!props.libraryId || props.preview.libraryId === props.libraryId) ? props.preview : null)
const visible = computed(() => plan.value?.merges.slice(0, shown.value) ?? [])
const selectedSourceIds = computed(() => plan.value?.merges.filter(merge => selected.has(merge.source.id)).map(merge => merge.source.id) ?? [])
const canConfirm = computed(() => !props.loading && !props.busy && !props.error && selectedSourceIds.value.length > 0)
type ThumbnailRequest = { assetId: string; libraryId: string; generation: number }
let generation = 0, activeRequests = 0, disposed = false, queue: ThumbnailRequest[] = []
let inspectionFocus: HTMLElement | null = null
const pending = new Set<string>()

/** 全部候选共用六个缩略图请求名额，切库后的迟到响应不写入新缓存。 */
function loadThumbnails(): void {
  if (disposed || !window.jinchuan || !plan.value || props.loading) return
  const libraryId = props.libraryId ?? plan.value.libraryId
  const assetIds = new Set(visible.value.flatMap(merge => [merge.source.reference, merge.target.reference]).filter(reference => reference?.kind === 'photo' && reference.face.frameTime === undefined).map(reference => reference!.assetId))
  for (const assetId of assetIds) {
    if (urls[assetId] || failed.has(assetId) || pending.has(assetId)) continue
    pending.add(assetId); queue.push({ assetId, libraryId, generation })
  }
  drainThumbnails()
}

function drainThumbnails(): void {
  if (disposed || !window.jinchuan) return
  while (activeRequests < 6 && queue.length) {
    const request = queue.shift()!
    if (request.generation !== generation) continue
    activeRequests++
    void window.jinchuan.mediaUrl(request.assetId, true, request.libraryId).then(url => {
      if (!disposed && request.generation === generation) urls[request.assetId] = url
    }).catch(() => {
      if (!disposed && request.generation === generation) failed.add(request.assetId)
    }).finally(() => {
      activeRequests--
      if (request.generation === generation) pending.delete(request.assetId)
      drainThumbnails()
    })
  }
}

function retryThumbnails(): void { failed.clear(); loadThumbnails() }
function close(): void { if (!props.busy) emit('close') }
/** 每条候选由用户明确接受，未选项不随确认应用。 */
function selectSource(sourceId: string, event: Event): void {
  if (props.loading || props.busy || !plan.value?.merges.some(merge => merge.source.id === sourceId)) return
  if ((event.target as HTMLInputElement).checked) selected.add(sourceId)
  else selected.delete(sourceId)
}
function selectVisible(): void { if (!props.loading && !props.busy) for (const merge of visible.value) selected.add(merge.source.id) }
function clearSelection(): void { if (!props.loading && !props.busy) selected.clear() }
/** 查看照片前记住触发按钮，返回审核时继续保留原来的键盘位置。 */
function inspect(person: PersonProfile): void {
  if (props.loading || props.busy) return
  inspectionFocus = document.activeElement instanceof HTMLElement && dialog.value?.contains(document.activeElement) ? document.activeElement : null
  emit('inspect', person)
}
function confirm(): void { if (canConfirm.value) emit('confirm', [...selectedSourceIds.value]) }
function similarityLabel(value: number): string { return Number.isFinite(value) ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` : '—' }

/** 键盘焦点留在当前弹窗，忙碌时不关闭尚在应用的选择。 */
function opened(element: HTMLElement): void {
  dialog.value = element
  if (inspectionFocus?.isConnected && element.contains(inspectionFocus)) inspectionFocus.focus({ preventScroll: true })
  else element.querySelector<HTMLButtonElement>('.grouping-close')?.focus({ preventScroll: true })
}

/** 原生弹窗内部空白保留审核方案，只有坐标位于真实遮罩时关闭。 */
function dismissBackdrop(): void { close() }

watch([() => props.libraryId, () => plan.value?.id], () => {
  generation++; shown.value = 12; queue = []; pending.clear(); failed.clear(); selected.clear()
  for (const id of Object.keys(urls)) delete urls[id]
}, { flush: 'sync' })
watch(() => [visible.value, props.loading], loadThumbnails, { immediate: true })
/** 查看关联照片时暂时退出原生顶层，返回后恢复审核选择和原焦点。 */
watch(() => props.suspended, suspended => {
  if (suspended && document.activeElement instanceof HTMLElement && dialog.value?.contains(document.activeElement)) {
    inspectionFocus = document.activeElement
  }
})
onMounted(closePopupMenus)
onUnmounted(() => { disposed = true; generation++; queue = []; pending.clear() })
</script>

<template>
  <UiDialog label="整理已识别人脸" content-class="family-dialog person-grouping-dialog" :aria-busy="loading||busy" :suspended="suspended" :close-disabled="busy" @close="dismissBackdrop" @opened="opened">
    <header class="grouping-heading"><h2>整理已识别人脸</h2><button type="button" class="grouping-close" aria-label="关闭人物整理" :disabled="busy" @click="close"><UiIcon name="close" :size="18" /></button></header>
    <div class="grouping-body">
      <div v-if="loading" class="grouping-loading" role="status"><span class="grouping-spinner" aria-hidden="true" /><span>正在比较已有特征…</span></div>
      <template v-else-if="plan">
        <div class="grouping-summary"><div><strong>{{plan.before}}</strong><UiIcon name="arrow-right" :size="18" /><strong>{{plan.before-selectedSourceIds.length}}</strong><span>个人物组</span></div><span>建议合并 {{plan.merges.length}} 组</span></div>
        <p class="grouping-note">逐项核对头像或关联照片，勾选同一个人的分组。未勾选项跳过，相似度仅供比较。</p>
        <section v-if="plan.merges.length" class="grouping-candidates" aria-label="建议合并的人物组">
          <div class="grouping-selection-actions"><span>已选择 {{selectedSourceIds.length}} 组</span><div><button type="button" class="text-button" :disabled="busy" @click="selectVisible">全选本批</button><button type="button" class="text-button" :disabled="busy||!selectedSourceIds.length" @click="clearSelection">清空选择</button></div></div>
          <div class="grouping-candidate-list" role="list">
            <article v-for="(merge,index) in visible" :key="merge.source.id" class="grouping-candidate" :class="{selected:selected.has(merge.source.id)}" role="listitem">
              <label class="grouping-select"><input type="checkbox" :aria-label="`接受第 ${index+1} 组合并`" :checked="selected.has(merge.source.id)" :disabled="busy" @change="selectSource(merge.source.id,$event)"><span>接受</span></label>
              <button type="button" class="grouping-person grouping-source" :aria-label="`查看来源人物 ${index+1} 的照片`" :disabled="busy" @click="inspect(merge.source)"><FaceAvatar :src="merge.source.reference?urls[merge.source.reference.assetId]:undefined" :face="merge.source.reference?.face" :kind="merge.source.reference?.kind" :label="merge.source.name||`来源人物 ${index+1}`" :size="44" /><span><strong :title="merge.source.name||'未命名人物'">{{merge.source.name||'未命名人物'}}</strong><small>{{merge.source.assetCount}} 张照片与视频</small><small class="grouping-view">查看照片</small></span></button>
              <UiIcon class="grouping-arrow" name="arrow-right" :size="16" />
              <button type="button" class="grouping-person grouping-target" :aria-label="`查看目标人物 ${index+1} 的照片`" :disabled="busy" @click="inspect(merge.target)"><FaceAvatar :src="merge.target.reference?urls[merge.target.reference.assetId]:undefined" :face="merge.target.reference?.face" :kind="merge.target.reference?.kind" :label="merge.target.name||`目标人物 ${index+1}`" :size="44" /><span><strong :title="merge.target.name||'未命名人物'">{{merge.target.name||'未命名人物'}}</strong><small>{{merge.target.assetCount}} 张照片与视频</small><small class="grouping-view">查看照片</small></span></button>
              <small class="grouping-similarity">特征相似度 {{similarityLabel(merge.similarity)}}</small>
            </article>
          </div>
          <div class="grouping-list-actions"><small>已显示 {{visible.length}} / {{plan.merges.length}} 组 · 头像为缩略图</small><button v-if="shown<plan.merges.length" type="button" class="text-button" :disabled="busy" @click="shown+=12">加载更多候选</button><button v-if="failed.size" type="button" class="text-button" :disabled="busy" @click="retryThumbnails">重试头像</button></div>
        </section>
        <p v-else class="grouping-empty" role="status">没有可直接合并的分组。</p>
        <p v-if="plan.ambiguous||plan.conflicts" class="grouping-exclusions"><span v-if="plan.ambiguous">{{plan.ambiguous}} 组证据不足</span><span v-if="plan.conflicts">{{plan.conflicts}} 组存在同图或同帧冲突</span><span>暂不合并。</span></p>
        <p class="grouping-preservation">原记录、宝宝参考和相册归属保留。合并后，同一人物在其他照片库沿用统一名称。</p>
      </template>
      <p v-else-if="!error" class="grouping-empty" role="status">暂无整理方案，请重新比较。</p>
      <div v-if="error" class="grouping-error" role="alert"><p>{{error}}</p><button type="button" class="text-button" :disabled="loading||busy" @click="emit('retry')">重新比较</button></div>
      <button v-else-if="!loading&&!plan" type="button" class="text-button grouping-retry" :disabled="busy" @click="emit('retry')">重新比较</button>
    </div>
    <footer class="grouping-footer"><span>已选 {{selectedSourceIds.length}} 组 · 未选项跳过</span><button type="button" class="secondary-button" :disabled="busy" @click="close">取消</button><button type="button" class="primary-button" :disabled="!canConfirm" @click="confirm">{{busy?'正在应用…':`确认应用 ${selectedSourceIds.length} 组合并`}}</button></footer>
  </UiDialog>
</template>

<style scoped>
:global(.family-dialog.person-grouping-dialog){display:flex;flex-direction:column;width:min(620px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;margin:auto;overflow:hidden;background:#fff;border:1px solid #dce5df;border-radius:12px;color:#27332d}
.grouping-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;padding:13px 18px;border-bottom:1px solid #e6ece8}.grouping-heading h2{margin:0;font-size:16px}
.grouping-close{display:flex;align-items:center;justify-content:center;width:30px;height:30px;min-height:30px;padding:0;border:0;background:transparent;color:#6c7c73;cursor:pointer}.grouping-close:hover{background:#eef3f0}
.grouping-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 18px}.grouping-summary{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.grouping-summary>div{display:flex;align-items:center;gap:10px}.grouping-summary strong{font-size:22px;font-variant-numeric:tabular-nums}.grouping-summary>span,.grouping-summary div>span{font-size:12px;color:#52675b}.grouping-summary .ui-icon{color:#7f9186}
.grouping-note,.grouping-preservation,.grouping-exclusions{margin:12px 0;font-size:11px;line-height:1.7;color:#718078;overflow-wrap:anywhere}.grouping-exclusions{display:flex;gap:4px 12px;flex-wrap:wrap;color:#796b50}.grouping-preservation{margin-bottom:0}
.grouping-candidates{margin-top:12px;border:1px solid #e3ebe5;border-radius:8px;overflow:hidden}.grouping-selection-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #e3ebe5;background:#fafcfb}.grouping-selection-actions>span{font-size:11px;color:#52675b}.grouping-selection-actions>div{display:flex;gap:4px}.grouping-selection-actions button{min-height:28px;padding:5px 7px;font-size:11px}.grouping-candidate-list{max-height:min(360px,45dvh);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.grouping-candidate{display:grid;grid-template-columns:28px minmax(0,1fr) 22px minmax(0,1fr);align-items:center;gap:4px 10px;padding:10px 12px;border-bottom:1px solid #edf2ee}.grouping-candidate:last-child{border-bottom:0}.grouping-candidate.selected{background:#f0f6f2}.grouping-select{display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer}.grouping-select input{width:16px;height:16px;margin:0;accent-color:#3b755c;cursor:inherit}.grouping-select span{font-size:9px;color:#718078}.grouping-person{display:flex;align-items:center;gap:9px;min-width:0;padding:3px 0;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;cursor:pointer}.grouping-person:hover:not(:disabled){background:#e8f0eb}.grouping-person>span:not(.face-avatar){display:flex;flex-direction:column;min-width:0;gap:4px}.grouping-person strong{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.grouping-person small{font-size:10px;color:#78867e;overflow-wrap:anywhere}.grouping-person .grouping-view{color:#3b755c;font-size:10px}.grouping-arrow{color:#91a097;justify-self:center}.grouping-similarity{grid-column:2/-1;justify-self:end;font-size:10px;color:#8b988f;font-variant-numeric:tabular-nums}
.grouping-list-actions{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding:6px 10px;border-top:1px solid #e3ebe5;background:#fafcfb}.grouping-list-actions small{font-size:10px;color:#7b8a80}.grouping-list-actions button,.grouping-error button,.grouping-retry{font-size:11px;min-height:28px;padding:5px 7px}
.grouping-empty{margin:16px 0;font-size:12px;color:#718078}.grouping-loading{display:flex;align-items:center;justify-content:center;gap:10px;min-height:120px;font-size:13px;color:#52675b}.grouping-spinner{width:16px;height:16px;flex:none;border:2px solid #dce6df;border-top-color:#3b755c;border-radius:50%;animation:grouping-spin .7s linear infinite}.grouping-error{margin-top:12px;padding:10px 12px;border:1px solid #eedfce;border-radius:7px;background:#fdf9f4;color:#8b613d}.grouping-error p{margin:0 0 5px;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.grouping-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:12px 18px;border-top:1px solid #e6ece8;background:#fafcfb}.grouping-footer>span{flex:1;min-width:0;color:#718078;font-size:11px;overflow-wrap:anywhere}.grouping-footer button{min-height:34px;padding:7px 12px;font-size:12px}.grouping-close:focus-visible,.grouping-footer button:focus-visible,.grouping-list-actions button:focus-visible,.grouping-selection-actions button:focus-visible,.grouping-person:focus-visible,.grouping-select input:focus-visible{outline:2px solid #3b755c;outline-offset:2px}:global(.person-grouping-dialog:focus){outline:none}
@keyframes grouping-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.grouping-spinner{animation:none}}
@media(max-width:450px){:global(.family-dialog.person-grouping-dialog){width:calc(100vw - 12px);max-height:calc(100dvh - 12px);border-radius:10px}.grouping-heading{padding:11px 12px}.grouping-body{padding:12px}.grouping-summary strong{font-size:20px}.grouping-candidate{padding:9px 8px;gap:4px 6px;grid-template-columns:24px minmax(0,1fr) 16px minmax(0,1fr)}.grouping-person{flex-direction:column;align-items:flex-start;gap:6px}.grouping-person>span:not(.face-avatar){width:100%}.grouping-person strong{font-size:11px}.grouping-person small{font-size:9px}.grouping-footer{padding:10px 12px;flex-wrap:wrap}.grouping-footer>span{flex-basis:100%}.grouping-footer button{padding:7px 10px}.grouping-summary>span{font-size:11px}}
</style>
