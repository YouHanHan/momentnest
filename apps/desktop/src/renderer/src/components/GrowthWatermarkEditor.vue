<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type { BabyProfile, MediaAsset, WatermarkOptions, WatermarkResult } from '../../../shared/family'
import { hasReliableDate, plainData } from '../family-ui'
import { userError } from '../ui-error'
import UiDialog from './UiDialog.vue'
import UiIcon from './UiIcon.vue'
import UiSelect from './UiSelect.vue'

const props = defineProps<{ assets: MediaAsset[]; baby: BabyProfile; libraryId?: string; libraryName?: string; inline?: boolean }>()
const emit = defineEmits<{ close: []; inspect: [asset: MediaAsset]; finished: [results: WatermarkResult[]] }>()
const api = window.momentnest
const index = ref(0)
const draft = reactive<Omit<WatermarkOptions, 'babyId'>>({ template: 'growth', growthMode: 'auto', shade: true, position: 'bottom-left', fontSize: 48, color: '#ffffff', opacity: 0.95, showName: false, showAge: true, showDayCount: false, showDate: true })
const growthModeOptions = [{ label: '自动成长', value: 'auto' }, { label: '出生第几天', value: 'day-count' }] satisfies Array<{ label: string; value: NonNullable<WatermarkOptions['growthMode']> }>
const positionOptions = [{ label: '左下', value: 'bottom-left' }, { label: '右下', value: 'bottom-right' }, { label: '左上', value: 'top-left' }, { label: '右上', value: 'top-right' }] satisfies Array<{ label: string; value: WatermarkOptions['position'] }>
const growthMode = computed<NonNullable<WatermarkOptions['growthMode']>>({ get: () => draft.growthMode ?? 'auto', set: value => { draft.growthMode = value } })
const preview = ref(''), previewAssetId = ref(''), previewError = ref(''), previewLoading = ref(false)
const exporting = ref(false), results = ref<WatermarkResult[]>([]), notice = ref('')
const exportCount = ref(0), exportSkipped = ref(0)
let previewSequence = 0, exportSequence = 0, disposed = false
let timer: ReturnType<typeof setTimeout> | undefined

/** 日期、归属与当前库均需明确，疑似照片不能直接制作宝宝水印。 */
function problem(asset: MediaAsset): string {
  if (!props.libraryId || !asset.locations.some(location => location.libraryId === props.libraryId)) return '不在当前照片库中'
  if (asset.kind !== 'photo') return '视频暂不支持照片水印'
  if (!asset.available || !asset.locations.some(location => location.libraryId === props.libraryId && location.available)) return '当前照片库原文件不可用，请连接来源硬盘'
  if (!asset.babyIds.includes(props.baby.id)) return '请先确认属于当前宝宝'
  if (asset.date && asset.date < props.baby.birthday) return '拍摄日期早于出生日期，请修正日期'
  if (!hasReliableDate(asset, props.baby)) return '请先确认实际拍摄日期'
  return ''
}
const problems = computed(() => props.assets.flatMap(asset => { const reason = problem(asset); return reason ? [{ asset, reason }] : [] }))
const eligible = computed(() => props.assets.filter(asset => !problem(asset)))
const active = computed(() => eligible.value[index.value] ?? eligible.value[0])
const options = computed<WatermarkOptions>(() => ({ ...draft, babyId: props.baby.id, showAge: draft.growthMode === 'auto', showDayCount: draft.growthMode === 'day-count' }))
const errors = computed(() => results.value.filter(result => result.error))
const successes = computed(() => results.value.filter(result => result.path && !result.error))

/** 调整参数只更新预览，迟到响应和已关闭会话不改变当前画面。 */
async function requestPreview(sequence: number): Promise<void> {
  const asset = active.value
  if (!api || !asset || disposed) { previewLoading.value = false; return }
  const context = props.libraryId, value = plainData(options.value)
  try {
    const result = await api.previewWatermark(asset.id, value, context)
    if (disposed || sequence !== previewSequence) return
    if (!result.dataUrl || result.error) throw new Error(result.error || '未取得水印预览，请重试。')
    preview.value = result.dataUrl; previewAssetId.value = asset.id
  } catch (error) { if (!disposed && sequence === previewSequence) previewError.value = userError(error) }
  finally { if (!disposed && sequence === previewSequence) previewLoading.value = false }
}
function queuePreview(): void {
  clearTimeout(timer)
  const sequence = ++previewSequence
  previewError.value = ''
  if (previewAssetId.value !== active.value?.id) { preview.value = ''; previewAssetId.value = '' }
  previewLoading.value = Boolean(active.value && api)
  if (previewLoading.value) timer = setTimeout(() => { void requestPreview(sequence) }, 250)
}

