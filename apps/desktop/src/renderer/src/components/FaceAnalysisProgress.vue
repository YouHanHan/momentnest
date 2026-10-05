<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FamilyJob } from '../../../shared/family'
import { faceTimingLabel } from '../../../shared/face-progress'

const props = defineProps<{ job: FamilyJob; processed: number; faceCount: number; now: number }>()
const sample = ref({ time: props.now, processed: props.processed })
watch(() => props.job.id, () => { sample.value = { time: props.now, processed: props.processed } })
watch(() => props.processed, (value, previous) => { if (value < previous) sample.value = { time: props.now, processed: value } })
const timing = computed(() => faceTimingLabel(props.job, props.processed, props.now, sample.value))
const percentage = computed(() => props.job.total > 0 ? Math.min(99, Math.floor(props.processed / props.job.total * 100)) : undefined)
</script>

<template>
  <section class="face-analysis-progress" aria-label="本地人脸分析进度">
    <div class="face-analysis-heading"><strong>正在本地分析人脸</strong><span>已处理 {{processed}}{{job.total > 0 ? ` / ${job.total}` : ''}} 项<span v-if="percentage !== undefined"> · {{percentage}}%</span> · 检测到 {{faceCount}} 张人脸</span></div>
    <progress aria-label="人脸分析完成进度" :value="job.total > 0 ? Math.min(processed,job.total * 0.99) : undefined" :max="Math.max(1,job.total)"></progress>
    <div class="face-analysis-timing">{{timing}}<span v-if="job.skipped"> · 跳过 {{job.skipped}} 项</span></div>
    <small>已完成缓存复用，继续处理未完成项。首次分析较慢：无脸照片补查方向，视频检查多帧；可以继续浏览。</small>
  </section>
</template>

<style scoped>
.face-analysis-progress{margin:0 0 12px;padding:10px 12px;border:1px solid #dce9df;border-radius:9px;background:#f4f8f5;color:#52685a;font-size:11px}.face-analysis-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 12px}.face-analysis-heading strong{color:#32664b;font-weight:600}.face-analysis-progress progress{display:block;width:100%;height:5px;margin:7px 0;accent-color:#52846a}.face-analysis-timing{margin-bottom:4px}.face-analysis-progress small{display:block;color:#718078;font-size:10px;line-height:1.5}
</style>
