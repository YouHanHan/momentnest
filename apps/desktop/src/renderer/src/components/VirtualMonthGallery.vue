<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { MediaAsset } from '../../../shared/family'
import MediaCard from './MediaCard.vue'
import UiIcon from './UiIcon.vue'
import UiProvider from './UiProvider.vue'
import type { GrowthStamp } from '../family-ui'

const props = defineProps<{
  groups: { key: string; label: string; assets: MediaAsset[] }[]
  collapsed: (key: string) => boolean; folding: boolean
  thumbnails: Record<string, string>; selected: Map<string, MediaAsset>; selectionMode: boolean
  status: (asset: MediaAsset) => string; reference: (asset: MediaAsset) => boolean
  stamp?: (asset: MediaAsset) => GrowthStamp | null
}>()
const emit = defineEmits<{ toggle: [string, MouseEvent]; open: [MediaAsset]; select: [MediaAsset]; favorite: [MediaAsset]; visible: [MediaAsset[]]; 'thumbnail-error': [MediaAsset] }>()
const host = ref<HTMLElement | null>(null), width = ref(1), viewport = ref({ top: 0, bottom: 0 })
const windowWidth = ref(window.innerWidth), offsets = ref(new Map<string, number>()), stickyTop = ref(0)
let scroll: HTMLElement | null = null, resize: ResizeObserver | undefined, frame = 0, disposed = false
const gridGap = 8
const columns = computed(() => windowWidth.value <= 450 ? 2 : windowWidth.value <= 760 ? 3 : 4)
// 行高与 CSS 间距共用同一值，保证虚拟滚动定位与四列照片布局一致。
const rowHeight = computed(() => Math.max(1, (width.value - (columns.value - 1) * gridGap) / columns.value) + gridGap)
const heights = computed(() => new Map(props.groups.map(group => [group.key, Math.ceil(group.assets.length / columns.value) * rowHeight.value - gridGap])))
/** 月份标题保留在文档流，只为当前可视区域及前后缓冲创建照片卡片。 */
const rows = computed(() => new Map<string, { index: number; assets: MediaAsset[] }[]>(props.groups.map(group => {
  if (props.collapsed(group.key)) return [group.key, []]
  const offset = offsets.value.get(group.key) ?? Number.POSITIVE_INFINITY
  const total = Math.ceil(group.assets.length / columns.value)
  const first = Math.max(0, Math.floor((viewport.value.top - offset - 240) / rowHeight.value))
  const last = Math.min(total, Math.ceil((viewport.value.bottom - offset + 240) / rowHeight.value))
  return [group.key, Array.from({ length: Math.max(0, last - first) }, (_, index) => {
    const row = first + index
    return { index: row, assets: group.assets.slice(row * columns.value, (row + 1) * columns.value) }
  })]
})))
const visible = computed(() => [...rows.value.values()].flatMap(group => group.flatMap(row => row.assets)))
function measure(): void {
  if (disposed || !host.value || !scroll) return
  width.value = host.value.clientWidth; windowWidth.value = window.innerWidth
  // 抵消滚动容器的顶部留白，让月份栏贴住顶栏下沿。
  stickyTop.value = -Number.parseFloat(window.getComputedStyle(scroll).paddingTop) || 0
  const bounds = scroll.getBoundingClientRect()
  viewport.value = { top: scroll.scrollTop, bottom: scroll.scrollTop + scroll.clientHeight }
  const next = new Map<string, number>()
  for (const grid of host.value.querySelectorAll<HTMLElement>('[data-month-grid]')) next.set(grid.dataset.monthGrid!, grid.getClientRects().length ? grid.getBoundingClientRect().top - bounds.top + scroll.scrollTop : Number.POSITIVE_INFINITY)
  offsets.value = next
}
function schedule(): void { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
watch(() => [props.groups, props.folding, props.groups.map(group => props.collapsed(group.key)).join(','), columns.value], async () => { await nextTick(); schedule() }, { flush: 'post' })
watch(() => visible.value.map(asset => asset.id).join(','), () => emit('visible', visible.value), { flush: 'post' })
onMounted(() => {
  scroll = host.value?.closest<HTMLElement>('.page-content') ?? null
  scroll?.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule)
  resize = new ResizeObserver(schedule); if (host.value) resize.observe(host.value)
  measure(); void nextTick(schedule)
})
onUnmounted(() => { disposed = true; cancelAnimationFrame(frame); resize?.disconnect(); scroll?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule) })
defineExpose({ refresh: schedule })
</script>

