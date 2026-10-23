import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyRuntimeLicenses } from './third-party-licenses.mjs'
import { verifyMediaBuild } from './media-source-bundle.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const credentialRules = [
  ['private-key', '-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'],
  ['github-token', '(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})'],
  ['aws-access-key', '(AKIA|ASIA)[A-Z0-9]{16}'],
  ['slack-token', 'xox[baprs]-[A-Za-z0-9-]{20,}'],
  ['openai-key', 'sk-(proj-|svcacct-)?[A-Za-z0-9_-]{40,}'],
  ['credential-url', 'https?://[^ \t/<>:@]+:[^ \t/<>@]+@'],
]

/** 仅返回规则和行号，报告与终端不输出匹配到的凭据。 */
export function findSensitiveContent(content) {
  return content.split('\n').flatMap((line, index) => credentialRules.flatMap(([rule, pattern]) =>
    [...line.matchAll(new RegExp(pattern, 'g'))].map(() => ({ rule, line: index + 1 }))))
}

export function isSensitivePath(file) {
  if (/(^|\/)\.env\.example$/.test(file)) return false
  return /(^|\/)(\.env(\.[^/]*)?|release\.properties|key\.properties|local\.properties|\.local|\.momentnest|\.momentnest-incoming)(\/|$)|\.(jks|keystore|pfx|p12|pem|key|log|apk|aab|onnx)$|\.(db|sqlite|sqlite3)(-(shm|wal))?$/i.test(file)
}

