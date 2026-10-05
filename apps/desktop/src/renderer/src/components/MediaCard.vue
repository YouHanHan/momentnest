<script setup lang="ts">
import type { MediaAsset } from '../../../shared/family'
import UiIcon from './UiIcon.vue'
import GrowthWatermarkStamp from './GrowthWatermarkStamp.vue'
import type { GrowthStamp } from '../family-ui'

defineProps<{ asset: MediaAsset; thumbnail?: string; selected: boolean; age?: string; stamp?: GrowthStamp | null; selectionMode?: boolean; candidate?: boolean; status?: string; reference?: boolean }>()
defineEmits<{ open: [asset: MediaAsset]; select: [asset: MediaAsset]; favorite: [asset: MediaAsset]; 'thumbnail-error': [asset: MediaAsset] }>()

const duration = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const dateLabel = (asset: MediaAsset) => ({ capture: '拍摄日期', creation: '文件创建日期', manual: '手动确认日期', unknown: '日期未知' })[asset.dateSource]
</script>

<template>
  <article class="media-card" :class="{ 'is-selected': selected, 'is-missing': !asset.available, 'selection-mode': selectionMode }">
    <button class="media-cover" @click="selectionMode ? $emit('select', asset) : $emit('open', asset)" :aria-label="`查看${asset.kind === 'video' ? '视频' : '照片'} ${asset.filename}`">
      <img v-if="thumbnail" :src="thumbnail" :alt="asset.filename" loading="lazy" @error="$emit('thumbnail-error',asset)">
      <span v-else class="media-placeholder"><UiIcon :name="asset.kind === 'video' ? 'play' : 'photo'" :size="32" /></span>
      <span v-if="asset.kind === 'video'" class="media-duration"><UiIcon name="camera" :size="11" />{{ duration(asset.duration) }}</span>
      <span v-if="age" class="media-age">{{ age }}</span>
      <GrowthWatermarkStamp v-if="stamp&&thumbnail" :stamp="stamp" />
      <span v-if="status||candidate" class="media-candidate" :class="{'media-confirmed':status==='人工确认','media-automatic':status==='自动匹配','above-growth-stamp':stamp&&thumbnail}">{{status||(candidate?'待确认':'')}}</span>
      <span v-if="reference" class="media-reference">已作参考</span>
      <span v-if="!asset.available" class="media-unavailable">{{ asset.locations.some(location => location.unavailableReason === 'changed') ? '原文件已变化' : '原文件不可用' }}</span>
    </button>
    <button class="media-select" :class="{ checked: selected }" :aria-pressed="selected" :aria-label="`选择 ${asset.filename}`" @click="$emit('select', asset)"><UiIcon v-if="selected" name="check" :size="16" /></button>
    <button class="media-favorite" :class="{ checked: asset.favorite }" :aria-pressed="asset.favorite" :aria-label="`${asset.favorite ? '取消收藏' : '收藏'} ${asset.filename}`" @click="$emit('favorite', asset)"><UiIcon name="heart" :size="15" /></button>
    <div class="media-card-info"><strong :title="asset.filename">{{ asset.filename }}</strong><span>{{ asset.date ?? '日期待确认' }} · {{ dateLabel(asset) }}</span><small>{{ asset.locations.map(item => item.source === 'phone' ? '手机' : '电脑文件夹').filter((value, index, all) => all.indexOf(value) === index).join(' / ') }}</small></div>
  </article>
</template>

<style scoped>
.media-candidate{position:absolute;left:6px;bottom:6px;padding:3px 6px;border-radius:4px;background:rgba(255,255,255,.94);color:#89672d;font-size:11px;line-height:1.4;pointer-events:none}.media-age~.media-candidate{bottom:34px}
.media-confirmed{color:#32664b}.media-automatic{color:#617467}.media-reference{position:absolute;left:6px;top:38px;padding:2px 5px;border-radius:4px;background:#edf5efe8;color:#426951;font-size:10px;pointer-events:none}
.media-candidate.above-growth-stamp{bottom:auto;top:6px;left:36px;max-width:calc(100% - 72px);white-space:nowrap;font-size:9px;padding:2px 4px}
</style>
