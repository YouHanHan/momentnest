import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 提供仅用于界面开发的预览，浏览器无法调用桌面文件接口。
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [vue(), {
    name: 'momentnest-web-content-policy',
    transformIndexHtml: (html) => html.replace('__CONNECT_SOURCES__', "'self' ws://127.0.0.1:5173"),
  }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