/** 只读取本项目工作区与本地可达历史，不联网、不修改 Git 或启动应用。 */
export async function checkOpenSource(root = projectRoot) {
  const gitRoot = resolve(root).replaceAll('\\', '/')
  const git = args => execFileSync('git', ['-c', `safe.directory=${gitRoot}`, '-c', 'core.quotepath=false', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] })
  const top = resolve(git(['rev-parse', '--show-toplevel']).trim())
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
  if (normalize(top) !== normalize(resolve(root))) throw new Error('Git 顶层路径不是本项目，停止检查。')
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const findings = []
  for (const file of files) {
    if (isSensitivePath(file)) findings.push({ location: 'working-tree', file, rule: 'sensitive-path' })
    const target = join(root, file)
    let info
    try { info = await lstat(target) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink()) {
      findings.push({ location: 'working-tree', file, rule: 'symlink-needs-review' })
      continue
    }
    if (!info.isFile()) continue
    const bytes = await readFile(target)
    if (bytes.subarray(0, 8192).includes(0)) continue
    for (const hit of findSensitiveContent(bytes.toString('utf8'))) findings.push({ location: 'working-tree', file, ...hit })
  }

  const revisions = git(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean)
  const historyPaths = new Set(git(['log', '--all', '--format=', '--name-only', '-z']).split(/[\0\r\n]/).filter(Boolean))
  for (const file of historyPaths) if (isSensitivePath(file)) findings.push({ location: 'history', file, rule: 'sensitive-path' })
  // git grep 只返回文件名，任何凭据内容都不会进入报告或异常日志。
  for (const revision of revisions) {
    const args = ['grep', '-I', '-l', '-z', '-E', '-e', credentialRules.map(([, pattern]) => `(${pattern})`).join('|'), revision, '--']
    let matches
    try { matches = git(args) }
    catch (error) { if (error.status === 1) continue; throw new Error('Git 历史内容检查失败，请检查本机 Git。') }
    for (const match of matches.split('\0').filter(Boolean)) {
      findings.push({ location: 'history', revision, file: match.slice(revision.length + 1), rule: 'credential-pattern' })
    }
  }

  const readJson = async file => JSON.parse(await readFile(join(root, file), 'utf8'))
  const [project, desktop, lock, models, license] = await Promise.all([
    readJson('package.json'), readJson('apps/desktop/package.json'), readJson('package-lock.json'),
    readJson('models/manifest.json'), readFile(join(root, 'LICENSE'), 'utf8'),
  ])
  const licenseMetadataMatches = license.startsWith('MIT License') &&
    [project, desktop, lock.packages?.[''], lock.packages?.['apps/desktop']].every(item => item?.license === 'MIT')
  const desktopVersionsMatch = [project, desktop, lock, lock.packages?.[''], lock.packages?.['apps/desktop']]
    .every(item => item?.version === project.version)
  const modelsPinned = Array.isArray(models) && models.length > 0 && models.every(model =>
    /^[a-f0-9]{64}$/.test(model.sha256) && Number.isSafeInteger(model.size) && model.size > 0 &&
    /^https:\/\/raw\.githubusercontent\.com\/opencv\/opencv_zoo\/[a-f0-9]{40}\/models\/face_[a-z_]+\/[a-z0-9_]+\.onnx$/.test(model.source))

  const outputRoot = join(root, '.cache', 'open-source')
  await mkdir(outputRoot, { recursive: true })
  const directory = await mkdtemp(join(outputRoot, 'check-'))
  let runtimeLicenses
  try {
    const collected = await copyRuntimeLicenses(root, join(directory, 'licenses'))
    runtimeLicenses = { status: collected.missingNotices.length ? 'needs-review' : 'collected',
      packages: collected.dependencies.length, missingNotices: collected.missingNotices }
  } catch {
    runtimeLicenses = { status: 'unavailable', nextStep: '请完成 npm ci 后重跑，并核查运行依赖及补充许可文件。' }
  }
  const sourceChecksPassed = !findings.length && licenseMetadataMatches && desktopVersionsMatch && modelsPinned
  let mediaTools
  try {
    const verified = await verifyMediaBuild(root)
    mediaTools = { status: 'verified', version: verified.manifest.version, sourceBundle: verified.build.sourceBundle }
  } catch {
    mediaTools = { status: 'unavailable', nextStep: '请先运行 media:build，核对实际工具与完整对应源码。' }
  }
  const report = {
    generatedAt: new Date().toISOString(), commit: git(['rev-parse', 'HEAD']).trim(), version: project.version,
    sourceChecksPassed, checkedFiles: files.length, checkedLocalRevisions: revisions.length,
    checks: { licenseMetadataMatches, desktopVersionsMatch, modelsPinned }, findings, runtimeLicenses, mediaTools,
    manualReview: [
      { id: 'copyright-and-assets', status: 'pending', detail: '维护者确认 LICENSE 署名及代码、图标、截图和素材的授权权利。' },
      { id: 'private-vulnerability-reporting', status: 'pending', detail: '公开仓库后启用并检查 GitHub 私密漏洞报告入口。' },
      { id: 'binary-distribution-review', status: 'pending', detail: '媒体工具哈希与源码结果见 mediaTools；发行时另核查 Electron、其他原生库、模型及 APK 的许可资料，并同时提供程序与媒体工具源码 ZIP。' },
    ],
    limitations: ['常见凭据模式检查不能证明没有秘密；二进制媒体内容不在文本检查范围内。',
      '只覆盖本地可达 Git 历史；不读取远程不可见引用，不替代法律审查、真机验证或完整安全审计。'],
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  const missingNotices = runtimeLicenses.status === 'unavailable' ? '未完成采集' : runtimeLicenses.missingNotices.join('、') || '无'
  const summary = [
    '# 开源整备检查结果', '',
    `- 源码自动检查：${sourceChecksPassed ? '通过' : '发现待处理项'}`,
    `- 源码文件：${files.length}；本地可达提交：${revisions.length}`,
    `- 运行依赖许可：${runtimeLicenses.status}；缺少声明：${missingNotices}`,
    `- 媒体工具与对应源码：${mediaTools.status}`,
    '- 版权与素材权利、GitHub 安全入口、二进制发行资料仍需按 report.json 人工确认。', '',
    '自动检查通过仅说明本次已检查项目通过，不表示已批准公开仓库或分发程序。', '',
    ...findings.map(item => `- ${item.location}：${item.file}${item.line ? `:${item.line}` : ''}（${item.rule}）`), '',
  ].join('\n')
  await writeFile(join(directory, 'README.md'), summary)
  return { report, directory }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, directory } = await checkOpenSource()
    console.log(`源码自动检查：${report.sourceChecksPassed ? '通过' : '发现待处理项'}`)
    console.log(`源码文件 ${report.checkedFiles}，本地可达提交 ${report.checkedLocalRevisions}，敏感模式或路径命中 ${report.findings.length}。`)
    const missingNotices = report.runtimeLicenses.status === 'unavailable' ? '未完成采集' : report.runtimeLicenses.missingNotices.join('、') || '无'
    console.log(`运行依赖许可：${report.runtimeLicenses.status}；缺少声明：${missingNotices}。`)
    console.log(`媒体工具与对应源码：${report.mediaTools.status}。`)
    console.log(`脱敏报告：${relative(projectRoot, join(directory, 'report.json')).replaceAll('\\', '/')}`)
    console.log('版权与素材、安全报告入口、二进制发行资料仍需人工核查。')
    process.exitCode = report.sourceChecksPassed ? 0 : 1
  } catch {
    console.error('开源整备检查未完成，请确认当前目录为本项目且 Git 和源码文件可读；不输出原始内容。')
    process.exitCode = 1
  }
}
