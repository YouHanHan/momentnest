<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MediaFace, MediaKind } from '../../../shared/family'

const props = withDefaults(defineProps<{ src?: string; face?: MediaFace | null; kind?: MediaKind; label?: string; size?: number }>(), { kind: 'photo', label: '人物头像', size: 56 })
const naturalSize = ref({ width: 0, height: 0 }), failed = ref(false)
const videoFrame = computed(() => props.kind === 'video' || props.face?.frameTime !== undefined)
const validFace = computed(() => {
  const face = props.face
  return Boolean(face && [face.x, face.y, face.width, face.height].every(Number.isFinite) && face.x >= 0 && face.y >= 0 && face.width > 0 && face.height > 0 && face.x + face.width <= 1.001 && face.y + face.height <= 1.001)
})
const canLoad = computed(() => Boolean(props.src && validFace.value && !videoFrame.value && !failed.value))

/** 按图片真实尺寸裁切已检测人脸，原比例缩略图与原图可复用同一坐标。 */
const cropStyle = computed(() => {
  const face = props.face, { width, height } = naturalSize.value
  if (!face || !width || !height) return { visibility: 'hidden' as const }
  const side = Math.min(Math.max(face.width * width, face.height * height) * 1.35, width, height)
  const left = Math.max(0, Math.min(face.x * width + face.width * width / 2 - side / 2, width - side))
  const top = Math.max(0, Math.min(face.y * height + face.height * height / 2 - side / 2, height - side))
  return { width: `${width / side * 100}%`, height: `${height / side * 100}%`, left: `${-left / side * 100}%`, top: `${-top / side * 100}%` }
})
watch(() => props.src, () => { naturalSize.value = { width: 0, height: 0 }; failed.value = false })
function loaded(event: Event): void {
  const image = event.target as HTMLImageElement
  naturalSize.value = { width: image.naturalWidth, height: image.naturalHeight }
}
</script>

<template>
  <span class="face-avatar" :class="{ 'face-avatar--video': videoFrame }" :style="{ '--face-size': `${size}px` }" role="img" :aria-label="videoFrame ? `${label}，视频帧暂无独立人脸预览` : label">
    <svg class="face-avatar__placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" stroke-linecap="round" /></svg>
    <img v-if="canLoad" :key="src" :src="src" :style="cropStyle" alt="" @load="loaded" @error="failed = true" />
    <svg v-if="videoFrame" class="face-avatar__video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 9 6-3v12l-6-3" /></svg>
  </span>
</template>

<style scoped>
.face-avatar { display: inline-flex; position: relative; flex: 0 0 auto; width: var(--face-size); height: var(--face-size); overflow: hidden; border-radius: 50%; background: var(--theme-raised); color: var(--theme-muted); align-items: center; justify-content: center; }
.face-avatar img { position: absolute; max-width: none; max-height: none; display: block; }
.face-avatar__placeholder { width: 48%; height: 48%; }
.face-avatar__video { position: absolute; right: 6px; bottom: 5px; width: 15px; height: 15px; padding: 2px; background: var(--theme-raised); border-radius: 4px; }
</style>
