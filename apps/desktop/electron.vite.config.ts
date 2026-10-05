import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig(({ command }) => ({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: ['sharp', 'onnxruntime-node', 'ffmpeg-static', 'ffprobe-static'],
        input: { index: resolve('src/main/index.ts'), receiver: resolve('src/service/worker.ts') },
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [
      vue(),
      {
        name: 'jinchuan-content-policy',
        transformIndexHtml(html) {
          const connections = command === 'serve'
            ? "'self' ws://127.0.0.1:5173"
            : "'self'"
          return html.replace('__CONNECT_SOURCES__', connections)
        },
      },
    ],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
  },
}))