/** 跳过不合格项目，保留成功回执和逐张失败原因，不清理任何副本。 */
async function exportImages(): Promise<void> {
  if (!api || exporting.value || previewLoading.value || previewError.value || !preview.value || !eligible.value.length) return
  if (eligible.value.length > 100) { notice.value = '每次最多导出 100 张照片，请调整选择后再导出。'; return }
  const assets = plainData(eligible.value), value = plainData(options.value), context = props.libraryId
  const sequence = ++exportSequence, exported: WatermarkResult[] = []
  exporting.value = true; exportCount.value = assets.length; exportSkipped.value = problems.value.length; results.value = []; notice.value = ''
  try {
    const response = await api.exportWatermark(assets.map(asset => asset.id), value, context)
    if (disposed || sequence !== exportSequence) return
    if (!response.length) notice.value = '已取消导出。'
    exported.push(...response); results.value = [...exported]
    if (!disposed && sequence === exportSequence) {
      if (!notice.value) notice.value = `已保存 ${successes.value.length} 张副本${errors.value.length ? `，失败 ${errors.value.length} 张` : ''}${exportSkipped.value ? `，跳过 ${exportSkipped.value} 项` : ''}。`
      emit('finished', exported)
    }
  } catch (error) { if (!disposed && sequence === exportSequence) notice.value = userError(error) }
  finally { if (!disposed && sequence === exportSequence) exporting.value = false }
}
function close(): void { emit('close') }
watch(() => JSON.stringify({ options: options.value, asset: active.value?.id, date: active.value?.date, baby: props.baby, library: props.libraryId }), queuePreview, { immediate: true })
watch(() => eligible.value.length, count => { if (index.value >= count) index.value = Math.max(0, count - 1) })
onUnmounted(() => {
  disposed = true; previewSequence++; exportSequence++; clearTimeout(timer)
})
</script>

<template>
  <component :is="inline?'section':UiDialog" :class="inline?'growth-watermark-editor watermark-layout':undefined" :content-class="inline?undefined:'growth-watermark-editor'" :label="inline?undefined:'成长水印'" :aria-label="inline?'成长水印':undefined" @close="close">
    <header class="growth-editor-header"><div><h2>成长水印</h2><span>{{baby.name}} · {{libraryName||'当前照片库'}}</span></div><button v-if="!inline" class="text-button" aria-label="关闭成长水印" @click="close"><UiIcon name="close" :size="18" /></button></header>
    <div class="growth-editor-body">
      <div class="growth-editor-photo">
        <div class="growth-editor-stage" :aria-busy="previewLoading">
          <img v-if="preview" :src="preview" alt="成长水印预览">
          <div v-else class="growth-editor-placeholder"><span>{{previewLoading?'正在生成预览…':active?'等待预览':'选择已确认拍摄日期的宝宝照片'}}</span></div>
          <span v-if="previewLoading&&preview" class="growth-preview-updating" role="status">正在更新…</span>
        </div>
        <div v-if="active" class="growth-photo-navigation"><button class="text-button" aria-label="上一张水印照片" :disabled="index===0||exporting" @click="index--"><UiIcon name="arrow-left" :size="16" /></button><span>{{index+1}} / {{eligible.length}}<small>{{active.filename}}</small></span><button class="text-button" aria-label="下一张水印照片" :disabled="index>=eligible.length-1||exporting" @click="index++"><UiIcon name="arrow-right" :size="16" /></button></div>
        <div v-if="previewError" class="growth-preview-error" role="alert"><span>{{previewError}}</span><button class="text-button" @click="queuePreview">重试预览</button></div>
      </div>
      <aside class="growth-editor-controls">
        <label class="field"><span>文字内容</span><UiSelect v-model="growthMode" :options="growthModeOptions" label="水印内容" :disabled="exporting" /></label>
        <label class="field"><span>显示位置</span><UiSelect v-model="draft.position" :options="positionOptions" label="水印位置" :disabled="exporting" /></label>
        <details class="growth-more-settings"><summary>更多设置</summary><fieldset :disabled="exporting"><label><input v-model="draft.showName" type="checkbox">显示宝宝昵称</label><label><input v-model="draft.showDate" type="checkbox">显示拍摄日期</label><label><input v-model="draft.shade" type="checkbox">淡暗底，增强文字清晰度</label><label class="field"><span>字号 {{draft.fontSize}}</span><input v-model.number="draft.fontSize" type="range" min="14" max="120" aria-label="水印字号"></label><label class="field"><span>颜色</span><input v-model="draft.color" type="color" aria-label="水印颜色"></label><label class="field"><span>透明度 {{Math.round(draft.opacity*100)}}%</span><input v-model.number="draft.opacity" type="range" min="0.2" max="1" step="0.05" aria-label="水印透明度"></label></fieldset></details>
        <p class="growth-editor-tip">出生当天算第 1 天，年龄按照片的拍摄日期计算。</p>
        <details v-if="problems.length" class="growth-watermark-problems" open><summary>跳过 {{problems.length}} 项</summary><ul><li v-for="item in problems" :key="item.asset.id"><button class="text-button" :disabled="exporting" @click="emit('inspect',item.asset)">{{item.asset.filename}}</button><span>{{item.reason}}</span></li></ul></details>
        <details v-if="results.length" class="growth-export-results" :open="errors.length>0"><summary>已保存 {{successes.length}} 张<span v-if="errors.length"> · 失败 {{errors.length}} 张</span></summary><ul><li v-for="(result,resultIndex) in results" :key="resultIndex"><strong>{{result.filename}}</strong><span :class="{'error-text':result.error}">{{result.error||result.path}}</span></li></ul></details>
      </aside>
    </div>
    <footer class="growth-editor-footer"><div role="status"><span v-if="exporting">正在保存 {{exportCount}} 张副本…</span><span v-else>{{notice||`另存 JPEG 副本，原图保留${problems.length?'；其余有效照片继续导出':''}`}}</span></div><button v-if="!inline" class="secondary-button" @click="close">{{exporting?'关闭':'取消'}}</button><button class="primary-button growth-export-button" :disabled="exporting||!eligible.length||previewLoading||!!previewError||!preview" @click="exportImages">{{exporting?'正在保存…':eligible.length>1?`导出 ${eligible.length} 张副本`:'导出水印副本'}}</button></footer>
  </component>
