<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, useAttrs, watch } from 'vue'
import { NDatePicker, NInput, NPopover } from 'naive-ui'
import { addUiLayer, removeUiLayer, uiPopupOwner } from '../ui-layers'
import UiProvider from './UiProvider.vue'
import UiIcon from './UiIcon.vue'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ label?: string; min?: string; max?: string; disabled?: boolean; required?: boolean; placeholder?: string }>(), { disabled: false, required: false, placeholder: '选择日期' })
const value = defineModel<string>({ required: true })
const emit = defineEmits<{ 'validity-change': [valid: boolean] }>()
const attrs = useAttrs(), host = ref<HTMLElement>(), show = ref(false), invalid = ref('')
const id = Symbol('date-picker'), parent = inject(uiPopupOwner, undefined)
const draft = ref(value.value)
const label = computed(() => props.label || String(attrs['aria-label'] || ''))
const popupTarget = computed(() => host.value?.closest<HTMLElement>('.n-modal,.media-dialog,.n-popover') || undefined)

/** 日期只传年月日字符串；使用本地日历校验，避免时区转换改变拍摄日。 */
function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const [year, month, day] = text.split('-').map(Number), date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}
function inRange(text: string): boolean { return validDate(text) && (!props.min || text >= props.min) && (!props.max || text <= props.max) }
const formattedValue = computed(() => validDate(value.value) ? value.value : null)
function update(text: string | [string, string] | null): void {
  if (props.disabled) return
  if (text === null) { draft.value = ''; value.value = ''; invalid.value = ''; return }
  if (typeof text !== 'string' || !inRange(text)) { invalid.value = '请选择有效且在允许范围内的日期'; return }
  draft.value = text; value.value = text; invalid.value = ''; show.value = false
}
/** 手动输入也检查范围，非法日期不会悄悄沿用旧值并提交档案。 */
function commitInput(): void {
  if (props.disabled) return
  if (!draft.value) { value.value = ''; invalid.value = props.required ? '请选择日期' : ''; return }
  if (!inRange(draft.value)) { invalid.value = '请输入有效且在允许范围内的日期'; bindInput(); return }
  value.value = draft.value; invalid.value = ''
}
function inputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') { event.preventDefault(); commitInput(); if (!invalid.value) show.value = false }
}
function disabledDate(timestamp: number): boolean {
  const date = new Date(timestamp), text = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return !inRange(text)
}
function close(): void { show.value = false }
function focus(): void { host.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }) }
function open(): void { if (!props.disabled) show.value = true }
/** 保留表单标签与 required 校验，中文日历不依赖操作系统原生控件。 */
function bindInput(): void {
  const input = host.value?.querySelector<HTMLInputElement>('input')
  if (!input) return
  const name = label.value || host.value?.closest('label')?.querySelector('span')?.textContent?.trim()
  if (name) input.setAttribute('aria-label', name)
  if (attrs.name) input.name = String(attrs.name)
  input.required = props.required
  input.setCustomValidity(draft.value && !inRange(draft.value) ? '请输入有效且在允许范围内的日期' : '')
}
watch(show, open => { if (open) addUiLayer({ id, parent, kind: 'picker', close, focus }); else removeUiLayer(id) }, { flush: 'sync' })
watch(() => props.disabled, disabled => { if (disabled) close() })
watch(value, text => { draft.value = text; invalid.value = ''; void nextTick(bindInput) })
watch([draft, () => props.min, () => props.max, () => props.required], () => emit('validity-change', draft.value ? inRange(draft.value) : !props.required), { immediate: true, flush: 'sync' })
onMounted(bindInput); onUpdated(bindInput); onBeforeUnmount(() => removeUiLayer(id))
</script>

<template>
  <div ref="host" class="ui-date-picker" :class="attrs.class" :style="attrs.style" :data-control-label="label" :data-value="value" @keydown.capture="inputKeydown">
    <UiProvider><NPopover :show="show" @update:show="show=$event" @clickoutside="close" trigger="manual" :to="popupTarget" :show-arrow="false" placement="bottom-start" :theme-overrides="{ space:'2px' }" :animated="false" :z-index="6000" class="ui-calendar-popover">
      <template #trigger><NInput v-model:value="draft" :disabled="disabled" :placeholder="placeholder" :status="invalid?'error':undefined" :clearable="!required" :input-props="{ 'aria-label':label||undefined, name:attrs.name?String(attrs.name):undefined, required, autocomplete:'off' }" size="small" @click="open" @blur="commitInput" @clear="update(null)"><template #suffix><button type="button" class="ui-calendar-trigger" :aria-label="`打开${label||'日期'}日历`" :aria-expanded="show" :disabled="disabled" @click.stop="open"><UiIcon name="calendar" :size="16" /></button></template></NInput></template>
      <NDatePicker panel :formatted-value="formattedValue" @update:formatted-value="update" type="date" value-format="yyyy-MM-dd" format="yyyy-MM-dd" :first-day-of-week="0" :is-date-disabled="disabledDate" :actions="['now']" />
    </NPopover></UiProvider>
    <span v-if="invalid" class="ui-field-error" role="alert">{{invalid}}</span>
  </div>
</template>

<style scoped>.ui-date-picker{min-width:0;width:100%}.ui-field-error{display:block;font-size:12px;color:var(--theme-error);margin-top:5px}.ui-calendar-trigger{display:flex;align-items:center;justify-content:center;padding:0;width:24px;height:24px;min-height:24px;border:0;background:transparent;color:var(--theme-muted)}</style>
