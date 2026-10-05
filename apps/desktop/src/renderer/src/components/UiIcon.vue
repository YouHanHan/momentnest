<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  photo: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M3 16l5-5 4 4 3-3 6 6 M16 7h.01',
  baby: 'M5 8C5 5 7 3 10 3c0-2 3-2 4 0 3 0 5 2 5 5 M5 8C1 7 1 13 4 14c1 5 4 7 8 7s7-2 8-7c3-1 3-7-1-6 M8 10h.01 M16 10h.01 M9 15c1.5 1.5 4.5 1.5 6 0',
  transfer: 'M3 7h18l-4-4 M21 17H3l4 4',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 2h4l.6 2.8 2.3 1.3 2.7-.9 2 3.5-2.1 1.9v2.8l2.1 1.9-2 3.5-2.7-.9-2.3 1.3-.6 2.8h-4l-.6-2.8-2.3-1.3-2.7.9-2-3.5 2.1-1.9v-2.8L2.4 8.7l2-3.5 2.7.9 2.3-1.3L10 2Z',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  filter: 'M3 4h18l-7 8v7l-4 2v-9L3 4Z',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  chevron: 'M7 10l5 5 5-5',
  folder: 'M3 6h7l2 2h9v12H3V6Z',
  heart: 'M12 20 3.5 12C-2 6 6 0 12 6c6-6 14 0 8.5 6L12 20Z',
  check: 'M5 12l4 4 10-10',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z M7 2v4 M17 2v4 M3 10h18 M7 14h2 M13 14h2 M7 17h2',
  play: 'M8 5l11 7-11 7V5Z',
  close: 'M6 6l12 12 M18 6 6 18',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7h.01',
  minus: 'M5 12h14',
  plus: 'M5 12h14 M12 5v14',
  fit: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5 M8 8h8v8H8V8Z',
  rotate: 'M20 10a8 8 0 1 0-2 8 M20 3v7h-7',
  fullscreen: 'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',
  'fullscreen-exit': 'M3 8h5V3 M21 8h-5V3 M8 21v-5H3 M16 21v-5h5',
  'arrow-left': 'M15 5l-7 7 7 7',
  'arrow-right': 'M9 5l7 7-7 7',
  camera: 'M3 6h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z M16 9l6-3v12l-6-3V9Z',
}
</script>

<template>
  <svg class="ui-icon" :width="size ?? 22" :height="size ?? 22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><template v-if="name==='photo-filled'"><rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" stroke="none" /><path d="M5 17l4-5 3 3 3-5 4 7H5Z" fill="#fff" stroke="none" /><circle cx="7.5" cy="7.5" r="1.5" fill="#fff" stroke="none" /></template><path v-else :d="paths[name] ?? paths.photo" /></svg>
</template>
