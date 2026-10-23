import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const nsisVersion = '3.13'
const archiveHash = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'
const archiveUrl = `https://downloads.sourceforge.net/project/nsis/NSIS%203/${nsisVersion}/nsis-${nsisVersion}.zip`

/** 定位项目本地编译器，安装包构建不修改系统工具和环境变量。 */
export function windowsInstallerCompiler(root) {
  const compiler = process.env.MOMENTNEST_NSIS_PATH || join(root, '.cache', 'tools', `nsis-${nsisVersion}`, 'makensis.exe')
  const result = spawnSync(compiler, ['/VERSION'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || result.stdout.trim() !== `v${nsisVersion}`) {
    throw new Error(`需要 NSIS ${nsisVersion}，请先运行 npm.cmd run desktop:installer:setup。`)
  }
  return compiler
}

/** 下载固定版本并核对完整哈希，仅解压到项目忽略目录。 */
async function setup(root) {
  if (process.platform !== 'win32') throw new Error('当前安装包构建仅支持 Windows。')
  const archive = join(root, '.cache', `nsis-${nsisVersion}.zip`)
  await mkdir(dirname(archive), { recursive: true })
  let bytes
  try { bytes = await readFile(archive) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!bytes) {
    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`下载 NSIS 失败：HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== archiveHash) throw new Error('NSIS 下载文件哈希不符。')
    await writeFile(archive, bytes, { flag: 'wx' })
  }
  if (createHash('sha256').update(bytes).digest('hex') !== archiveHash) throw new Error('本地 NSIS 压缩包哈希不符。')
  const tools = join(root, '.cache', 'tools')
  let extracted = false
  try { await access(join(tools, `nsis-${nsisVersion}`, 'makensis.exe')); extracted = true } catch {}
  if (!extracted) {
    const command = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:MOMENTNEST_NSIS_ARCHIVE -DestinationPath $env:MOMENTNEST_NSIS_TOOLS"
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, MOMENTNEST_NSIS_ARCHIVE: archive, MOMENTNEST_NSIS_TOOLS: tools },
    })
    if (result.status !== 0) throw new Error(`解压 NSIS 失败：${result.stderr}`)
  }
  console.log(`Windows 安装包编译器已就绪：${windowsInstallerCompiler(root)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await setup(dirname(dirname(fileURLToPath(import.meta.url))))
}
