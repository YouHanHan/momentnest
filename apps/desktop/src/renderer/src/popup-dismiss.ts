import type { ObjectDirective } from 'vue'
import { closeUiPopups } from './ui-layers'

type PopupBinding = { open: boolean; close: () => void }
type Popup = { element: HTMLElement; binding?: PopupBinding; toggle: () => void }
const popups = new Map<HTMLElement, Popup>()

function isOpen(popup: Popup): boolean {
  return popup.element instanceof HTMLDetailsElement ? popup.element.open : Boolean(popup.binding?.open)
}

function close(popup: Popup): void {
  if (popup.element instanceof HTMLDetailsElement) popup.element.open = false
  else popup.binding?.close()
}

/** 浮动菜单互斥；普通说明和月份折叠不注册到这里。 */
export function closePopupMenus(except?: HTMLElement): void {
  closeUiPopups()
  for (const popup of popups.values()) if (popup.element !== except && isOpen(popup)) close(popup)
}

function outside(event: Event): void {
  for (const popup of popups.values()) {
    if (isOpen(popup) && !event.composedPath().includes(popup.element)) close(popup)
  }
}

function escape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.fullscreenElement) return
  const popup = [...popups.values()].find(item => isOpen(item))
  if (!popup) return
  close(popup)
  event.preventDefault()
  event.stopImmediatePropagation()
  popup.element.querySelector<HTMLElement>('summary,button[aria-expanded]')?.focus({ preventScroll: true })
}

/** 共用一组监听，避免一次 Esc 被多个菜单处理而关闭后面的弹窗。 */
export const vDismissPopup: ObjectDirective<HTMLElement, PopupBinding | undefined> = {
  mounted(element, binding) {
    if (!popups.size) {
      window.addEventListener('pointerdown', outside, true)
      window.addEventListener('click', outside, true)
      window.addEventListener('keydown', escape, true)
    }
    const popup: Popup = { element, binding: binding.value, toggle: () => { if (isOpen(popup)) closePopupMenus(element) } }
    popups.set(element, popup)
    element.addEventListener('toggle', popup.toggle)
    if (isOpen(popup)) closePopupMenus(element)
  },
  updated(element, binding) {
    const popup = popups.get(element)
    if (!popup) return
    const wasOpen = popup.binding?.open
    popup.binding = binding.value
    if (binding.value?.open && !wasOpen) closePopupMenus(element)
  },
  unmounted(element) {
    const popup = popups.get(element)
    if (popup) element.removeEventListener('toggle', popup.toggle)
    popups.delete(element)
    if (!popups.size) {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('click', outside, true)
      window.removeEventListener('keydown', escape, true)
    }
  }
}
