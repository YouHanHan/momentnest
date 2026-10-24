import { createApp } from 'vue'
import App from './App.vue'
import { themePalette } from '../../shared/theme-palette'
import './style.css'

// 窗口、手写样式与组件库共用同一套颜色，首帧渲染前写入主题变量。
for (const [name, color] of Object.entries(themePalette)) {
  document.documentElement.style.setProperty(`--theme-${name}`, color)
}

createApp(App).mount('#app')
