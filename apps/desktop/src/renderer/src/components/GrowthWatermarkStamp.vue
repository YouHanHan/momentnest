<script setup lang="ts">
import type { GrowthStamp } from '../family-ui'

defineProps<{ stamp: GrowthStamp }>()
</script>

<template>
  <span class="growth-watermark-stamp" :aria-label="`${stamp.age}，拍摄于 ${stamp.date}`">
    <span class="growth-stamp-text"><strong>{{ stamp.age }}</strong><small>{{ stamp.date }}</small></span>
  </span>
</template>

<style scoped>
.growth-watermark-stamp{position:absolute;inset:0;container-type:size;pointer-events:none;text-align:left;color:#fff;user-select:none}
.growth-stamp-text{position:absolute;left:5%;right:5%;bottom:5%;display:flex;flex-direction:column;gap:min(3px,1.5cqh);isolation:isolate;text-shadow:0 1px 4px #0006}
.growth-stamp-text::before{content:"";position:absolute;inset:-45% -6% -55%;z-index:-1;background:radial-gradient(ellipse at 30% 70%,#0006,transparent 72%);pointer-events:none}
.growth-stamp-text strong{font-size:min(max(10px,6cqmin),20cqh);font-weight:700;line-height:1.35;overflow-wrap:anywhere}
.growth-stamp-text small{font-size:min(max(8px,4cqmin),14cqh);font-weight:600;line-height:1.3;letter-spacing:.06em;opacity:.9}
</style>
