import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const workspace = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('媒体构建重跑隔离旧源码与目标文件，下载和工具链缓存继续共享', async () => {
  await mkdir(join(workspace, '.cache'), { recursive: true })
  const root = await mkdtemp(join(workspace, '.cache/media-build-isolation-'))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'third_party/media-tools'), { recursive: true })
  await writeFile(join(root, 'third_party/media-tools/build-manifest.json'), '{"archives":[]}')
  const source = await readFile(join(workspace, 'scripts/build-media-tools.ps1'), 'utf8')
  const end = source.indexOf('\nfunction Assert-Hash(')
  assert.ok(end > 0)
  const harness = join(root, 'scripts/build-media-tools.ps1')
  // 执行真实构建入口的目录准备阶段，不下载工具链或开始编译。
  await writeFile(harness, source.slice(0, end) + '\n@{source=$sourcesRoot;prefix=$prefix;downloads=$downloadsRoot;tools=$toolsRoot;logs=$logsRoot} | ConvertTo-Json -Compress\n')
  const run = () => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', harness, '-Node', process.execPath],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 }))
  const first = run()
  await mkdir(join(first.source, 'ffmpeg'))
  await writeFile(join(first.source, 'ffmpeg/changed.c'), '旧缓存中的修改')
  await writeFile(join(first.prefix, 'stale-object.o'), '旧目标文件')
  const second = run()
  assert.notEqual(second.source, first.source)
  assert.notEqual(second.prefix, first.prefix)
  assert.notEqual(second.logs, first.logs)
  assert.equal(second.downloads, first.downloads)
  assert.equal(second.tools, first.tools)
  await assert.rejects(access(join(second.source, 'ffmpeg/changed.c')), { code: 'ENOENT' })
  await assert.rejects(access(join(second.prefix, 'stale-object.o')), { code: 'ENOENT' })
  assert.equal(await readFile(join(first.prefix, 'stale-object.o'), 'utf8'), '旧目标文件')
})
