<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PersonProfile } from '../../../shared/family'
import { closePopupMenus } from '../popup-dismiss'
import FaceAvatar from './FaceAvatar.vue'
import PersonBrowser from './PersonBrowser.vue'
import UiDialog from './UiDialog.vue'

const props = defineProps<{ people: PersonProfile[]; sourceId: string; libraryId?: string; busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; confirm: [targetId: string] }>()
const source = computed(() => props.people.find(person => person.id === props.sourceId))
const targets = computed(() => props.people.filter(person => person.id !== props.sourceId))
const selectedId = ref(''), search = ref(''), sourceUrl = ref(''), sourceFailed = ref(false), sourceRetry = ref(0)
const selected = computed(() => targets.value.find(person => person.id === selectedId.value))
const searchInput = ref<HTMLInputElement | null>(null)
let avatarGeneration = 0

/** 来源或照片库改变时清空目标，避免将旧选择应用到另一个人物。 */
watch(() => [props.sourceId, props.libraryId], () => { selectedId.value = ''; search.value = '' })
watch(() => targets.value.map(person => person.id), ids => { if (!ids.includes(selectedId.value)) selectedId.value = '' })

/** 来源头像读取当前库，迟到响应不能覆盖新人物的头像。 */
watch(() => [props.libraryId, source.value?.reference?.assetId, sourceRetry.value], async () => {
  const current = ++avatarGeneration, libraryId = props.libraryId, assetId = source.value?.reference?.assetId
  sourceUrl.value = ''; sourceFailed.value = false
  if (!assetId) return
  try {
    const url = await window.momentnest?.mediaUrl(assetId, true, libraryId)
    if (current === avatarGeneration && libraryId === props.libraryId && url) sourceUrl.value = url
  } catch { if (current === avatarGeneration) sourceFailed.value = true }
}, { immediate: true })

function close(): void { emit('close') }
function confirm(): void { if (!props.busy && source.value && selected.value) emit('confirm', selected.value.id) }

/** 对话框支持键盘取消，并让 Tab 聚焦保持在当前操作区域。 */
function opened(): void { searchInput.value?.focus({ preventScroll: true }) }

onMounted(closePopupMenus)
onUnmounted(() => { avatarGeneration++ })
</script>

<template>
  <UiDialog label="合并人物" content-class="family-dialog person-merge-dialog" @close="close" @opened="opened">
      <header class="merge-heading"><h2>合并人物</h2><button class="text-button" @click="close">关闭</button></header>
      <div class="merge-source"><FaceAvatar :src="sourceUrl" :face="source?.reference?.face" :kind="source?.reference?.kind" :label="source?.name||'待合并人物'" :size="48" /><div><small>待合并的人物</small><strong>{{source?.name||'未命名人物'}}</strong><span>{{source?.assetCount??0}} 张照片与视频</span></div><button v-if="sourceFailed" class="text-button" :disabled="busy" @click="sourceRetry++">重试头像</button></div>
      <p class="merge-note">请核对头像，选择同一个人。共享人物记录会在其他照片库中同时生效；原照片和宝宝相册归属保留。</p>
      <label class="merge-search"><span>搜索目标人物</span><input ref="searchInput" v-model="search" type="search" placeholder="搜索人物名称" :disabled="busy" maxlength="32"></label>
      <div class="merge-targets"><PersonBrowser :people="targets" :library-id="libraryId" :search="search" merge-mode :selected-id="selectedId" :disabled="busy" @select="selectedId=$event" /></div>
      <p v-if="error||!source" class="merge-error error-text" role="alert">{{error||'这个人物已变化，请关闭后重新选择。'}}</p>
      <footer class="merge-footer"><span>{{selected?`合并到：${selected.name||'未命名人物'}`:'选择一个目标人物'}}</span><button class="secondary-button" @click="close">取消</button><button class="primary-button" :disabled="busy||!source||!selected" @click="confirm">{{busy?'正在合并…':'确认合并'}}</button></footer>
  </UiDialog>
</template>

<style scoped>
:global(.person-merge-dialog){display:flex;flex-direction:column;width:min(680px,calc(100vw - 40px));max-height:calc(100dvh - 40px);padding:20px;overflow:hidden}.merge-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none}.merge-heading h2{font-size:18px;margin:0}.merge-source{display:flex;align-items:center;gap:12px;flex:none;padding:12px 0;border-bottom:1px solid var(--theme-line)}.merge-source>div{display:flex;flex-direction:column;gap:3px;min-width:0}.merge-source strong{font-size:13px;color:var(--theme-ink);overflow-wrap:anywhere}.merge-source small,.merge-source span{color:var(--theme-muted);font-size:11px}.merge-source button{margin-left:auto}.merge-note{flex:none;margin:12px 0;color:var(--theme-muted);font-size:11px;line-height:1.7;overflow-wrap:anywhere}.merge-search{display:flex;align-items:center;gap:12px;flex:none;margin:0 0 8px;font-size:12px;color:var(--theme-secondary)}.merge-search input{flex:1;min-width:0;width:100%;height:34px;padding:6px 10px;border:1px solid var(--theme-line);border-radius:8px;background:var(--theme-surface);color:var(--theme-ink);font:inherit}.merge-targets{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.merge-error{flex:none;margin:8px 0;font-size:12px;overflow-wrap:anywhere}.merge-footer{display:flex;align-items:center;gap:8px;flex:none;padding-top:12px;border-top:1px solid var(--theme-line)}.merge-footer>span{flex:1;min-width:0;color:var(--theme-secondary);font-size:12px;overflow-wrap:anywhere}.merge-footer button{min-height:34px;padding:7px 12px;font-size:12px}:global(.person-merge-dialog:focus){outline:none}@media(max-width:480px){:global(.person-merge-dialog){width:calc(100vw - 20px);padding:14px;max-height:calc(100dvh - 20px)}.merge-search{align-items:stretch;flex-direction:column;gap:6px}.merge-footer{flex-wrap:wrap}.merge-footer>span{flex-basis:100%}.merge-footer button{flex:1}}
</style>
