const { app, dialog } = require('electron')
const workerThreads = require('node:worker_threads')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const entry = app.commandLine.getSwitchValue('verify-entry') || join(root, 'apps/desktop/out/main/index.js')
const directory = join(root, '.cache', `desktop-close-${Date.now()}`)
mkdirSync(directory, { recursive: true })
app.setPath('userData', directory)
app.disableHardwareAcceleration()
const checks = [], prompts = []
let closeCalls = 0, terminateCalls = 0, window
const NativeWorker = workerThreads.Worker
// 使用独立数据库和随机回环端口，真实关闭服务时记录清理次数。
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options) {
    super(filename, { ...options, workerData: { ...options.workerData, port: 0, host: '127.0.0.1', modelDirectory: join(root, 'models') } })
  }
  postMessage(message, ...args) { if (message.method === 'close') closeCalls++; return super.postMessage(message, ...args) }
  terminate() { terminateCalls++; return super.terminate() }
}
dialog.showMessageBox = (parent, options) => new Promise(resolveResponse => { prompts.push({ parent, options, resolveResponse }) })
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }
const deadline = setTimeout(() => { console.error('关闭确认验收超时'); app.exit(1) }, 30000)
const tick = () => new Promise(resolveTick => setImmediate(resolveTick))

/** 从真实窗口和退出事件核验取消保留、重复请求和确认后的服务关闭。 */
async function verify() {
  window.close()
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].parent, window)
  assert.equal(prompts[0].options.message, '是否真的关闭拾光匣？')
  assert.deepEqual(prompts[0].options.buttons, ['取消', '关闭'])
  assert.equal(prompts[0].options.defaultId, 0)
  assert.equal(prompts[0].options.cancelId, 0)
  checks.push('关闭请求弹出中文确认，默认和 Esc 均为取消')
  window.close(); window.close(); app.quit()
  assert.equal(prompts.length, 1)
  assert.equal(window.isDestroyed(), false)
  assert.equal(closeCalls, 0)
  checks.push('连续关闭与退出请求共用一个提示，等待期间不关闭服务')
  prompts[0].resolveResponse({ response: 0, checkboxChecked: false })
  await tick()
  assert.equal(window.isDestroyed(), false)
  assert.equal(await window.webContents.executeJavaScript('1+1'), 2)
  assert.equal(closeCalls, 0)
  checks.push('取消窗口关闭后原窗口仍可使用，接收服务保持运行')
  app.quit(); app.quit()
  assert.equal(prompts.length, 2)
  prompts[1].resolveResponse({ response: 0, checkboxChecked: false })
  await tick()
  assert.equal(window.isDestroyed(), false)
  assert.equal(closeCalls, 0)
  checks.push('应用退出入口同样确认，取消后不退出')
  window.close()
  assert.equal(prompts.length, 3)
  prompts[2].resolveResponse({ response: 1, checkboxChecked: false })
}
app.on('will-quit', () => {
  try {
    assert.equal(prompts.length, 3)
    assert.equal(window.isDestroyed(), true)
    assert.equal(closeCalls, 1)
    assert.equal(terminateCalls, 1)
    checks.push('确认后销毁窗口，仅关闭一次服务并完成线程退出')
    const report = { checks, dialogCount: prompts.length, closeCalls, terminateCalls, isolatedDataDirectory: directory, entry, checkedAt: new Date().toISOString() }
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(root, '.local/desktop-close-latest.json'), JSON.stringify(report, null, 2))
    clearTimeout(deadline)
    console.log(JSON.stringify(report))
  } catch (error) { console.error(error); app.exit(1) }
})
app.on('browser-window-created', (_event, created) => {
  window = created
  created.show = () => {}
  created.webContents.setBackgroundThrottling(false)
  created.webContents.once('did-finish-load', () => { void verify().catch(error => { console.error(error); clearTimeout(deadline); app.exit(1) }) })
})
require(entry)
