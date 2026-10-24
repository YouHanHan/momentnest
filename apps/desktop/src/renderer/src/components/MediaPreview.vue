<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { MediaAsset } from '../../../shared/family'
import { closePopupMenus } from '../popup-dismiss'
import UiIcon from './UiIcon.vue'

const props = defineProps<{
  asset: Pick<MediaAsset, 'id' | 'filename' | 'kind' | 'width' | 'height' | 'available'>; src: string; loading: boolean; error?: string; poster?: string
  counter?: string; caption?: string; closeLabel?: string; canPrevious: boolean; canNext: boolean
  navigationLoading?: boolean; faceSelection?: boolean; referencePicking?: boolean; suspended?: boolean
}>()
const emit = defineEmits<{
  close: []; previous: []; next: []; retry: []; 'video-ready': [element: HTMLVideoElement | null]
}>()
const dialog = ref<HTMLElement | null>(null), viewport = ref<HTMLElement | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null), informationButton = ref<HTMLButtonElement | null>(null)
const informationPanel = ref<HTMLElement | null>(null)
const photo = ref<HTMLImageElement | null>(null)
const video = ref<HTMLVideoElement | null>(null), informationOpen = ref(false), fullscreen = ref(false)
const mediaReady = ref(false), decodeError = ref(''), naturalWidth = ref(1), naturalHeight = ref(1)
const viewWidth = ref(1), viewHeight = ref(1), zoom = ref(1), rotation = ref(0), fitMode = ref(true)
const panX = ref(0), panY = ref(0), dragging = ref(false)
let observer: ResizeObserver | undefined, previousFocus: HTMLElement | null = null, lastFocus: HTMLElement | null = null, fullscreenTarget: HTMLElement | null = null
let disposed = false, dragStart: { id: number; x: number; y: number; panX: number; panY: number } | undefined
const failure = computed(() => props.error || decodeError.value)
const photoReady = computed(() => props.asset.kind === 'photo' && mediaReady.value && !props.loading && !failure.value)
const quarterTurn = computed(() => rotation.value % 180 !== 0)
const rotatedWidth = computed(() => quarterTurn.value ? naturalHeight.value : naturalWidth.value)
const rotatedHeight = computed(() => quarterTurn.value ? naturalWidth.value : naturalHeight.value)
const fitScale = computed(() => Math.min(1, Math.max(0.001, Math.min(viewWidth.value / rotatedWidth.value, viewHeight.value / rotatedHeight.value))))
const minimumZoom = computed(() => Math.min(0.2, fitScale.value))
const zoomText = computed(() => (zoom.value < 0.1 ? (zoom.value * 100).toFixed(1) : Math.round(zoom.value * 100)) + '%')
const loadingMedia = computed(() => props.loading || (!!props.src && !mediaReady.value && !failure.value))
const stageStyle = computed(() => ({
  width: naturalWidth.value * zoom.value + 'px', height: naturalHeight.value * zoom.value + 'px',
  left: 'calc(50% + ' + panX.value + 'px)', top: 'calc(50% + ' + panY.value + 'px)',
  transform: 'translate(-50%, -50%) rotate(' + rotation.value + 'deg)',
  visibility: mediaReady.value && !props.loading && !failure.value ? 'visible' as const : 'hidden' as const,
}))

/** 平移始终限制在画布内，缩小后的图片重新居中。 */
function constrainPan(): void {
  const limitX = Math.max(0, (rotatedWidth.value * zoom.value - viewWidth.value) / 2)
  const limitY = Math.max(0, (rotatedHeight.value * zoom.value - viewHeight.value) / 2)
  panX.value = Math.min(limitX, Math.max(-limitX, panX.value))
  panY.value = Math.min(limitY, Math.max(-limitY, panY.value))
}

function fit(): void {
  fitMode.value = true; zoom.value = fitScale.value; panX.value = 0; panY.value = 0
}

/** 鼠标所在画面位置在缩放前后保持一致。 */
function setZoom(value: number, anchorX = 0, anchorY = 0): void {
  if (!photoReady.value || props.suspended) return
  const nextZoom = Math.min(8, Math.max(minimumZoom.value, value)), ratio = nextZoom / zoom.value
  panX.value = anchorX - (anchorX - panX.value) * ratio
  panY.value = anchorY - (anchorY - panY.value) * ratio
  zoom.value = nextZoom; fitMode.value = false; constrainPan()
}

