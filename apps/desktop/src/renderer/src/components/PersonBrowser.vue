<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type { PersonProfile } from '../../../shared/family'
import FaceAvatar from './FaceAvatar.vue'

const props = withDefaults(defineProps<{ people: PersonProfile[]; libraryId?: string; search: string; mergeMode?: boolean; selectedId?: string; disabled?: boolean }>(), { mergeMode: false, selectedId: '', disabled: false })
defineEmits<{ select: [id: string]; rename: [id: string, name: string]; merge: [id: string] }>()
const shown = ref(40), urls = reactive<Record<string, string>>({}), failed = reactive(new Set<string>()), retryNonce = ref(0)
let generation = 0
const matches = computed(() => props.people.filter(person => (person.name || '未命名人物').toLocaleLowerCase().includes(props.search.trim().toLocaleLowerCase())))
const visible = computed(() => matches.value.slice(0, shown.value))

/** 人物头像只读取当前库的缩略图，切库后丢弃旧响应和缓存。 */
watch(() => props.libraryId, () => { generation++; shown.value = 40; failed.clear(); for (const id of Object.keys(urls)) delete urls[id] })
watch(() => props.search, () => { shown.value = 40 })
watch(() => JSON.stringify({ libraryId: props.libraryId, assets: visible.value.map(person => person.reference?.assetId), retry: retryNonce.value }), async () => {
  const current = ++generation, libraryId = props.libraryId
  const ids = [...new Set(visible.value.map(person => person.reference?.assetId).filter((id): id is string => Boolean(id)))].filter(id => !urls[id] && !failed.has(id))
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, async () => {
    while (cursor < ids.length && current === generation) {
      const id = ids[cursor++]
      try { const url = await window.jinchuan?.mediaUrl(id, true, libraryId); if (current === generation && libraryId === props.libraryId && url) urls[id] = url }
      catch { if (current === generation) failed.add(id) }
    }
  }))
}, { immediate: true })
onUnmounted(() => { generation++ })
</script>

<template>
  <div class="person-browser">
    <div class="person-grid">
      <article v-for="(person,index) in visible" :key="person.id" class="person-card" :data-person-id="person.id" :class="{'is-selected':mergeMode&&selectedId===person.id}">
        <button class="person-open" :aria-label="mergeMode?`选择合并到人物 ${person.name||`未命名人物 ${index+1}`}`:`查看人物 ${person.name||`未命名人物 ${index+1}`} 的照片`" :aria-pressed="mergeMode?selectedId===person.id:undefined" :disabled="disabled" @click="$emit('select',person.id)">
          <FaceAvatar :src="person.reference?urls[person.reference.assetId]:undefined" :face="person.reference?.face" :kind="person.reference?.kind" :label="person.name||'未命名人物'" :size="76" />
          <strong>{{person.name||`未命名人物 ${index+1}`}}</strong><small>{{person.assetCount}} 张照片与视频</small>
          <span v-if="mergeMode&&selectedId===person.id" class="person-selected" aria-hidden="true">✓</span>
        </button>
        <div v-if="!mergeMode" class="person-actions"><button class="person-rename" :disabled="disabled" @click="$emit('rename',person.id,person.name)">{{person.name?'修改名称':'命名'}}</button><button class="person-merge" :disabled="disabled" :aria-label="`合并人物 ${person.name||`未命名人物 ${index+1}`}`" @click="$emit('merge',person.id)">合并</button></div>
      </article>
    </div>
    <p v-if="!matches.length" class="section-tip">{{search?'没有符合名称的人物。':mergeMode?'当前照片库没有其他可合并人物。':'尚未检测到人物，分析完成后会在这里显示头像和分组。'}}</p>
    <button v-if="shown<matches.length" class="secondary-button person-more" :disabled="disabled" @click="shown+=40">查看更多人物 · 还有 {{matches.length-shown}} 组</button>
    <button v-if="failed.size" class="text-button person-more" :disabled="disabled" @click="failed.clear();retryNonce++">重试加载 {{failed.size}} 个头像</button>
  </div>
</template>

<style scoped>
.person-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;padding:8px 0 16px}.person-card{min-width:0;border:1px solid #e5eae6;border-radius:10px;background:#fff;overflow:hidden}.person-open{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;padding:16px 8px 10px;background:transparent;border:0;cursor:pointer}.person-open:hover{background:#f6f8f8}.person-open strong{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:#26342e}.person-open small{font-size:11px;color:#718078}.person-actions{display:flex;border-top:1px solid #edf2f0;background:#fafbfa}.person-rename,.person-merge{display:block;min-width:0;border:0;padding:8px;background:transparent;color:#3b755c;font:inherit;font-size:12px;cursor:pointer}.person-rename{flex:1}.person-merge{padding:8px 12px;border-left:1px solid #edf2f0}.person-rename:hover,.person-merge:hover{background:#edf2f0}.person-card.is-selected{border-color:#3b755c;box-shadow:inset 0 0 0 1px #3b755c;background:#edf4ef}.person-selected{position:absolute;right:8px;top:8px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#3b755c;color:#fff;font-size:12px}.person-more{display:block;margin:0 auto 16px}.person-open:focus-visible,.person-rename:focus-visible,.person-merge:focus-visible{outline:2px solid #3b755c;outline-offset:-3px}
</style>
