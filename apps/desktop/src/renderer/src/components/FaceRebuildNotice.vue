<script setup lang="ts">
import type { FaceRebuildStatus } from '../../../shared/family'
import UiLoading from './UiLoading.vue'

defineProps<{ status: FaceRebuildStatus; currentLibraryId?: string; disabled: boolean }>()
defineEmits<{ resume: [] }>()
</script>

<template>
  <div class="face-rebuild-notice" role="status">
    <div class="rebuild-summary">
      <UiLoading v-if="status.state==='running'" :label="status.phase==='preparing'?'正在备份识别索引…':status.phase==='grouping'?'正在整理人物和宝宝结果…':'正在重新识别人脸…'" />
      <strong v-else>人脸重建已中断</strong>
      <span>{{status.libraryName}} · 已处理 {{status.processed}} / {{status.total}} 项<span v-if="status.failed"> · 失败 {{status.failed}} 项</span></span>
      <button v-if="status.state==='interrupted'&&status.libraryId===currentLibraryId" class="text-button" :disabled="disabled" @click="$emit('resume')">继续重建</button>
      <span v-else-if="status.libraryId!==currentLibraryId">请切换到此照片库继续</span>
    </div>
    <small v-if="status.snapshotAvailable">重扫前的宝宝结果保留浏览，完成后更新。可继续人工确认。</small>
    <small v-else>重扫前结果备份暂不可读取，原照片仍可在「照片与视频」查看。</small>
  </div>
</template>

<style scoped>
.face-rebuild-notice{margin:0 0 12px;padding:10px 12px;border:1px solid #e6eae6;border-radius:8px;background:#f7f9f6;color:#52675b;font-size:12px;overflow-wrap:anywhere}.rebuild-summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}.rebuild-summary strong{font-weight:600;color:#89672d}.face-rebuild-notice small{display:block;margin-top:5px;color:#718078;line-height:1.5}.rebuild-summary button{margin-left:auto;white-space:nowrap}@media(max-width:600px){.face-rebuild-notice{padding:9px}.rebuild-summary{gap:6px}}
</style>
