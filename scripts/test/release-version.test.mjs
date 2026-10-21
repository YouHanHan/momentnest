import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advanceDesktopVersion, advanceMobileVersion, archiveMobileApks, nextPatchVersion } from '../release-version.mjs'

const workspace = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** 在应用忽略目录创建隔离样本，不改动真实版本和发布包。 */
async function fixture() {
  await mkdir(join(workspace, '.cache'), { recursive: true })
  const root = await mkdtemp(join(workspace, '.cache', 'package-version-test-'))
  await mkdir(join(root, 'apps/desktop'), { recursive: true })
  await mkdir(join(root, 'apps/mobile/android'), { recursive: true })
  const desktop = { version: '0.4.20', dependencies: { sharp: '^0.35.5' } }
  const lock = { version: desktop.version, packages: { '': { version: desktop.version }, 'apps/desktop': desktop, 'node_modules/sharp': { version: '0.35.5' } } }
  for (const [path, value] of [['package.json', desktop], ['apps/desktop/package.json', desktop], ['package-lock.json', lock]]) {
    await writeFile(join(root, path), JSON.stringify(value, null, 2))
  }
  return root
}

test('补丁号逐次递增，拒绝非法或不安全的版本', () => {
  assert.equal(nextPatchVersion('0.4.20'), '0.4.21')
  assert.equal(nextPatchVersion('1.2.999'), '1.2.1000')
  for (const version of ['0.4', '01.2.3', '1.2.3-beta', '1.2.9007199254740991']) assert.throws(() => nextPatchVersion(version))
})

test('连续桌面打包同步源码与锁文件，不改依赖版本', async () => {
  const root = await fixture()
  assert.equal((await advanceDesktopVersion(root)).version, '0.4.21')
  assert.equal((await advanceDesktopVersion(root)).version, '0.4.22')
  const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const desktop = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  assert.equal(project.version, '0.4.22')
  assert.equal(desktop.version, project.version)
  assert.equal(lock.version, project.version)
  assert.equal(lock.packages[''].version, project.version)
  assert.equal(lock.packages['apps/desktop'].version, project.version)
  assert.equal(lock.packages['node_modules/sharp'].version, '0.35.5')
  assert.deepEqual(desktop.dependencies, { sharp: '^0.35.5' })
})

test('版本不一致时停止打包，保留原文件', async () => {
  const root = await fixture()
  const path = join(root, 'apps/desktop/package.json')
  await writeFile(path, '{"version":"0.4.19"}')
  const before = await readFile(join(root, 'package.json'), 'utf8')
  await assert.rejects(advanceDesktopVersion(root), /版本不一致/)
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before)
  assert.equal(await readFile(path, 'utf8'), '{"version":"0.4.19"}')
})

test('手机版本名和构建号连续递增，保留注释、换行和本机配置', async () => {
  const root = await fixture()
  const pubspecPath = join(root, 'apps/mobile/pubspec.yaml')
  const propertiesPath = join(root, 'apps/mobile/android/local.properties')
  await writeFile(pubspecPath, '# 保留说明\r\nversion: 0.4.7+18 # 版本注释\r\nname: momentnest\r\n')
  await writeFile(propertiesPath, '# 本机路径\r\nsdk.dir=C:/sdk\r\nflutter.versionName=0.4.7\r\nflutter.versionCode=18\r\n')
  assert.deepEqual(await advanceMobileVersion(root), { version: '0.4.8', buildNumber: 19, previousVersion: '0.4.7' })
  assert.deepEqual(await advanceMobileVersion(root), { version: '0.4.9', buildNumber: 20, previousVersion: '0.4.8' })
  assert.equal(await readFile(pubspecPath, 'utf8'), '# 保留说明\r\nversion: 0.4.9+20 # 版本注释\r\nname: momentnest\r\n')
  assert.equal(await readFile(propertiesPath, 'utf8'), '# 本机路径\r\nsdk.dir=C:/sdk\r\nflutter.versionName=0.4.9\r\nflutter.versionCode=20\r\n')
})

/** 创建模拟构建清单，用于验证版本检查与交付归档。 */
async function builtApk(root, mode, version = '0.4.8', abi = 'arm64-v8a', versionCode = 2019) {
  const directory = join(root, 'apps/mobile/build/app/outputs/apk', mode)
  await mkdir(directory, { recursive: true })
  const outputFile = `app-${abi}-${mode}.apk`
  await writeFile(join(directory, outputFile), `本次构建 ${version} ${mode}`)
  await writeFile(join(directory, 'output-metadata.json'), JSON.stringify({ variantName: mode, elements: [{ versionName: version, versionCode, filters: [{ filterType: 'ABI', value: abi }], outputFile }] }))
}

test('同轮调试与正式包使用相同版本，包名标明版本和架构', async () => {
  const root = await fixture()
  await builtApk(root, 'debug')
  await builtApk(root, 'release', '0.4.8', 'x86_64', 4019)
  const report = await archiveMobileApks(root, ['debug', 'release'], { version: '0.4.8', buildNumber: 19 })
  assert.deepEqual(report.packages.map(item => item.filename), ['MomentNest-0.4.8-build19-arm64-debug.apk', 'MomentNest-0.4.8-build19-x64-release.apk'])
  assert.equal(await readFile(report.packages[0].path, 'utf8'), '本次构建 0.4.8 debug')
  const latest = JSON.parse(await readFile(join(root, 'apps/mobile/build/verified-apks/latest.json'), 'utf8'))
  assert.equal(latest.version, '0.4.8')
  assert.equal(latest.packages.length, 2)
})

test('拒绝旧 APK 改名交付，拒绝覆盖同名归档包', async () => {
  const root = await fixture()
  await builtApk(root, 'debug', '0.4.7', 'arm64-v8a', 2018)
  const release = { version: '0.4.8', buildNumber: 19 }
  await assert.rejects(archiveMobileApks(root, ['debug'], release), /版本与本次打包不一致/)
  await builtApk(root, 'debug')
  const report = await archiveMobileApks(root, ['debug'], release)
  await assert.rejects(archiveMobileApks(root, ['debug'], release), { code: 'EEXIST' })
  assert.equal(await readFile(report.packages[0].path, 'utf8'), '本次构建 0.4.8 debug')
})
