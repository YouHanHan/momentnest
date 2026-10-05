<script setup lang="ts">
import { inject, onBeforeUnmount, provide, ref, watch } from 'vue'
import { NPopover } from 'naive-ui'
import { addUiLayer, removeUiLayer, uiPopupOwner } from '../ui-layers'
import UiProvider from './UiProvider.vue'

const props = withDefaults(defineProps<{ label: string; contentClass?: string; placement?: 'bottom-start' | 'bottom-end' | 'bottom' | 'right-start' | 'left-start'; width?: number }>(), { placement: 'bottom-end' })
const show = defineModel<boolean>('show', { default: false })
const host = ref<HTMLElement>(), id = Symbol('popover'), parent = inject(uiPopupOwner, undefined)
const maxHeight = ref(420)
provide(uiPopupOwner, id)
function close(): void { show.value = false }
function focus(): void { host.value?.querySelector<HTMLElement>('button[aria-expanded],button')?.focus({ preventScroll: true }) }
/** 菜单保持在入口旁；下方空间不足时内部滚动，避免翻转遮住固定顶栏。 */
watch(show, open => {
  if (open) {
    const bounds = host.value?.getBoundingClientRect()
    maxHeight.value = Math.max(80, window.innerHeight - (props.placement.startsWith('bottom') ? bounds?.bottom ?? 0 : bounds?.top ?? 0) - 24)
    addUiLayer({ id, parent, kind: 'popup', close, focus })
  } else removeUiLayer(id)
}, { flush: 'sync' })
onBeforeUnmount(() => removeUiLayer(id))
</script>

<template>
  <div ref="host" class="ui-popover" :data-open="show">
    <UiProvider><NPopover v-model:show="show" trigger="click" :placement="placement" :width="width" :show-arrow="false" :z-index="5000" :overlap="false" :animated="false" :flip="!placement.startsWith('bottom')">
      <template #trigger><slot name="trigger" :open="show" /></template>
      <div class="ui-popover-content" :class="contentClass" :aria-label="label" :style="{maxHeight:`${maxHeight}px`,overflowY:'auto'}"><slot :close="close" /></div>
    </NPopover></UiProvider>
  </div>
</template>

<style scoped>.ui-popover{display:inline-flex;min-width:0}.ui-popover-content{max-width:calc(100vw - 36px);min-width:0}</style>
