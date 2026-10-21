import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createMediaSourceBundle, verifyMediaBuild } from '../media-source-bundle.mjs'

const workspace = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** 只使用合成二进制与源码归档验证对应关系，不运行媒体工具。 */
async function fixture() {
  await mkdir(join(workspace, '.cache'), { recursive: true })
  const root = await mkdtemp(join(workspace, '.cache/media-source-test-'))
  const packageRoot = join(root, 'third_party/media-tools')
  await mkdir(join(packageRoot, 'bin/win32-x64'), { recursive: true })
  await mkdir(join(packageRoot, 'licenses'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'LICENSE'), '合成构建脚本许可')
  await mkdir(join(root, '.cache/media-tool-build/downloads'), { recursive: true })
  await writeFile(join(packageRoot, 'licenses/NOTICE'), '合成许可')
  for (const script of ['build-media-tools.ps1', 'media-source-bundle.mjs']) await cp(join(workspace, 'scripts', script), join(root, 'scripts', script))
  const archives = []
  for (const name of ['ffmpeg', 'x264', 'dav1d', 'zlib']) {
    const bytes = Buffer.from(`合成源码 ${name}`)
    const filename = `${name}.tar.gz`
    archives.push({ name, filename, sha256: hash(bytes), role: 'runtime-source' })
    await writeFile(join(root, '.cache/media-tool-build/downloads', filename), bytes)
  }
  const manifest = { version: '6.1.1', buildId: 'synthetic', archives }
  const manifestBytes = JSON.stringify(manifest)
  await writeFile(join(packageRoot, 'build-manifest.json'), manifestBytes)
  const binaries = {}
  for (const filename of ['ffmpeg.exe', 'ffprobe.exe']) {
    const bytes = Buffer.from(`合成工具 ${filename}`)
    binaries[filename] = hash(bytes)
    await writeFile(join(packageRoot, 'bin/win32-x64', filename), bytes)
  }
  const build = { version: manifest.version, buildId: manifest.buildId, manifestSha256: hash(manifestBytes),
    buildScriptSha256: hash(await readFile(join(root, 'scripts/build-media-tools.ps1'))), binaries }
  await writeFile(join(packageRoot, 'bin/win32-x64/build-info.json'), JSON.stringify(build))
  return { root, packageRoot }
}

test('源码归档包含所有运行库源码和构建脚本，并绑定实际工具哈希', async () => {
  const { root } = await fixture()
  const archive = await createMediaSourceBundle(root)
  const verified = await verifyMediaBuild(root)
  assert.equal(verified.sourcePath, archive.sourcePath)
  const entries = execFileSync('tar', ['-tf', archive.sourcePath], { encoding: 'utf8', windowsHide: true })
  for (const name of ['ffmpeg', 'x264', 'dav1d', 'zlib']) assert.ok(entries.includes(`downloads/${name}.tar.gz`))
  assert.ok(entries.includes('scripts/build-media-tools.ps1'))
  assert.ok(entries.includes('third_party/media-tools/build-manifest.json'))
  assert.ok(!entries.includes('node_modules'))
  assert.equal((await createMediaSourceBundle(root)).sha256, archive.sha256)
})

test('拒绝被替换的工具以及修改后未重建的构建脚本', async () => {
  const binaryFixture = await fixture()
  await writeFile(join(binaryFixture.packageRoot, 'bin/win32-x64/ffprobe.exe'), '被替换的二进制')
  await assert.rejects(verifyMediaBuild(binaryFixture.root, false), /SHA-256 不匹配/)
  const scriptFixture = await fixture()
  await writeFile(join(scriptFixture.root, 'scripts/build-media-tools.ps1'), '# 与实际构建不同的脚本')
  await assert.rejects(verifyMediaBuild(scriptFixture.root, false), /构建脚本已变化/)
})

test('缺失或被篡改的运行库源码不能生成可分发归档', async () => {
  const { root } = await fixture()
  await writeFile(join(root, '.cache/media-tool-build/downloads/x264.tar.gz'), '其他版本的源码')
  await assert.rejects(createMediaSourceBundle(root), /对应源码 SHA-256 不匹配/)
})

test('打包时拒绝缺少源码归档，或归档与记录不一致', async () => {
  const { root } = await fixture()
  await assert.rejects(verifyMediaBuild(root), /缺少可核验的对应源码归档/)
  const archive = await createMediaSourceBundle(root)
  await writeFile(archive.sourcePath, '不匹配的归档')
  await assert.rejects(verifyMediaBuild(root), /对应源码归档 SHA-256 不匹配/)
})
