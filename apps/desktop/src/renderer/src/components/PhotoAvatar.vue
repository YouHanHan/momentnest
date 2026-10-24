<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import UiIcon from './UiIcon.vue'

const props = withDefaults(defineProps<{ assetId?: string; libraryId?: string; available?: boolean; size?: number; label?: string }>(), { available: true, size: 48, label: '宝宝头像' })
const src = ref(''), loading = ref(false), failed = ref(false)
let sequence = 0, disposed = false

/** 头像只读取当前授权照片库的缩略图，切换后的旧响应不能覆盖新头像。 */
watch([() => props.assetId, () => props.libraryId, () => props.available], async ([assetId, libraryId, available]) => {
  const request = ++sequence
  src.value = ''; failed.value = false; loading.value = false
  if (!assetId) return
  if (!libraryId || !available || !window.momentnest) { failed.value = true; return }
  loading.value = true
  try {
    const url = await window.momentnest.mediaUrl(assetId, true, libraryId)
    if (!disposed && request === sequence) src.value = url
  } catch { if (!disposed && request === sequence) failed.value = true }
  finally { if (!disposed && request === sequence) loading.value = false }
}, { immediate: true })
/** 忽略上一张头像在切换后迟到的图片错误。 */
function imageFailed(event: Event): void {
  if (!disposed && event.currentTarget instanceof HTMLImageElement && event.currentTarget.getAttribute('src') === src.value) failed.value = true
}
onUnmounted(() => { disposed = true; sequence++ })
</script>

<template>
  <span class="photo-avatar" :style="{ '--avatar-size': `${size}px` }" :aria-busy="loading" :title="failed ? '头像照片在当前库暂不可用，可重新选择' : label">
    <UiIcon name="baby" :size="Math.round(size * .55)" />
    <img v-if="src&&!failed" :key="src" :src="src" :alt="label" @error="imageFailed">
  </span>
</template>

<style scoped>
.photo-avatar{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:var(--avatar-size);height:var(--avatar-size);overflow:hidden;border-radius:50%;background:var(--theme-selected);color:var(--theme-muted)}
.photo-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
</style>