function changeZoom(factor: number): void { setZoom(zoom.value * factor) }
function actualSize(): void { setZoom(1) }
function rotate(): void {
  if (!photoReady.value || props.faceSelection || props.suspended) return
  rotation.value = (rotation.value + 90) % 360; fit()
}

function measureViewport(): void {
  if (!viewport.value) return
  viewWidth.value = Math.max(1, viewport.value.clientWidth)
  viewHeight.value = Math.max(1, viewport.value.clientHeight)
  if (fitMode.value) fit()
  else constrainPan()
}

/** 解码后的原图尺寸决定实际大小，人脸层与图片使用相同平面。 */
function imageLoaded(event: Event): void {
  const image = event.target as HTMLImageElement
  if (!isCurrentMedia(image)) return
  if (!image.naturalWidth || !image.naturalHeight) { previewFailed(); return }
  naturalWidth.value = image.naturalWidth; naturalHeight.value = image.naturalHeight
  decodeError.value = ''; mediaReady.value = true; measureViewport(); fit()
}

function videoLoaded(event: Event): void {
  const element = event.target as HTMLVideoElement
  if (!isCurrentMedia(element)) return
  naturalWidth.value = element.videoWidth || Math.max(1, props.asset.width)
  naturalHeight.value = element.videoHeight || Math.max(1, props.asset.height)
  decodeError.value = ''; mediaReady.value = true
}

/** 切图或重试后，旧元素的迟到事件不能覆盖当前画面。 */
function isCurrentMedia(element: HTMLImageElement | HTMLVideoElement): boolean {
  return !disposed && !props.loading && element.dataset.previewAsset === props.asset.id &&
    element.getAttribute('src') === props.src && (element === photo.value || element === video.value)
}

function previewFailed(event?: Event): void {
  if (event && !isCurrentMedia(event.target as HTMLImageElement | HTMLVideoElement)) return
  mediaReady.value = false
  decodeError.value = props.asset.kind === 'video' ? '视频无法播放，请重试或打开原文件位置。' : '照片无法预览，请重试或打开原文件位置。'
}

function retryPreview(): void {
  if (!props.asset.available || props.loading || props.suspended) return
  decodeError.value = ''; mediaReady.value = false; emit('retry')
}

function wheel(event: WheelEvent): void {
  if (!photoReady.value || props.suspended) return
  event.preventDefault()
  if ((event.target as HTMLElement).closest('button,input,select,textarea')) return
  const bounds = viewport.value!.getBoundingClientRect()
  setZoom(zoom.value * Math.exp(-Math.max(-160, Math.min(160, event.deltaY)) * 0.0025),
    event.clientX - bounds.left - bounds.width / 2, event.clientY - bounds.top - bounds.height / 2)
}

function doubleClick(event: MouseEvent): void {
  if (!photoReady.value || props.suspended || (event.target as HTMLElement).closest('button')) return
  event.preventDefault()
  if (fitMode.value) actualSize()
  else fit()
}

/** 仅拖动照片画布，头像和工具按钮保留各自的点击操作。 */
function startDrag(event: PointerEvent): void {
  if (!photoReady.value || props.suspended || event.button !== 0 || (event.target as HTMLElement).closest('button,input,select,textarea')) return
  if (rotatedWidth.value * zoom.value <= viewWidth.value && rotatedHeight.value * zoom.value <= viewHeight.value) return
  event.preventDefault()
  dragStart = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: panX.value, panY: panY.value }
  dragging.value = true; viewport.value?.setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent): void {
  if (!dragStart || dragStart.id !== event.pointerId) return
  panX.value = dragStart.panX + event.clientX - dragStart.x
  panY.value = dragStart.panY + event.clientY - dragStart.y
  constrainPan()
}

function stopDrag(): void {
  const pointerId = dragStart?.id
  dragStart = undefined; dragging.value = false
  if (pointerId !== undefined && viewport.value?.hasPointerCapture(pointerId)) viewport.value.releasePointerCapture(pointerId)
}

