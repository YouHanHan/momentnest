<script setup lang="ts" generic="T extends string">
import { computed, inject, onBeforeUnmount, ref, useAttrs, watch } from 'vue'
import { NSelect } from 'naive-ui'
import type { SelectProps } from 'naive-ui'
import { addUiLayer, removeUiLayer, uiPopupOwner } from '../ui-layers'
import UiProvider from './UiProvider.vue'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ options: { label: string; value: T; disabled?: boolean }[]; label?: string; disabled?: boolean; filterable?: boolean; placeholder?: string }>(), { disabled: false, filterable: false, placeholder: '请选择' })
const value = defineModel<T>({ required: true })
const attrs = useAttrs(), host = ref<HTMLElement>(), show = ref(false)
const id = Symbol('select'), parent = inject(uiPopupOwner, undefined)
const label = computed(() => props.label || String(attrs['aria-label'] || ''))
const popupTarget = computed(() => host.value?.closest<HTMLElement>('.n-modal,.media-dialog,.n-popover') || undefined)
const nodeProps: NonNullable<SelectProps['nodeProps']> = option => ({ role: 'option', 'data-key': option.value, 'aria-selected': option.value === value.value })
function close(): void { show.value = false }
function focus(): void { host.value?.querySelector<HTMLElement>('.n-base-selection')?.focus({ preventScroll: true }) }
watch(show, open => { if (open) addUiLayer({ id, parent, kind: 'picker', close, focus }); else removeUiLayer(id) }, { flush: 'sync' })
onBeforeUnmount(() => removeUiLayer(id))
</script>

<template>
  <div ref="host" class="ui-select" :class="attrs.class" :style="attrs.style" :data-control-label="label" :data-value="value">
    <UiProvider><NSelect v-model:value="value" v-model:show="show" :options="options" :disabled="disabled" :filterable="filterable||options.length>12" :placeholder="placeholder" :node-props="nodeProps" :to="popupTarget" :input-props="{ 'aria-label': label ? `${label}搜索` : '搜索选项' }" role="combobox" :aria-label="label||undefined" :aria-expanded="show" size="small" /></UiProvider>
  </div>
</template>

<style scoped>.ui-select{min-width:0;max-width:100%}</style>
