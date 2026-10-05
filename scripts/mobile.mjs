import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { advanceMobileVersion, archiveMobileApks } from './release-version.mjs'

const commands = {
  deps: ['pub', 'get'],
  dev: ['run'],
  analyze: ['analyze'],
  test: ['test'],
}
const packagingModes = { apk: ['debug'], 'apk-release': ['release'], 'apk-all': ['debug', 'release'] }
const command = process.argv[2]
const flags = process.argv.slice(3)
const modes = packagingModes[command]
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mobileDirectory = join(root, 'apps', 'mobile')
const windows = process.platform === 'win32'

// Windows 批处理通过命令解释器调用，参数仅来自固定命令表。
function runFlutter(args) {
  return runProcess(windows ? 'cmd.exe' : 'flutter', windows ? ['/d', '/s', '/c', `flutter ${args.join(' ')}`] : args, mobileDirectory)
}

/** 等待构建命令完成，失败时阻止交付归档。 */
function runProcess(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`构建命令退出码：${code ?? '中断'}`)))
  })
}

/** 一次打包只递增一次版本，调试与正式包分别沿用各自签名。 */
async function main() {
  if (!modes) {
    if (!commands[command] || flags.length) throw new Error('用法：node scripts/mobile.mjs deps|dev|analyze|test|apk|apk-release|apk-all [--offline] [--arm64]')
    await runFlutter(commands[command])
    return
  }
  if (flags.some(flag => !['--offline', '--arm64'].includes(flag))) throw new Error('打包只支持 --offline 和 --arm64 参数。')
  const arm64 = flags.includes('--arm64')
  const split = command !== 'apk' || arm64
  const release = await advanceMobileVersion(root)
  console.log(`Android 版本：${release.previousVersion} → ${release.version}+${release.buildNumber}`)
  if (flags.includes('--offline')) {
    // 显式离线构建复用本机缓存和项目现有镜像配置，不修改全局设置。
    const androidDirectory = join(mobileDirectory, 'android')
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', windows ? 'java.exe' : 'java') : 'java'
    const args = ['-classpath', join(androidDirectory, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain',
      '--offline', '--init-script', join(androidDirectory, 'google-mirror.init.gradle'),
      `-Ptarget-platform=${arm64 ? 'android-arm64' : 'android-arm,android-arm64,android-x64'}`]
    if (split) args.push('-Psplit-per-abi=true')
    args.push(...modes.map(mode => `:app:assemble${mode === 'debug' ? 'Debug' : 'Release'}`))
    await runProcess(java, args, androidDirectory)
  } else {
    for (const mode of modes) {
      const args = ['build', 'apk', `--${mode}`]
      if (split) args.push('--split-per-abi')
      if (arm64) args.push('--target-platform=android-arm64')
      await runFlutter(args)
    }
  }
  const report = await archiveMobileApks(root, modes, release)
  for (const item of report.packages) console.log(`Android 交付包：${item.path}`)
}

await main().catch(error => { console.error(`手机构建失败：${error.message}`); process.exitCode = 1 })