function navigate(direction: 'previous' | 'next'): void {
  if (props.navigationLoading || props.suspended || (direction === 'previous' ? !props.canPrevious : !props.canNext)) return
  stopDrag()
  if (direction === 'previous') emit('previous')
  else emit('next')
}

async function closeInformation(): Promise<void> {
  informationOpen.value = false; await nextTick()
  if (!props.suspended && !disposed) informationButton.value?.focus()
}

/** 信息外部点击收起面板，同次遮罩点击只关闭当前信息层。 */
function dismissInformation(event: MouseEvent): void {
  if (!informationOpen.value || props.suspended || !(event.target instanceof Node)) return
  if (informationPanel.value?.contains(event.target) || informationButton.value?.contains(event.target)) return
  if (event.target instanceof Element && event.target.closest('.n-date-panel,.n-base-select-menu')) return
  if (event.target === event.currentTarget) {
    event.preventDefault(); event.stopImmediatePropagation(); void closeInformation()
  } else informationOpen.value = false
}

/** 全屏仅影响预览窗口，不更改媒体或 Electron 窗口配置。 */
async function exitFullscreen(): Promise<void> {
  if (fullscreenTarget && document.fullscreenElement === fullscreenTarget) {
    try { await document.exitFullscreen() } catch { /* 预览关闭时由浏览器继续释放全屏。 */ }
  }
}

async function toggleFullscreen(): Promise<void> {
  if (props.suspended || !dialog.value) return
  if (document.fullscreenElement === dialog.value) { await exitFullscreen(); return }
  try { await dialog.value.requestFullscreen() } catch { /* 系统拒绝全屏时保留当前预览。 */ }
}

function fullscreenChanged(): void { fullscreen.value = document.fullscreenElement === dialog.value; measureViewport() }
function close(): void { if (!props.suspended) emit('close') }
defineExpose({ exitFullscreen })

function focusableControls(): HTMLElement[] {
  if (!dialog.value) return []
  return [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],video[controls],[tabindex]:not([tabindex="-1"])')]
    .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'))
}

/** 快捷键避开表单和视频控制，Tab 始终停留在当前预览。 */
function keydown(event: KeyboardEvent): void {
  if (props.suspended || disposed || event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation()
    if (fullscreen.value) void exitFullscreen()
    else if (informationOpen.value) void closeInformation()
    else close()
    return
  }
  if (event.key === 'Tab') {
    const controls = focusableControls(), first = controls[0], last = controls.at(-1)
    if (!first || !last) { event.preventDefault(); dialog.value?.focus(); return }
    if (!dialog.value?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    return
  }
  const target = event.target instanceof HTMLElement ? event.target : null
  if (event.ctrlKey || event.altKey || event.metaKey || target?.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),video,.ui-select,.ui-date-picker,.n-date-panel,.n-base-select-menu,[role="combobox"]')) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); if (!event.repeat) navigate(event.key === 'ArrowLeft' ? 'previous' : 'next'); return
  }
  if (!photoReady.value) return
  if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25) }
  else if (event.key === '-' || event.key === '_') { event.preventDefault(); changeZoom(0.8) }
  else if (event.key === '0') { event.preventDefault(); fit() }
  else if (event.key === '1') { event.preventDefault(); actualSize() }
}

function focusEntered(event: FocusEvent): void {
  if (props.suspended || disposed || !(event.target instanceof HTMLElement)) return
  if (dialog.value?.contains(event.target)) lastFocus = event.target
  else (lastFocus?.isConnected ? lastFocus : closeButton.value)?.focus()
}

watch(() => props.asset.id, () => { informationOpen.value = false })
watch([() => props.asset.id, () => props.src], () => {
  video.value?.pause(); stopDrag(); mediaReady.value = false; decodeError.value = ''
  naturalWidth.value = Math.max(1, props.asset.width || 1); naturalHeight.value = Math.max(1, props.asset.height || 1)
  rotation.value = 0; fit()
}, { immediate: true })
watch(video, (element, previous) => { previous?.pause(); emit('video-ready', element) }, { flush: 'post' })
watch(() => props.faceSelection, active => { if (active) { rotation.value = 0; stopDrag(); fit() } })
watch(() => props.suspended, async suspended => {
  stopDrag()
  if (!suspended) { await nextTick(); if (!disposed) (lastFocus?.isConnected ? lastFocus : closeButton.value)?.focus() }
})

