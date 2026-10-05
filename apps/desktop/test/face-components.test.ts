import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import sharp from 'sharp'

const executable = [process.env.JINCHUAN_TEST_BROWSER, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((path): path is string => Boolean(path && existsSync(path)))
const rendererRoot = fileURLToPath(new URL('../src/renderer/', import.meta.url))
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: Browser | undefined, base = ''
const bootstrapPath = '/__face_component.js', bootstrapId = '\0face-component-bootstrap'
const bootstrap = 'import {createApp,h,reactive} from "vue";import Selector from "/src/components/FaceSelector.vue";const props=reactive(window.__faces);window.__faceProps=props;window.__faceCalls=[];createApp({render:()=>h(Selector,{...props,onSelect:id=>{window.__faceCalls.push(id);props.selectedId=id}})}).mount("#app");'

// 独立缓存和合成图片避免并行界面测试及个人图库之间相互影响。
before(async () => {
  if (!executable) return
  server = await createServer({ configFile: false, root: rendererRoot, cacheDir: resolve(rendererRoot, '../../../..', `.cache/face-components-vite-${process.pid}`), plugins: [vue(), {
    name: 'face-component-test',
    resolveId(id) { if (id === bootstrapPath) return bootstrapId },
    load(id) { if (id === bootstrapId) return bootstrap },
    configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        if (request.url !== '/__face_component') { next(); return }
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(`<!doctype html><html lang="zh-CN"><body><div id="app"></div><script type="module" src="${bootstrapPath}"></script></body></html>`)
      })
    },
  }], server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(rendererRoot, '../../../..')] } }, logLevel: 'error' })
  await server.listen()
  const address = server.httpServer!.address() as { port: number }
  base = `http://127.0.0.1:${address.port}/__face_component`
  browser = await chromium.launch({ executablePath: executable, headless: true })
})
after(async () => { await browser?.close(); await server?.close() })
const options = { skip: !executable, timeout: 30000 }

function fixture(kind = 'photo') {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="100" height="100" fill="#ff0000"/><rect x="100" width="100" height="100" fill="#0000ff"/></svg>'
  return { kind, src: `data:image/svg+xml,${encodeURIComponent(svg)}`, selectedId: 'left', faces: [
    { id: 'left', x: .05, y: .3, width: .2, height: .4, score: .95, personName: '左侧人物' },
    { id: 'right', x: .65, y: .3, width: .2, height: .4, score: .95, personName: '右侧人物' },
  ] }
}

test('原比例横图按不同人脸裁切，点击和键盘选择发出真实 faceId', options, async () => {
  const page = await browser!.newPage({ viewport: { width: 320, height: 240 } })
  try {
    await page.addInitScript(value => { (window as any).__faces = value }, fixture())
    await page.goto(base)
    await page.waitForFunction(() => [...document.querySelectorAll('.face-avatar img')].length === 2 && [...document.querySelectorAll<HTMLImageElement>('.face-avatar img')].every(image => image.complete && image.naturalWidth === 200 && getComputedStyle(image).visibility !== 'hidden'))
    for (const [index, expected] of [[0, [255, 0, 0]], [1, [0, 0, 255]]] as const) {
      const rendered = await sharp(await page.locator('.face-avatar').nth(index).screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const offset = ((Math.floor(rendered.info.height / 2) * rendered.info.width) + Math.floor(rendered.info.width / 2)) * rendered.info.channels
      assert.deepEqual([...rendered.data.subarray(offset, offset + 3)], expected)
    }
    await page.getByRole('button', { name: '右侧人物' }).click()
    assert.equal(await page.getByRole('button', { name: '右侧人物' }).getAttribute('aria-pressed'), 'true')
    await page.getByRole('button', { name: '左侧人物' }).focus()
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.evaluate(() => (window as any).__faceCalls), ['right', 'left'])
  } finally { await page.close() }
})

test('视频帧不套用封面裁切，非法坐标与加载失败安全回退', options, async () => {
  const page = await browser!.newPage()
  try {
    await page.addInitScript(value => { (window as any).__faces = value }, { ...fixture('video'), faces: fixture().faces.map(face => ({ ...face, frameTime: 3.5 })) })
    await page.goto(base)
    await page.getByRole('group', { name: '选择检测到的人脸' }).waitFor()
    assert.equal(await page.locator('.face-avatar img').count(), 0)
    assert.equal(await page.getByText('视频帧 · 3.5 秒', { exact: true }).count(), 2)
    await page.evaluate(() => { const props = (window as any).__faceProps; props.kind = 'photo'; props.faces = props.faces.map((face: any) => ({ ...face, frameTime: undefined, width: 0 })) })
    assert.equal(await page.locator('.face-avatar img').count(), 0)
    await page.evaluate(() => { const props = (window as any).__faceProps; props.src = 'data:image/png;base64,AA=='; props.faces = props.faces.map((face: any) => ({ ...face, width: .2 })) })
    await page.waitForFunction(() => document.querySelectorAll('.face-avatar img').length === 0)
    assert.equal(await page.locator('.face-avatar__placeholder').count(), 2)
    await page.evaluate(() => { (window as any).__faceProps.disabled = true })
    assert.equal(await page.getByRole('button', { name: '左侧人物' }).isDisabled(), true)
    assert.deepEqual(await page.evaluate(() => (window as any).__faceCalls), [])
  } finally { await page.close() }
})
