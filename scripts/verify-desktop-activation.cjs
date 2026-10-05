const { app, BrowserWindow, dialog } = require('electron')
const threads = require('node:worker_threads')
const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const entry = app.commandLine.getSwitchValue('verify-entry') || join(root, 'apps/desktop/out/main/index.js')
const directory = app.commandLine.getSwitchValue('verify-data') || join(root, '.cache', `desktop-activation-${Date.now()}`)
const secondary = app.commandLine.hasSwitch('verify-secondary')
mkdirSync(directory, { recursive: true })
app.setPath('userData', directory)
app.disableHardwareAcceleration()
let workerCount = 0, window
const checks = []
const NativeWorker = threads.Worker
// 真实单实例验证使用独立数据库与随机回环端口，第二实例不得新建接收线程。
threads.Worker = class extends NativeWorker {
  constructor(filename, options) {
    if (secondary) throw new Error('第二实例不应创建接收线程。')
    super(filename, { ...options, workerData: { ...options.workerData, port: 0, host: '127.0.0.1', modelDirectory: join(root, 'models') } })
    workerCount++
  }
}
dialog.showMessageBox = async () => ({ response: 1 })
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }
const deadline = setTimeout(() => { console.error('窗口唤起验证超时'); app.exit(1) }, 30000)

/** 等待原生窗口状态变化，避免把异步显示与最小化误判为失败。 */
async function waitFor(condition) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > 8000) throw new Error('原生窗口状态未按预期变化。')
    await new Promise(resolveTick => setTimeout(resolveTick, 25))
  }
}

/** 启动真正的第二进程，核验单实例事件及已有窗口恢复。 */
async function launchAgain() {
  const child = spawn(process.execPath, [__filename, `--verify-entry=${entry}`, `--verify-data=${directory}`, '--verify-secondary'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk.toString() })
  await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`第二进程退出失败（${code}）：${errors}`)))
  })
  await waitFor(() => window.isVisible() && !window.isMinimized() && window.isFocused())
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  assert.equal(workerCount, 1)
}

async function verify() {
  await waitFor(() => window.isVisible())
  assert.equal(await window.webContents.executeJavaScript('1 + 1'), 2)
  checks.push('首次启动显示可用的真实窗口')
  window.hide()
  await waitFor(() => !window.isVisible())
  await launchAgain()
  checks.push('隐藏窗口后再次启动恢复并聚焦原窗口，不重复创建服务')
  window.minimize()
  await waitFor(() => window.isMinimized())
  await launchAgain()
  checks.push('最小化后再次启动恢复并聚焦原窗口，不重复创建服务')
  window.hide()
  app.emit('activate')
  await waitFor(() => window.isVisible() && window.isFocused())
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  checks.push('应用激活复用并显示已有窗口')
  const report = { checks, workerCount, isolatedDataDirectory: directory, entry, checkedAt: new Date().toISOString() }
  writeFileSync(join(root, '.local', 'desktop-activation-latest.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  clearTimeout(deadline)
  app.quit()
}

if (!secondary) app.on('browser-window-created', (_event, created) => {
  window = created
  created.webContents.once('did-finish-load', () => {
    void verify().catch(error => { console.error(error); clearTimeout(deadline); app.exit(1) })
  })
})
require(entry)
