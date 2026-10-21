import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前媒体工具构建入口仅支持 Windows x64。')
const script = fileURLToPath(new URL('./build-media-tools.ps1', import.meta.url))
const child = spawn('powershell.exe', ['-NoProfile', '-File', script, '-Node', process.execPath, ...process.argv.slice(2)],
  { stdio: 'inherit', windowsHide: true })
child.on('error', error => { console.error(`媒体工具构建失败：${error.message}`); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