<template>
  <div ref="host" class="virtual-month-gallery" :style="{'--month-sticky-top':`${stickyTop}px`,'--gallery-gap':`${gridGap}px`}">
    <section v-for="group in groups" :key="group.key" class="media-date-group">
      <UiProvider><NButton class="date-group-heading month-group-toggle" quaternary :aria-expanded="!collapsed(group.key)" :aria-controls="`month-media-${group.key}`" :disabled="folding" @click="emit('toggle',group.key,$event)"><UiIcon name="chevron" :size="16" :class="{'month-chevron-collapsed':collapsed(group.key)}" /><h2>{{group.label}}</h2><span class="month-item-count">已加载 {{group.assets.length}} 项</span></NButton></UiProvider>
      <div v-show="!collapsed(group.key)" :id="`month-media-${group.key}`" class="media-grid virtual-media-grid" :data-month-grid="group.key" :style="{height:`${heights.get(group.key)}px`}">
        <div v-for="row in rows.get(group.key)" :key="row.index" class="virtual-media-row" :style="{top:`${row.index*rowHeight}px`,gridTemplateColumns:`repeat(${columns},minmax(0,1fr))`}">
          <MediaCard v-for="asset in row.assets" :key="asset.id" :asset="asset" :thumbnail="thumbnails[asset.id]" :selected="selected.has(asset.id)" :selection-mode="selectionMode" :status="status(asset)" :reference="reference(asset)" :stamp="stamp?.(asset)" @open="emit('open',$event)" @select="emit('select',$event)" @favorite="emit('favorite',$event)" @thumbnail-error="emit('thumbnail-error',$event)" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.virtual-media-grid{display:block;position:relative;contain:layout style}.virtual-media-row{display:grid;gap:var(--gallery-gap);position:absolute;left:0;right:0}.virtual-media-row :deep(.media-card){min-width:0}
/* 月份栏在本组照片滚动时吸顶，下一月份到达时自然接替，并遮住下方缩略图。 */
.month-group-toggle.n-button{position:sticky;top:var(--month-sticky-top,0px);z-index:2;background:var(--theme-surface);box-shadow:0 1px 0 var(--theme-selected)}
.month-group-toggle.n-button{width:100%;height:36px;min-height:36px;align-items:center;padding:0 var(--gallery-row-padding,10px);margin:0 0 6px;text-align:left;border:0;border-radius:8px;color:var(--theme-ink)}.month-group-toggle :deep(.n-button__content){display:flex;align-items:center;justify-content:flex-start;width:100%;min-width:0;gap:var(--gallery-heading-gap,9px);color:inherit;font-size:inherit}.month-group-toggle .ui-icon{flex:none;color:var(--theme-muted)}.month-group-toggle h2{margin:0;font:600 15px/1.4 "Microsoft YaHei UI",sans-serif;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.month-group-toggle .month-item-count{margin-left:auto;flex:none;border-radius:5px;padding:3px 7px;background:var(--theme-raised);color:var(--theme-muted);font-size:10px;font-weight:400;line-height:1.4}.month-group-toggle[aria-expanded=false]{background:var(--theme-background)}.month-chevron-collapsed{transform:rotate(-90deg)}.month-group-toggle:focus-visible{outline:2px solid var(--theme-accent);outline-offset:2px}
@media(max-width:450px){.month-group-toggle h2{font-size:14px}.month-group-toggle .month-item-count{padding:3px 5px;font-size:9px}}
</style>
