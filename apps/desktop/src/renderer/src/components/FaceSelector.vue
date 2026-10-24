<script setup lang="ts">
import type { MediaFace, MediaKind } from '../../../shared/family'
import FaceAvatar from './FaceAvatar.vue'

withDefaults(defineProps<{ faces: MediaFace[]; src?: string; kind?: MediaKind; selectedId?: string; disabled?: boolean }>(), { kind: 'photo', selectedId: '', disabled: false })
const emit = defineEmits<{ select: [faceId: string] }>()

/** 有命名时显示人物名，未知人脸使用稳定序号；视频标明检测帧。 */
function faceLabel(face: MediaFace, index: number): string {
  return face.personName || `人脸 ${index + 1}`
}
function frameLabel(face: MediaFace): string {
  return Number.isFinite(face.frameTime) ? `视频帧 · ${face.frameTime!.toFixed(1)} 秒` : '视频帧'
}
</script>

<template>
  <div v-if="faces.length" class="face-selector" role="group" aria-label="选择检测到的人脸">
    <button v-for="(face, index) in faces" :key="face.id" type="button" class="face-selector__option" :class="{ 'face-selector__option--selected': selectedId === face.id }" :aria-pressed="selectedId === face.id" :disabled="disabled" @click="emit('select', face.id)">
      <FaceAvatar :src="src" :face="face" :kind="kind" :label="faceLabel(face, index)" :size="48" />
      <span class="face-selector__name">{{ faceLabel(face, index) }}</span>
      <small v-if="kind === 'video' || face.frameTime !== undefined">{{ frameLabel(face) }}</small>
    </button>
  </div>
</template>

<style scoped>
.face-selector { display: flex; gap: 8px; width: 100%; min-width: 0; overflow-x: auto; padding: 4px 0 8px; scrollbar-width: thin; }
.face-selector__option { display: flex; flex: 0 0 auto; flex-direction: column; align-items: center; gap: 6px; min-width: 80px; max-width: 160px; padding: 8px 10px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--theme-ink); cursor: pointer; font: inherit; font-size: 13px; }
.face-selector__option:hover { background: var(--theme-background); }
.face-selector__option--selected { border-color: var(--theme-accent); background: var(--theme-raised); color: var(--theme-primary-text); }
.face-selector__option:focus-visible { outline: 2px solid var(--theme-accent); outline-offset: -2px; }
.face-selector__option:disabled { opacity: .55; cursor: default; }
.face-selector__name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.face-selector__option small { color: var(--theme-muted); font-size: 11px; }
</style>