onMounted(async () => {
  closePopupMenus()
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  fullscreenTarget = dialog.value
  observer = new ResizeObserver(measureViewport)
  if (viewport.value) observer.observe(viewport.value)
  window.addEventListener('keydown', keydown, true)
  window.addEventListener('focusin', focusEntered)
  document.addEventListener('fullscreenchange', fullscreenChanged)
  await nextTick(); measureViewport()
  if (!props.suspended && !disposed) closeButton.value?.focus()
})
onUnmounted(() => {
  disposed = true; stopDrag(); observer?.disconnect(); video.value?.pause(); emit('video-ready', null)
  window.removeEventListener('keydown', keydown, true); window.removeEventListener('focusin', focusEntered)
  document.removeEventListener('fullscreenchange', fullscreenChanged)
  void exitFullscreen()
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <div class="preview-backdrop media-preview-backdrop" role="dialog" aria-modal="true" :aria-label="asset.filename" @click.capture="dismissInformation" @click.self="close">
    <section ref="dialog" class="family-dialog media-dialog" :class="{ 'reference-picker-mode': referencePicking, 'has-preview-information': informationOpen }" tabindex="-1">
      <header class="preview-heading">
        <h2 :title="asset.filename">{{ asset.filename }}</h2>
        <span v-if="counter" class="preview-counter">{{ counter }}</span>
        <div class="preview-header-actions"><slot name="header-actions" /></div>
        <button ref="informationButton" v-if="$slots.information && !referencePicking" class="preview-tool-button preview-information-toggle" aria-label="照片信息" :aria-expanded="informationOpen" title="照片信息" :class="{ active: informationOpen }" @click="informationOpen = !informationOpen"><UiIcon name="info" :size="18" /><span>照片信息</span></button>
        <button ref="closeButton" class="preview-tool-button preview-close" aria-label="关闭预览" :title="`${closeLabel || '返回相册'}（Esc）`" @click="close"><UiIcon name="close" :size="19" /><span>{{ closeLabel || '返回相册' }}</span></button>
      </header>
      <div v-if="$slots.progress" class="preview-progress"><slot name="progress" /></div>
      <div class="preview-content">
        <div class="preview-picture-column">
          <div ref="viewport" class="preview-viewport" :class="{ 'can-preview-pan': photoReady && !fitMode, 'is-preview-dragging': dragging }" :aria-busy="loadingMedia || navigationLoading" @wheel="wheel" @dblclick="doubleClick" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag">
            <div v-if="asset.kind === 'photo' && src && !loading && !failure" :key="asset.id + src" class="detail-media-stage" :style="stageStyle">
              <img ref="photo" :src="src" :data-preview-asset="asset.id" :alt="asset.filename" draggable="false" @load="imageLoaded" @error="previewFailed">
              <slot v-if="faceSelection && mediaReady" name="overlay" />
              <slot v-if="mediaReady && !faceSelection && !referencePicking" name="media-overlay" />
            </div>
            <video v-else-if="asset.kind === 'video' && src && !loading && !failure" ref="video" :key="asset.id + src" class="preview-video" :src="src" :data-preview-asset="asset.id" :poster="poster" controls preload="metadata" @loadedmetadata="videoLoaded" @error="previewFailed"></video>
            <div v-if="loadingMedia" class="preview-placeholder" role="status"><span class="preview-spinner" aria-hidden="true"></span><span>{{ navigationLoading ? '正在切换…' : '正在读取原文件…' }}</span></div>
            <div v-else-if="failure || !src" class="preview-placeholder"><span>{{ failure || '原文件不可用或无法预览' }}</span><button v-if="asset.available" class="preview-retry" aria-label="重试预览" :disabled="loading" @click="retryPreview">重新读取</button></div>
            <button v-if="!referencePicking" class="preview-navigation previous" aria-label="上一项" title="上一项（←）" :disabled="!canPrevious || navigationLoading" @click.stop="navigate('previous')"><UiIcon name="arrow-left" :size="24" /></button>
            <button v-if="!referencePicking" class="preview-navigation next" aria-label="下一项" title="下一项（→）" :disabled="!canNext || navigationLoading" @click.stop="navigate('next')"><UiIcon name="arrow-right" :size="24" /></button>
          </div>
          <div v-if="faceSelection && $slots['face-tools']" class="preview-face-tools"><slot name="face-tools" /></div>
        </div>
        <aside v-if="informationOpen && $slots.information && !referencePicking" ref="informationPanel" class="preview-information" aria-label="照片详细信息">
          <header><strong>照片信息</strong><button class="preview-tool-button" aria-label="关闭照片信息" title="关闭照片信息" @click="closeInformation"><UiIcon name="close" :size="17" /></button></header>
          <div class="preview-information-body"><slot name="information" /></div>
        </aside>
      </div>
      <div v-if="$slots.feedback" class="preview-feedback"><slot name="feedback" :information-open="informationOpen" /></div>
      <footer class="preview-toolbar">
        <span class="preview-caption" :title="caption">{{ caption || (asset.kind === 'video' ? '视频' : '照片') }}</span>
        <div v-if="!referencePicking" class="preview-toolbar-actions"><slot name="toolbar-actions" /></div>
        <div v-if="asset.kind === 'photo'" class="preview-image-tools">
          <button class="preview-tool-button" aria-label="缩小" title="缩小（-）" :disabled="!photoReady || zoom <= minimumZoom" @click="changeZoom(0.8)"><UiIcon name="minus" :size="17" /></button>
          <span class="preview-zoom-value" aria-live="polite">{{ zoomText }}</span>
          <button class="preview-tool-button" aria-label="放大" title="放大（+）" :disabled="!photoReady || zoom >= 8" @click="changeZoom(1.25)"><UiIcon name="plus" :size="17" /></button>
          <span class="preview-tool-divider"></span>
          <button class="preview-tool-button" aria-label="适应窗口" title="适应窗口（0）" :disabled="!photoReady" :class="{ active: fitMode }" @click="fit"><UiIcon name="fit" :size="18" /></button>
          <button class="preview-tool-button preview-actual-size" aria-label="实际大小" title="实际大小（1）" :disabled="!photoReady" :class="{ active: !fitMode && zoom === 1 }" @click="actualSize">1:1</button>
          <button class="preview-tool-button" aria-label="向右旋转" :title="faceSelection ? '选脸时保持原图方向' : '向右旋转，仅改变预览'" :disabled="!photoReady || faceSelection" @click="rotate"><UiIcon name="rotate" :size="18" /></button>
        </div>
        <button class="preview-tool-button preview-fullscreen" :aria-label="fullscreen ? '退出全屏' : '全屏预览'" :title="fullscreen ? '退出全屏' : '全屏预览'" @click="toggleFullscreen"><UiIcon :name="fullscreen ? 'fullscreen-exit' : 'fullscreen'" :size="18" /></button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* 预览按钮避开原生窗口控制区，网页层级不能覆盖 Windows 标题栏按钮。 */
.media-preview-backdrop{inset:var(--app-titlebar-height,0px) 0 0;display:flex;align-items:stretch;justify-content:stretch;padding:12px;background:color-mix(in srgb,var(--theme-preview) 85.10%,transparent);z-index:50;-webkit-app-region:no-drag}
.media-preview-backdrop .media-dialog{display:flex;flex-direction:column;width:100%;height:calc(100dvh - var(--app-titlebar-height,0px) - 24px);max-width:none;max-height:none;min-width:0;min-height:0;padding:0;overflow:hidden;border:1px solid var(--theme-line);border-radius:16px;background:var(--theme-surface);box-shadow:0 14px 48px color-mix(in srgb,var(--theme-ink) 12%,transparent)}
.media-dialog:focus{outline:none}.media-preview-backdrop .media-dialog:fullscreen{width:100vw;height:100dvh;border:0;border-radius:0}
.preview-heading{display:flex;align-items:center;gap:10px;height:48px;min-height:48px;flex:none;padding:0 12px;background:var(--theme-surface);border-bottom:1px solid var(--theme-line)}
.preview-heading h2{flex:1;min-width:0;margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:1.3;font-weight:600;color:var(--theme-ink)}
.preview-counter{flex:none;font-size:11px;color:var(--theme-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.preview-header-actions{display:flex;align-items:center;gap:6px;flex:none;max-width:50%;min-width:0}
.preview-header-actions:empty{display:none}.preview-header-actions :deep(button){min-height:30px;padding:5px 9px;font-size:11px;white-space:nowrap}
.preview-tool-button{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;min-height:32px;flex:none;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--theme-secondary);cursor:pointer;font:inherit}
.preview-tool-button:hover:not(:disabled),.preview-tool-button.active{background:var(--theme-selected);border-color:var(--theme-line);color:var(--theme-on-primary)}.preview-tool-button:focus-visible,.preview-navigation:focus-visible,.preview-retry:focus-visible{outline:2px solid var(--theme-focus);outline-offset:2px}
.preview-tool-button:disabled{opacity:.35;cursor:default}
.preview-information-toggle,.preview-close{width:auto;gap:5px;padding:0 8px;font-size:11px;white-space:nowrap}
.preview-progress{flex:none;max-height:100px;overflow-y:auto;padding:6px 14px;border-bottom:1px solid var(--theme-line);color:var(--theme-secondary);font-size:11px;overflow-wrap:anywhere}
.preview-progress:empty{display:none}.preview-progress :deep(.reference-picker-progress){margin:0;display:flex;align-items:center;justify-content:space-between;gap:8px}.preview-progress :deep(button){min-height:28px;padding:4px 8px;font-size:11px}.preview-progress :deep(p){margin:5px 0 0;font-size:11px}
.preview-content{position:relative;display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;background:var(--theme-preview)}
.preview-picture-column{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}
.preview-viewport{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;overscroll-behavior:contain;background:var(--theme-preview);touch-action:none;user-select:none}
.preview-viewport.can-preview-pan{cursor:grab}.preview-viewport.is-preview-dragging{cursor:grabbing}
.media-dialog .detail-media-stage{position:absolute;margin:0;max-width:none;max-height:none;aspect-ratio:auto;background:transparent;border-radius:0;transform-origin:center;will-change:transform,left,top}
.media-dialog .detail-media-stage>img{display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:fill;pointer-events:none;user-select:none}
.preview-video{display:block;position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;background:var(--theme-preview)}
.preview-placeholder{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:48px 56px;text-align:center;color:var(--theme-preview-text);font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.preview-spinner{width:22px;height:22px;border:2px solid color-mix(in srgb,var(--theme-muted) 40.00%,transparent);border-top-color:var(--theme-line);border-radius:50%;animation:preview-spin .8s linear infinite}
.preview-retry{border:1px solid var(--theme-muted);border-radius:6px;background:var(--theme-preview-control);color:var(--theme-preview-text);padding:6px 12px;font-size:12px;cursor:pointer}
.preview-navigation{position:absolute;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:38px;height:58px;min-height:0;z-index:2;padding:0;border:1px solid color-mix(in srgb,var(--theme-muted) 20.00%,transparent);border-radius:7px;background:color-mix(in srgb,var(--theme-preview) 78.82%,transparent);color:var(--theme-preview-text);cursor:pointer}
.preview-navigation.previous{left:12px}.preview-navigation.next{right:12px}.preview-navigation:hover:not(:disabled){background:color-mix(in srgb,var(--theme-preview-control) 92.16%,transparent);border-color:color-mix(in srgb,var(--theme-muted) 40.00%,transparent)}.preview-navigation:disabled{opacity:.22;cursor:default}
.preview-face-tools{flex:none;max-height:min(180px,30vh);padding:8px 14px;overflow:auto;overscroll-behavior:contain;background:var(--theme-background);border-top:1px solid var(--theme-line);font-size:11px}
.preview-face-tools :deep(p){margin:5px 0;font-size:11px}.preview-face-tools :deep(.face-actions){margin-top:6px;gap:6px}.preview-face-tools :deep(.face-actions button){min-height:30px;padding:5px 9px}.preview-face-tools :deep(.face-actions select){height:30px;min-height:30px;padding-top:3px;padding-bottom:3px}
.preview-information{display:flex;flex-direction:column;flex:0 0 300px;width:300px;min-width:0;min-height:0;background:var(--theme-surface);border-left:1px solid var(--theme-line)}
.preview-information>header{display:flex;align-items:center;justify-content:space-between;height:42px;padding:0 12px;flex:none;border-bottom:1px solid var(--theme-line);font-size:12px;color:var(--theme-ink)}
.preview-information-body{min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:0 14px 14px;font-size:12px;overflow-wrap:anywhere}
.preview-information-body :deep(.detail-metadata){font-size:11px;line-height:1.7}.preview-information-body :deep(.detail-metadata>div){padding:9px 0}.preview-information-body :deep(.field){margin-top:12px;gap:6px}.preview-information-body :deep(.field span){font-size:11px}.preview-information-body :deep(button){min-height:32px;font-size:11px;padding:6px 10px;margin-top:6px}.preview-information-body :deep(.section-tip),.preview-information-body :deep(.error-text){font-size:11px;line-height:1.7}
.preview-feedback{flex:none;max-height:64px;overflow-y:auto;background:var(--theme-surface)}.preview-feedback:empty{display:none}.preview-feedback :deep(p){margin:0;padding:6px 14px;font-size:11px}
.preview-toolbar{display:flex;align-items:center;gap:10px;flex:none;height:48px;min-height:48px;padding:0 12px;border-top:1px solid var(--theme-line);background:var(--theme-surface)}
.preview-caption{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--theme-muted);font-size:11px}
.preview-toolbar-actions{display:flex;align-items:center;flex:none}.preview-toolbar-actions:empty{display:none}.preview-toolbar-actions :deep(button){padding:4px 6px;font-size:11px;white-space:nowrap}
.preview-image-tools{display:flex;align-items:center;gap:3px;flex:none}.preview-zoom-value{width:49px;text-align:center;color:var(--theme-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.preview-tool-divider{width:1px;height:18px;background:var(--theme-selected);margin:0 4px}.preview-actual-size{font-size:11px;font-weight:600}.preview-fullscreen{margin-left:4px}
@keyframes preview-spin{to{transform:rotate(360deg)}}
@media(max-width:760px){.media-preview-backdrop{padding:6px}.media-preview-backdrop .media-dialog{height:calc(100dvh - var(--app-titlebar-height,0px) - 12px);border-radius:16px;box-shadow:0 14px 48px color-mix(in srgb,var(--theme-ink) 12%,transparent)}.preview-information{position:absolute;inset:0 0 0 auto;z-index:4;width:min(300px,calc(100% - 28px));box-shadow:-8px 0 25px color-mix(in srgb,var(--theme-ink) 20.00%,transparent)}.preview-heading{gap:6px;padding:0 8px}.preview-heading h2{font-size:12px}.preview-counter{font-size:10px}.preview-header-actions{max-width:46%}.preview-header-actions :deep(button){padding:4px 6px;font-size:10px}.preview-toolbar{gap:3px;padding:0 8px}.preview-caption{font-size:10px}.preview-image-tools{gap:1px}.preview-tool-button{width:30px;height:30px;min-height:30px}.preview-information-toggle,.preview-close{width:auto;padding:0 6px;gap:4px;font-size:10px}.preview-tool-divider{margin:0 2px}.preview-zoom-value{width:43px}.preview-navigation{width:32px;height:50px}.preview-navigation.previous{left:7px}.preview-navigation.next{right:7px}.preview-face-tools{padding:7px 10px;max-height:min(160px,30vh)}}
@media(max-width:450px){.preview-heading{gap:3px}.preview-heading h2{font-size:11px}.preview-counter{max-width:48px;overflow:hidden}.preview-header-actions{max-width:43%}.preview-caption{display:none}.preview-toolbar{justify-content:center}.preview-navigation{width:28px;height:46px}.preview-image-tools{gap:2px}.preview-fullscreen{margin-left:3px}.preview-progress{padding:5px 10px}.preview-face-tools{max-height:30vh}}
@media(prefers-reduced-motion:reduce){.preview-spinner{animation:none}}
</style>
