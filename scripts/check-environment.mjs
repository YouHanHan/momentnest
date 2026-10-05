import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const issues = []

// 只检查工具与文件，不安装软件或修改系统配置。
console.log(`拾光匣开发环境检查\n项目目录：${projectRoot}`)
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  issues.push('需要 Node.js 22.12+，建议使用受支持的 LTS 版本。')
} else {
  console.log(`[通过] Node.js ${process.versions.node}`)
  if (major % 2 !== 0) console.log('[提示] 当前为非 LTS 主版本，团队开发建议统一到受支持的 LTS。')
}

try {
  const electronPackage = require.resolve('electron/package.json', { paths: [join(projectRoot, 'apps/desktop')] })
  const electronDirectory = dirname(electronPackage)
  const pathFile = join(electronDirectory, 'path.txt')
  const binary = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : ''
  if (binary && existsSync(join(electronDirectory, 'dist', binary))) console.log('[通过] Electron 依赖与运行时')
  else issues.push('Electron 运行时未下载，请完成 npm ci 的安装脚本。')
} catch {
  issues.push('桌面依赖尚未安装，请执行 npm ci。')
}

try {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const flutterExecutable = execFileSync(locator, ['flutter'], { encoding: 'utf8', windowsHide: true })
    .trim().split(/\r?\n/)[0]
  const flutterRoot = dirname(dirname(realpathSync(flutterExecutable)))
  const version = JSON.parse(readFileSync(join(flutterRoot, 'bin/cache/flutter.version.json'), 'utf8'))
  console.log(`[通过] Flutter ${version.flutterVersion} / Dart ${version.dartSdkVersion}`)
} catch {
  issues.push('未找到已就绪的 Flutter SDK，请运行 flutter --version 和 flutter doctor 排查。')
}

try {
  const javaInfo = execFileSync('java', ['--version'], { encoding: 'utf8', windowsHide: true })
  const javaMajor = Number(javaInfo.match(/(?:openjdk|java)\s+(\d+)/)?.[1])
  if (javaMajor >= 17 && javaMajor <= 24) console.log(`[通过] JDK ${javaMajor}`)
  else issues.push('当前 Android 构建基线建议使用 JDK 21。')
} catch {
  issues.push('未找到可用 Java，Android 开发建议使用 Android Studio 自带 JDK 21。')
}

let sdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'AppData/Local/Android/Sdk')
const localProperties = join(projectRoot, 'apps/mobile/android/local.properties')
if (existsSync(localProperties)) {
  const configuredPath = readFileSync(localProperties, 'utf8').match(/^sdk\.dir=(.+)$/m)?.[1].trim()
  if (configuredPath) sdkPath = configuredPath.replace(/\\:/g, ':').replace(/\\\\/g, '\\')
}
if (existsSync(join(sdkPath, 'platforms/android-36/android.jar'))) console.log('[通过] Android SDK 36')
else issues.push('未找到 Android SDK 36，请检查 SDK Manager 和 local.properties。')
if (existsSync(join(projectRoot, 'apps/mobile/android/gradle/wrapper/gradle-wrapper.jar'))) console.log('[通过] Gradle Wrapper')
else issues.push('缺少 Gradle Wrapper JAR。')

for (const issue of issues) console.log(`[待处理] ${issue}`)
if (!issues.length) console.log('基础环境已就绪。')
process.exitCode = issues.length ? 1 : 0
