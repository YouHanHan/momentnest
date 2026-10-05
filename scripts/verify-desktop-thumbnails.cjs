const { app, dialog, ipcMain } = require('electron')
const threads = require('node:worker_threads')
const { copyFileSync, mkdirSync, readdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')

const root = resolve(__dirname, '..')
const entry = app.commandLine.getSwitchValue('verify-entry') || join(root, 'apps/desktop/out/main/index.js')
const label = app.commandLine.getSwitchValue('verify-label') || 'latest'
const directory = join(root, '.cache', `desktop-thumbnails-${Date.now()}`)
const source = join(directory, 'source')
mkdirSync(source, { recursive: true })
for (const file of readdirSync(join(root, '.cache/smoke-media'))) copyFileSync(join(root, '.cache/smoke-media', file), join(source, file))
app.setPath('userData', directory)

// 合成照片与视频使用独立数据库和随机回环端口，不中断用户正在进行的扫描。
const NativeWorker = threads.Worker
threads.Worker = class extends NativeWorker {
  constructor(filename, options) {
    super(filename, { ...options, workerData: { ...options.workerData, port: 0, host: '127.0.0.1', modelDirectory: join(root, 'models') } })
  }
}
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
dialog.showMessageBox = async () => ({ response: 1 })
dialog.showErrorBox = (title, message) => { throw new Error(`${title}: ${message}`) }
const mediaCalls = [], errors = []
const nativeHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => nativeHandle(channel, async (...args) => {
  if (channel !== 'family:media-url') return handler(...args)
  const call = { thumbnail: args[2], started: Date.now() }
  mediaCalls.push(call)
  try { const result = await handler(...args); call.success = true; return result }
  catch (error) { call.error = error.message; throw error }
  finally { call.elapsed = Date.now() - call.started }
})
let window
const evaluate = code => window.webContents.executeJavaScript(code)

/** 等待真实界面和本地协议解码，卡片存在不能代替缩略图显示成功。 */
async function waitFor(code, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(code)) return
    await new Promise(resolveTick => setTimeout(resolveTick, 80))
  }
  throw new Error(`缩略图验证超时：${code}`)
}

async function verify() {
  await waitFor('Boolean(window.jinchuan)')
  await evaluate('(async()=>{await window.jinchuan.addDirectories("library");const state=await window.jinchuan.getState();await window.jinchuan.scanMedia(state.currentLibraryId)})()')
  await waitFor('(async()=>{const state=await window.jinchuan.getState();const family=await window.jinchuan.getFamilyState(state.currentLibraryId);return family.photoCount===3 && family.videoCount===1 && !family.jobs.some(job=>job.state==="running")})()', 30000)
  await waitFor('document.querySelectorAll(".media-card").length===4')
  await waitFor('[...document.querySelectorAll(".media-card img")].length===4 && [...document.querySelectorAll(".media-card img")].every(image=>image.naturalWidth>0)')
  assert.equal(mediaCalls.filter(call => call.thumbnail && call.success).length, 4)
  const report = { checks: ['三张照片和一段视频通过真实 IPC、本地协议及图库组件显示缩略图'], mediaCalls, errors, dataDirectory: directory }
  assert.deepEqual(errors, [])
  writeFileSync(join(root, '.cache', `desktop-thumbnails-verification-${label}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}

const deadline = setTimeout(() => { console.error('缩略图验收超时'); app.exit(1) }, 65000)
app.on('browser-window-created', (_event, created) => {
  window = created; created.show = () => {}
  created.webContents.setBackgroundThrottling(false)
  created.webContents.on('console-message', event => { if (event.level === 3 || event.level === 'error') errors.push(event.message) })
  created.webContents.once('did-finish-load', () => {
    verify().then(() => { clearTimeout(deadline); app.quit() }).catch(async error => {
      console.error(error.message)
      console.error(JSON.stringify({ mediaCalls, errors, cards: await evaluate('({count:document.querySelectorAll(".media-card").length,images:document.querySelectorAll(".media-card img").length,unavailable:document.querySelectorAll(".media-unavailable").length})').catch(() => null) }))
      clearTimeout(deadline); app.exit(1)
    })
  })
})
require(entry)
