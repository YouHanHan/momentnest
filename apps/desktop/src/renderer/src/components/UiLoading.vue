<script setup lang="ts">
import { NSpin } from 'naive-ui'
import UiProvider from './UiProvider.vue'
import UiIcon from './UiIcon.vue'

withDefaults(defineProps<{ label: string; size?: number }>(), { size: 16 })
</script>

<template>
  <div class="ui-loading" role="status" aria-live="polite">
    <UiProvider><NSpin :size="size" :stroke-width="16" aria-hidden="true" /></UiProvider>
    <UiIcon class="ui-loading-static" name="clock" :size="size" />
    <span>{{ label }}</span>
    <slot />
  </div>
</template>

<style scoped>
.ui-loading{display:flex;align-items:center;gap:8px;min-height:28px;min-width:0;color:#65786b;font-size:12px;line-height:1.5}.ui-loading>span{min-width:0;overflow-wrap:anywhere}.ui-loading :deep(.n-spin){flex:none}.ui-loading-static{display:none;flex:none}
@media(prefers-reduced-motion:reduce){.ui-loading :deep(.n-spin){display:none}.ui-loading-static{display:block}}
</style>
