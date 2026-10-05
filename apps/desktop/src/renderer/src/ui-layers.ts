import type { InjectionKey } from 'vue'

type Layer = { id: symbol; parent?: symbol; kind: 'popup' | 'picker' | 'dialog'; close: () => void; focus?: () => void }
const layers: Layer[] = []
export const uiPopupOwner: InjectionKey<symbol> = Symbol('ui-popup-owner')

/** 只关闭临时浮层；弹窗关闭仍由各自的业务策略决定。 */
export function closeUiPopups(except?: symbol): void {
  const ancestors = new Set<symbol>()
  let current = except
  while (current) { ancestors.add(current); current = layers.find(layer => layer.id === current)?.parent }
  for (const layer of [...layers].reverse()) if (layer.kind !== 'dialog' && !ancestors.has(layer.id)) layer.close()
}

/** 打开子日历和下拉时保留其父菜单，其他同级菜单互斥。 */
export function addUiLayer(layer: Layer): void {
  removeUiLayer(layer.id)
  if (layer.kind !== 'dialog') closeUiPopups(layer.parent)
  layers.push(layer)
}
export function removeUiLayer(id: symbol): void { const index = layers.findIndex(layer => layer.id === id); if (index >= 0) layers.splice(index, 1) }

/** 捕获阶段先处理最上层浮层，避免一次 Escape 同时关闭日历与照片预览。 */
if (typeof window !== 'undefined') window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
  const layer = layers.at(-1)
  if (!layer) return
  event.preventDefault(); event.stopImmediatePropagation()
  layer.close(); layer.focus?.()
}, true)
