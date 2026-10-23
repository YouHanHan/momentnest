import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, access, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))

/** 打包前校验实际媒体工具与本次构建记录，拒绝旧二进制或错配源码。 */
export async function verifyMediaBuild(root = projectRoot, requireSourceBundle = true) {
  const packageRoot = join(root, 'third_party/media-tools')
  const manifestBytes = await readFile(join(packageRoot, 'build-manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const build = await readJson(join(packageRoot, 'bin/win32-x64/build-info.json'))
  if (build.version !== manifest.version || build.buildId !== manifest.buildId || build.manifestSha256 !== hash(manifestBytes)) throw new Error('媒体工具与固定源码清单不匹配，请重新构建。')
  for (const tool of ['ffmpeg.exe', 'ffprobe.exe']) {
    if (hash(await readFile(join(packageRoot, 'bin/win32-x64', tool))) !== build.binaries?.[tool]) throw new Error(`媒体工具 SHA-256 不匹配：${tool}`)
  }
  const scriptHash = hash(await readFile(join(root, 'scripts/build-media-tools.ps1')))
  if (build.buildScriptSha256 !== scriptHash) throw new Error('媒体工具构建脚本已变化，请重新构建以保持源码对应。')
  if (requireSourceBundle) {
    if (!build.sourceBundle || basename(build.sourceBundle.filename) !== build.sourceBundle.filename) throw new Error('媒体工具缺少可核验的对应源码归档。')
    const sourcePath = join(root, '.cache/media-tool-build/archives', build.sourceBundle.filename)
    if (hash(await readFile(sourcePath)) !== build.sourceBundle.sha256) throw new Error('媒体工具对应源码归档 SHA-256 不匹配。')
    return { manifest, build, sourcePath }
  }
  return { manifest, build }
}

/** 源码归档包含全部静态库源码、固定工具链清单和实际执行的构建脚本。 */
export async function createMediaSourceBundle(root = projectRoot) {
  const { manifest, build } = await verifyMediaBuild(root, false)
  const cacheRoot = join(root, '.cache/media-tool-build')
  const archiveDirectory = join(cacheRoot, 'archives')
  await mkdir(archiveDirectory, { recursive: true })
  const key = hash(JSON.stringify({ binaries: build.binaries, manifestSha256: build.manifestSha256,
    script: build.buildScriptSha256, createdAt: build.createdAt,
    bundler: hash(await readFile(join(root, 'scripts/media-source-bundle.mjs'))) })).slice(0, 12)
  const filename = `MomentNest-media-tools-${manifest.version}-${key}-sources.zip`
  const sourcePath = join(archiveDirectory, filename)
  let exists = false
  try { await access(sourcePath); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  // 缓存只能复用已记录且指纹一致的归档，不能重新认可被替换或未完成登记的文件。
  if (exists && (build.sourceBundle?.filename !== filename || build.sourceBundle.sha256 !== hash(await readFile(sourcePath)))) {
    throw new Error('已有媒体工具对应源码归档 SHA-256 不匹配或缺少可核验记录。')
  }
  if (!exists) {
    const staging = await mkdtemp(join(cacheRoot, 'source-bundle-'))
    const repository = join(staging, 'repository')
    await mkdir(join(repository, 'scripts'), { recursive: true })
    await mkdir(join(repository, 'third_party/media-tools'), { recursive: true })
    const downloads = join(repository, '.cache/media-tool-build/downloads')
    await mkdir(downloads, { recursive: true })
    for (const archive of manifest.archives.filter(item => item.role === 'runtime-source')) {
      if (basename(archive.filename) !== archive.filename || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error('媒体源码清单包含无效文件名或指纹。')
      const archivePath = join(cacheRoot, 'downloads', archive.filename)
      if (hash(await readFile(archivePath)) !== archive.sha256) throw new Error(`对应源码 SHA-256 不匹配：${archive.name}`)
      await cp(archivePath, join(downloads, archive.filename))
    }
    for (const script of ['build-media-tools.ps1', 'media-source-bundle.mjs']) await cp(join(root, 'scripts', script), join(repository, 'scripts', script))
    await cp(join(root, 'third_party/media-tools/build-manifest.json'), join(repository, 'third_party/media-tools/build-manifest.json'))
    await cp(join(root, 'LICENSE'), join(repository, 'LICENSE'))
    await cp(join(root, 'third_party/media-tools/licenses'), join(staging, 'licenses'), { recursive: true })
    const { sourceBundle: previous, ...correspondingBuild } = build
    await writeFile(join(staging, 'build-info.json'), JSON.stringify(correspondingBuild, null, 2) + '\n')
    await writeFile(join(staging, 'README.md'), `# MomentNest 媒体工具对应源码\n\nFFmpeg / ffprobe ${manifest.version}，GPL-3.0-or-later。\n\n归档包含本次实际使用的 FFmpeg、x264、dav1d 和 zlib 完整源码压缩包；它们与固定提交和 SHA-256 逐项对应。未修改上游源码，配置与安装由 repository/scripts/build-media-tools.ps1 完成。\n\n在 Windows x64 上安装可用的 Python 3 与 Node.js 后，进入 repository，执行 PowerShell：\n\n\`\`\`powershell\n./scripts/build-media-tools.ps1 -Python <Python可执行文件路径> -Jobs 2\n\`\`\`\n\n便携编译器、NASM、Meson、Ninja 的版本、下载位置和 SHA-256 位于 build-manifest.json；它们是通用构建工具，不作为本程序运行组件分发。首次准备这些工具需要联网；运行库源码已经全部包含在本归档中。项目原照片、应用数据和签名材料不包含在本归档中。\n\n实际二进制 SHA-256、编译器版本与配置见 build-info.json。许可证原文见 licenses。与 Windows 程序一同提供本归档，并在同一 Release 保持可下载。\n`)
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe') : 'tar'
    execFileSync(tar, ['-a', '-cf', sourcePath, '-C', staging, 'README.md', 'build-info.json', 'licenses', 'repository'], { windowsHide: true, stdio: 'pipe' })
  }
  build.sourceBundle = { filename, sha256: hash(await readFile(sourcePath)) }
  await writeFile(join(root, 'third_party/media-tools/bin/win32-x64/build-info.json'), JSON.stringify(build, null, 2) + '\n')
  return { filename, sourcePath, sha256: build.sourceBundle.sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await createMediaSourceBundle()
  console.log(`媒体工具对应源码归档：${result.sourcePath}`)
  console.log(`SHA-256：${result.sha256}`)
}
