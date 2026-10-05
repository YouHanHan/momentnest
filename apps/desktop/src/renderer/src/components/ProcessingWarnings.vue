<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ProcessingWarningPage } from '../../../shared/family'
import { userError } from '../ui-error'

const props = defineProps<{ reportId?: string; warnings?: string[]; skipped?: number; libraryId?: string; running?: boolean }>()
const expanded = ref(false), loading = ref(false), error = ref('')
const report = ref<ProcessingWarningPage | null>(null)
let sequence = 0, disposed = false
const shown = computed(() => expanded.value && report.value ? report.value.items : (props.warnings ?? []).slice(0, 3))
const pageCount = computed(() => Math.max(1, Math.ceil((report.value?.total ?? 0) / (report.value?.limit ?? 20))))
const legacyIncomplete = computed(() => !props.reportId && (props.skipped ?? 0) > (props.warnings?.length ?? 0))

/** 仅在查看详情时按页读取，切库与关闭后的迟到结果不再展示。 */
async function load(page = 1): Promise<void> {
  if (!props.reportId || !window.jinchuan) return
  const current = ++sequence
  loading.value = true; error.value = ''
  try {
    const result = await window.jinchuan.getJobWarnings(props.reportId, page, props.libraryId)
    if (!disposed && current === sequence) report.value = result
  } catch (failure) { if (!disposed && current === sequence) error.value = userError(failure) }
  finally { if (!disposed && current === sequence) loading.value = false }
}
function toggle(): void {
  expanded.value = !expanded.value
  if (expanded.value && props.reportId) void load()
  else { sequence++; loading.value = false; error.value = '' }
}
watch(() => [props.reportId, props.libraryId], () => { sequence++; expanded.value = false; report.value = null; error.value = ''; loading.value = false })
watch(() => props.skipped, () => { if (expanded.value && props.running) void load(report.value?.page ?? 1) })
onUnmounted(() => { disposed = true; sequence++ })
</script>

<template>
  <section class="processing-report" aria-label="跳过原因">
    <ul v-if="shown.length" class="processing-warnings"><li v-for="(warning,index) in shown" :key="index">{{warning}}</li></ul>
    <p v-if="legacyIncomplete" class="section-tip">此历史任务只保留 {{warnings?.length??0}} 条原因，缺失记录无法补回；重新扫描可生成完整记录。</p>
    <button v-if="reportId || (warnings?.length??0)>3" class="text-button" :aria-expanded="expanded" @click="toggle">{{expanded?'收起跳过详情':`查看全部跳过原因（${skipped??warnings?.length??0}）`}}</button>
    <ul v-if="expanded&&!reportId" class="processing-warnings"><li v-for="(warning,index) in (warnings??[]).slice(3)" :key="index">{{warning}}</li></ul>
    <p v-if="loading" class="section-tip" role="status">正在读取跳过记录…</p>
    <p v-if="error" class="error-text" role="alert">{{error}} <button class="text-button" :disabled="loading" @click="load(report?.page??1)">重试读取</button></p>
    <nav v-if="expanded&&report" class="warning-pages" aria-label="跳过记录分页">
      <span>第 {{report.page}} / {{pageCount}} 页 · 共 {{report.total}} 条</span>
      <button class="text-button" :disabled="loading||report.page<=1" @click="load(report.page-1)">上一页</button>
      <button class="text-button" :disabled="loading||report.page>=pageCount" @click="load(report.page+1)">下一页</button>
    </nav>
  </section>
</template>

<style scoped>
.processing-report{min-width:0;max-width:100%;font-size:12px}
.processing-warnings{margin:6px 0;padding-left:20px;max-height:220px;overflow:auto;overflow-wrap:anywhere;line-height:1.6}
.processing-warnings li+li{margin-top:4px}
.processing-report>.text-button,.warning-pages .text-button{font-size:11px;min-height:32px;padding:5px 8px}
.warning-pages{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;margin-top:5px}
.warning-pages span{font-variant-numeric:tabular-nums;color:var(--muted)}
</style>
