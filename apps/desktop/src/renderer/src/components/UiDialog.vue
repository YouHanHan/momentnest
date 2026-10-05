<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue'
import { NModal } from 'naive-ui'
import { addUiLayer, closeUiPopups, removeUiLayer } from '../ui-layers'
import UiProvider from './UiProvider.vue'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ label: string; contentClass?: string; suspended?: boolean; closeDisabled?: boolean }>(), { suspended: false, closeDisabled: false })
const emit = defineEmits<{ close: []; opened: [element: HTMLElement] }>()
const attrs = useAttrs(), host = ref<HTMLElement>(), id = Symbol('dialog')
function close(): void { if (!props.suspended && !props.closeDisabled) emit('close') }
async function opened(): Promise<void> { await nextTick(); if (!props.suspended && host.value) emit('opened', host.value) }
function activate(): void { if (props.suspended) removeUiLayer(id); else { closeUiPopups(); addUiLayer({ id, kind: 'dialog', close }) } }
watch(() => props.suspended, activate)
// 首次挂载可能没有入场动画，仍需初始化业务弹窗引用与焦点。
onMounted(() => { activate(); void opened() }); onBeforeUnmount(() => removeUiLayer(id))
defineExpose({ get element() { return host.value } })
</script>

<template>
  <UiProvider><NModal :show="!suspended" display-directive="show" :trap-focus="true" :auto-focus="true" :close-on-esc="false" :mask-closable="false" transform-origin="center" :z-index="2500" @mask-click="close" @after-enter="opened">
    <div ref="host" class="ui-dialog-surface" :class="[contentClass,attrs.class]" :style="attrs.style" role="dialog" aria-modal="true" :aria-label="label" :aria-busy="attrs['aria-busy']===true||attrs['aria-busy']==='true'" tabindex="-1" @keydown="attrs.onKeydown&&typeof attrs.onKeydown==='function'&&attrs.onKeydown($event)"><slot /></div>
  </NModal></UiProvider>
</template>

<style>
.n-modal-body-wrapper{box-sizing:border-box;padding:72px 18px 18px}
.ui-dialog-surface{box-sizing:border-box;position:relative;display:flex;flex-direction:column;width:min(480px,calc(100vw - 36px));max-height:calc(100dvh - 96px)!important;margin:auto!important;overflow:visible!important;background:#fff;color:#27332d;border:1px solid #dce5df;border-radius:12px;box-shadow:0 20px 64px #172d222e}
.n-modal-mask{background-color:#172d225e!important}
@media(prefers-reduced-motion:reduce){.n-modal,.n-modal-mask,.n-popover,.n-date-panel,.n-base-select-menu{transition-duration:0s!important;animation-duration:0s!important}}
</style>