</template>

<style scoped>
:global(.growth-watermark-editor){box-sizing:border-box;display:flex;flex-direction:column;min-width:0;margin:0;border:1px solid #e1e8e3;border-radius:14px;background:#fff;color:#223b2d;padding:0;overflow:hidden}:global(.growth-watermark-editor.watermark-layout){display:flex}:global(.growth-watermark-editor:not(.watermark-layout)){margin:auto;width:min(980px,calc(100vw - 48px));max-width:none;max-height:calc(100vh - 96px);box-shadow:0 20px 70px #16332930}.growth-editor-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid #e8eee9;flex:none}.growth-editor-header>div{display:flex;align-items:baseline;gap:12px;min-width:0}.growth-editor-header h2{margin:0;font-size:16px;white-space:nowrap}.growth-editor-header span{font-size:11px;color:#718078;overflow-wrap:anywhere}.growth-editor-body{display:grid;grid-template-columns:minmax(0,1fr) 240px;min-height:0;overflow:auto}.growth-editor-photo{padding:16px;min-width:0;background:#f7f9f7;display:flex;flex-direction:column}.growth-editor-stage{position:relative;min-height:210px;height:min(48vh,420px);display:flex;align-items:center;justify-content:center;overflow:hidden}.growth-editor-stage img{display:block;max-width:100%;max-height:100%;object-fit:contain}.growth-editor-placeholder{padding:24px;text-align:center;font-size:12px;color:#728076}.growth-preview-updating{position:absolute;right:8px;top:8px;padding:5px 8px;border-radius:6px;background:#fffffff0;color:#385544;font-size:11px}.growth-photo-navigation{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:8px;min-width:0;font-size:11px;color:#587160}.growth-photo-navigation>span{min-width:0;text-align:center}.growth-photo-navigation small{display:block;margin-top:3px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#748277}.growth-photo-navigation button{flex:none}.growth-editor-controls{padding:16px;min-width:0}.growth-editor-controls>.field{margin-bottom:12px}.growth-more-settings{font-size:12px}.growth-more-settings summary{color:#587160;padding:8px 0;cursor:pointer}.growth-more-settings fieldset{padding:4px 0 0;margin:0;border:0;display:flex;flex-direction:column;gap:10px;font-size:11px}.growth-more-settings input[type=checkbox]{width:auto}.growth-more-settings .field{gap:5px}.growth-editor-tip{margin:16px 0 0;color:#728076;font-size:11px;line-height:1.7}.growth-editor-footer{flex:none;display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #e8eee9}.growth-editor-footer>div{flex:1;min-width:0;font-size:11px;color:#718078;line-height:1.5;overflow-wrap:anywhere}.growth-editor-footer button{flex:none}.growth-preview-error{font-size:12px;color:#a04436;margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}.growth-watermark-problems,.growth-export-results{font-size:11px;margin-top:14px;color:#89672d}.growth-export-results{color:#587160}.growth-watermark-problems summary,.growth-export-results summary{cursor:pointer}.growth-watermark-problems ul,.growth-export-results ul{list-style:none;padding:0;margin:6px 0;max-height:160px;overflow:auto}.growth-watermark-problems li,.growth-export-results li{display:flex;flex-direction:column;gap:3px;margin-bottom:8px;overflow-wrap:anywhere}.growth-watermark-problems button{text-align:left;padding:0;font-size:11px}.growth-export-results strong{font-weight:500}.growth-export-results span{color:#728076}.growth-export-results .error-text{color:#a04436}@media(max-width:650px){:global(.growth-watermark-editor:not(.watermark-layout)){width:calc(100vw - 24px);max-height:calc(100vh - 76px)}.growth-editor-body{grid-template-columns:minmax(0,1fr)}.growth-editor-stage{height:240px;min-height:160px}.growth-editor-controls{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.growth-more-settings,.growth-editor-tip,.growth-watermark-problems,.growth-export-results{grid-column:1/-1}.growth-editor-header{padding:10px 12px}.growth-editor-header>div{flex-wrap:wrap;gap:4px 10px}.growth-editor-footer{padding:10px 12px;flex-wrap:wrap}.growth-editor-footer>div{flex-basis:100%}.growth-export-button{margin-left:auto}.growth-photo-navigation small{max-width:220px}}
</style>
