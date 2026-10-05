import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('人脸索引重建只接收照片库标识，主进程校验后交由工作线程执行', () => {
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('../src/service/worker.ts', import.meta.url), 'utf8')
  const api = readFileSync(new URL('../src/shared/desktop-api.ts', import.meta.url), 'utf8')
  assert.match(preload, /rebuildFaceIndex:\s*\(?(\w+)\)?\s*=>\s*ipcRenderer\.invoke\('family:rebuild-face-index',\s*\1\)/)
  assert.match(main, /handle\('family:rebuild-face-index',\s*\(?(\w+)\)?\s*=>\s*receiver!\.call\('rebuildFaceIndex',\s*identifier\(\1\)\)\)/)
  assert.match(worker, /case 'rebuildFaceIndex':\s*return receiver\.family\.rebuildFaceIndex\(String\(a\[0\]\)\)/)
  assert.match(api, /rebuildFaceIndex\(libraryId:\s*string\):\s*Promise<void>/)
})

test('重建 IPC 使用统一来源校验，维护启动入口必须由明确开关触发', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const handle = main.match(/function handle\([\s\S]*?\n\}/)?.[0]
  assert.ok(handle)
  assert.match(handle, /requireTrustedSender\(event\)[\s\S]*?return action\(\.\.\.args\)/)
  const startup = main.match(/if \(app\.commandLine\.hasSwitch\('jinchuan-rebuild-face-index'\)\) \{([\s\S]*?)\n  \}/)?.[1]
  assert.ok(startup)
  assert.match(startup, /!state\.currentLibraryId\s*\|\|\s*!state\.currentLibraryAvailable/)
  assert.match(startup, /receiver!\.call\('rebuildFaceIndex',\s*identifier\(state\.currentLibraryId\)\)/)
})
