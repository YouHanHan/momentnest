import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 每次打包递增补丁号，拒绝无法可靠递增的版本格式。 */
export function nextPatchVersion(version) {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)
  if (!parts || !parts.slice(1).every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error(`版本号格式无效：${version}`)
  }
  const patch = Number(parts[3]) + 1
  if (!Number.isSafeInteger(patch)) throw new Error('版本号已超出可递增范围。')
  return `${parts[1]}.${parts[2]}.${patch}`
}

/** 保持 JSON 的缩进和换行，只更新传入的版本字段。 */
async function saveJson(path, original, value) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const content = JSON.stringify(value, null, 2).replace(/\n/g, newline)
  await writeFile(path, content + (/\r?\n$/.test(original) ? newline : ''))
}

/** 同步递增桌面源码和锁文件版本，依赖版本保持原值。 */
export async function advanceDesktopVersion(root) {
  const paths = ['package.json', 'apps/desktop/package.json', 'package-lock.json'].map(path => join(root, path))
  const texts = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const [project, desktop, lock] = texts.map(text => JSON.parse(text))
  const versions = [project.version, desktop.version, lock.version, lock.packages?.['']?.version, lock.packages?.['apps/desktop']?.version]
  if (versions.some(version => version !== desktop.version)) {
    throw new Error('桌面源码与锁文件版本不一致，停止打包。')
  }
  const previousVersion = desktop.version
  const version = nextPatchVersion(previousVersion)
  project.version = desktop.version = lock.version = version
  lock.packages[''].version = lock.packages['apps/desktop'].version = version
  const values = [project, desktop, lock]
  for (const [index, path] of paths.entries()) await saveJson(path, texts[index], values[index])
  return { ...desktop, previousVersion }
}

/** 同步手机版本名、构建号及已有的本机 Gradle 版本配置。 */
export async function advanceMobileVersion(root) {
  const pubspecPath = join(root, 'apps/mobile/pubspec.yaml')
  const pubspec = await readFile(pubspecPath, 'utf8')
  const pattern = /^(version:[ \t]*)(\d+\.\d+\.\d+)\+(\d+)([^\r\n]*)$/m
  const match = pattern.exec(pubspec)
  if (!match || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < 1) {
    throw new Error('手机 pubspec.yaml 必须包含有效的版本名和构建号。')
  }
  const version = nextPatchVersion(match[2])
  const buildNumber = Number(match[3]) + 1
  if (!Number.isSafeInteger(buildNumber)) throw new Error('Android 构建号已超出可递增范围。')
  const propertiesPath = join(root, 'apps/mobile/android/local.properties')
  let properties
  try { properties = await readFile(propertiesPath, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(pubspecPath, pubspec.replace(pattern, `${match[1]}${version}+${buildNumber}${match[4]}`))
  if (properties !== undefined) {
    const newline = properties.includes('\r\n') ? '\r\n' : '\n'
    for (const [key, value] of [['flutter.versionName', version], ['flutter.versionCode', buildNumber]]) {
      const property = new RegExp(`^${key.replaceAll('.', '\\.')}=[^\\r\\n]*`, 'm')
      properties = property.test(properties)
        ? properties.replace(property, `${key}=${value}`)
        : `${properties}${properties.endsWith('\n') ? '' : newline}${key}=${value}${newline}`
    }
    await writeFile(propertiesPath, properties)
  }
  return { version, buildNumber, previousVersion: match[2] }
}

/** 核对真实构建版本后归档 APK，交付文件名包含版本、构建号、架构和签名类型。 */
export async function archiveMobileApks(root, modes, release) {
  const abiNames = { 'armeabi-v7a': 'arm', 'arm64-v8a': 'arm64', x86_64: 'x64' }
  const abiOffsets = { 'armeabi-v7a': 1000, 'arm64-v8a': 2000, x86_64: 4000 }
  const packages = []
  for (const mode of modes) {
    const directory = join(root, 'apps/mobile/build/app/outputs/apk', mode)
    const metadata = JSON.parse(await readFile(join(directory, 'output-metadata.json'), 'utf8'))
    if (metadata.variantName !== mode || !metadata.elements?.length) throw new Error(`${mode} APK 构建清单无效。`)
    for (const element of metadata.elements) {
      const abi = element.filters?.find(filter => filter.filterType === 'ABI')?.value
      if (abi && !abiNames[abi]) throw new Error(`无法识别 APK 架构：${abi}`)
      const versionCode = release.buildNumber + (abiOffsets[abi] ?? 0)
      if (element.versionName !== release.version || element.versionCode !== versionCode) {
        throw new Error(`${mode} APK 版本与本次打包不一致，拒绝把旧包改名交付。`)
      }
      if (basename(element.outputFile) !== element.outputFile) throw new Error('APK 构建清单包含无效文件名。')
      const architecture = abiNames[abi] ?? 'universal'
      const filename = `MomentNest-${release.version}-build${release.buildNumber}-${architecture}-${mode}.apk`
      packages.push({ source: join(directory, element.outputFile), filename, mode, architecture, versionCode })
    }
  }
  const destination = join(root, 'apps/mobile/build/verified-apks')
  await mkdir(destination, { recursive: true })
  for (const item of packages) {
    item.path = join(destination, item.filename)
    await copyFile(item.source, item.path, constants.COPYFILE_EXCL)
    delete item.source
  }
  const report = { version: release.version, buildNumber: release.buildNumber, packages, createdAt: new Date().toISOString() }
  await writeFile(join(destination, 'latest.json'), JSON.stringify(report, null, 2))
  return report
}
