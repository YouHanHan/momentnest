import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { nsisVersion, windowsInstallerCompiler } from './setup-windows-installer.mjs'

/** 转义安装脚本字面量，文件名不能变成 NSIS 变量或额外指令。 */
export function nsisLiteral(value, { escapeVariables = true } = {}) {
  if (/[\r\n\0]/.test(value)) throw new Error('安装路径包含无效字符。')
  // 编译期文件路径保持美元符号，运行期路径转义为 NSIS 字面量。
  const escaped = escapeVariables ? value.replaceAll('$', () => '$$') : value
  return escaped.replaceAll('"', '$\\"')
}

/** 只收录实际程序文件，拒绝符号链接、私有记录和签名材料。 */
export async function installerPayload(directory) {
  const files = []
  async function walk(folder) {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`安装文件不能包含符号链接：${path}`)
      if (metadata.isDirectory()) await walk(path)
      else if (metadata.isFile()) {
        const item = relative(directory, path).replaceAll('\\', '/')
        if (/(?:^|\/)(?:\.local|\.cache|\.momentnest|\.env(?:\.[^/]*)?)(?:\/|$)|\.(?:jks|keystore|key|pem|sqlite|sqlite3|db)(?:-|$)/i.test(item)) {
          throw new Error(`安装文件包含私有资料：${item}`)
        }
        nsisLiteral(item)
        files.push({ path: item, size: metadata.size })
      }
    }
  }
  await walk(directory)
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

/** 从明确文件清单生成安装与卸载指令，不递归删除用户添加的文件。 */
export function installerScript({ directory, destination, icon, version, files }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('安装包版本格式无效。')
  const exe = `MomentNest-${version}.exe`
  if (!files.some(item => item.path === exe)) throw new Error('安装文件清单缺少本轮 EXE。')
  const q = nsisLiteral
  const folders = new Set()
  const install = []
  let currentFolder
  for (const item of files) {
    const folder = dirname(item.path).replaceAll('\\', '/')
    if (folder !== currentFolder) {
      install.push(`  SetOutPath "$INSTDIR${folder === '.' ? '' : '\\' + q(folder.replaceAll('/', '\\'))}"`)
      currentFolder = folder
    }
    install.push(`  File "/oname=${q(basename(item.path))}" "${q(join(directory, item.path), { escapeVariables: false })}"`)
    for (let parent = folder; parent !== '.'; parent = dirname(parent).replaceAll('\\', '/')) folders.add(parent)
  }
  const uninstall = files.map(item => `  Delete "$INSTDIR\\${q(item.path.replaceAll('/', '\\'))}"`)
  for (const folder of [...folders].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
    uninstall.push(`  RMDir "$INSTDIR\\${q(folder.replaceAll('/', '\\'))}"`)
  }
  const kilobytes = Math.ceil(files.reduce((total, file) => total + file.size, 0) / 1024)
  return `Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

Name "拾光匣 · MomentNest"
OutFile "${q(destination, { escapeVariables: false })}"
InstallDir "$LOCALAPPDATA\\Programs\\MomentNest"
InstallDirRegKey HKCU "Software\\MomentNest" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
CRCCheck force
Icon "${q(icon, { escapeVariables: false })}"
UninstallIcon "${q(icon, { escapeVariables: false })}"
VIProductVersion "${version}.0"
VIAddVersionKey /LANG=2052 "ProductName" "拾光匣 · MomentNest"
VIAddVersionKey /LANG=2052 "CompanyName" "MomentNest"
VIAddVersionKey /LANG=2052 "FileDescription" "拾光匣安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${version}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${version}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MomentNest"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "欢迎安装拾光匣"
!define MUI_WELCOMEPAGE_TEXT "将家庭照片收好，让成长有迹可循。$\\r$\\n$\\r$\\n安装后可从桌面或开始菜单打开拾光匣。升级前请先关闭正在运行的拾光匣。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\\${exe}"
!define MUI_FINISHPAGE_RUN_TEXT "启动拾光匣"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载将移除拾光匣程序及快捷方式。相册记录和照片、视频会保留。"
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  \${IfNot} \${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 64 位 Windows。" /SD IDOK
    SetErrorLevel 1
    Abort
  \${EndIf}
FunctionEnd

; 只安装到空目录或本应用的安装目录，避免覆盖其他目录中的文件。
Function ValidateInstallDirectory
  \${GetRoot} "$INSTDIR" $0
  \${If} $INSTDIR == $0
    MessageBox MB_OK|MB_ICONSTOP "请选择独立的程序文件夹。" /SD IDOK
    SetErrorLevel 1
    Abort
  \${EndIf}
  IfFileExists "$INSTDIR\\." 0 directory_ok
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r0'
  IntOp $0 $0 & 0x400
  \${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "安装目录不能是目录联接或符号链接。" /SD IDOK
    SetErrorLevel 1
    Abort
  \${EndIf}
  ReadINIStr $0 "$INSTDIR\\momentnest-installation.ini" "Application" "Id"
  \${If} $0 == "dev.momentnest.desktop"
    Return
  \${EndIf}
  FindFirst $0 $1 "$INSTDIR\\*.*"
  directory_next:
    \${If} $1 == ""
      FindClose $0
      Goto directory_ok
    \${EndIf}
    \${If} $1 != "."
    \${AndIf} $1 != ".."
      FindClose $0
      MessageBox MB_OK|MB_ICONSTOP "此文件夹已有其他文件，请选择空文件夹。" /SD IDOK
      SetErrorLevel 1
      Abort
    \${EndIf}
    FindNext $0 $1
    Goto directory_next
  directory_ok:
FunctionEnd

; 已运行的程序必须先关闭，安装和卸载都不强制结束用户进程。
!macro CheckApplicationClosed
  ReadINIStr $1 "$INSTDIR\\momentnest-installation.ini" "Application" "Executable"
  \${If} $1 != ""
    \${GetFileName} "$1" $2
    \${If} $1 != $2
      SetErrorLevel 1
      Abort
    \${EndIf}
    IfFileExists "$INSTDIR\\$1" 0 application_closed
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\\$1", i 0xC0000000, i 0, p 0, i 3, i 0x80, p 0) p .r0'
    \${If} $0 == -1
      MessageBox MB_OK|MB_ICONSTOP "请先关闭拾光匣，再继续安装或卸载。" /SD IDOK
      SetErrorLevel 1
      Abort
    \${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  \${EndIf}
  application_closed:
!macroend

Section "安装拾光匣"
  Call ValidateInstallDirectory
  !insertmacro CheckApplicationClosed
  IfFileExists "$INSTDIR\\Uninstall.exe" 0 install_files
  ExecWait '$\\"$INSTDIR\\Uninstall.exe$\\" /S _?=$INSTDIR' $0
  \${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "旧版本未完成卸载，请关闭程序后重试。" /SD IDOK
    SetErrorLevel 1
    Abort
  \${EndIf}
  Delete "$INSTDIR\\Uninstall.exe"
  install_files:
${install.join('\n')}
  SetOutPath "$INSTDIR"
  WriteINIStr "$INSTDIR\\momentnest-installation.ini" "Application" "Id" "dev.momentnest.desktop"
  WriteINIStr "$INSTDIR\\momentnest-installation.ini" "Application" "Version" "${version}"
  WriteINIStr "$INSTDIR\\momentnest-installation.ini" "Application" "Executable" "${exe}"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\\拾光匣"
  CreateShortCut "$DESKTOP\\拾光匣.lnk" "$INSTDIR\\${exe}" "" "$INSTDIR\\${exe}" 0
  CreateShortCut "$SMPROGRAMS\\拾光匣\\拾光匣.lnk" "$INSTDIR\\${exe}" "" "$INSTDIR\\${exe}" 0
  CreateShortCut "$SMPROGRAMS\\拾光匣\\卸载拾光匣.lnk" "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\MomentNest" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "DisplayName" "拾光匣 · MomentNest"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "DisplayVersion" "${version}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "Publisher" "MomentNest"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "DisplayIcon" "$INSTDIR\\${exe}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "UninstallString" '$\\"$INSTDIR\\Uninstall.exe$\\"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "QuietUninstallString" '$\\"$INSTDIR\\Uninstall.exe$\\" /S'
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "EstimatedSize" ${kilobytes}
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  ReadINIStr $0 "$INSTDIR\\momentnest-installation.ini" "Application" "Id"
  \${If} $0 != "dev.momentnest.desktop"
    MessageBox MB_OK|MB_ICONSTOP "无法确认安装目录，卸载已停止。" /SD IDOK
    SetErrorLevel 1
    Abort
  \${EndIf}
  !insertmacro CheckApplicationClosed
FunctionEnd

Section "Uninstall"
${uninstall.join('\n')}
  Delete "$INSTDIR\\momentnest-installation.ini"
  Delete "$INSTDIR\\Uninstall.exe"
  Delete "$DESKTOP\\拾光匣.lnk"
  Delete "$SMPROGRAMS\\拾光匣\\拾光匣.lnk"
  Delete "$SMPROGRAMS\\拾光匣\\卸载拾光匣.lnk"
  RMDir "$SMPROGRAMS\\拾光匣"
  DeleteRegKey HKCU "Software\\MomentNest"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MomentNest"
  RMDir "$INSTDIR"
SectionEnd
`
}

/** 对本轮真实便携目录构建同版本安装包，并写出交付哈希。 */
export async function buildWindowsInstaller({ root, directory, version, compiler = windowsInstallerCompiler(root) }) {
  const actual = await realpath(directory)
  const releasePath = relative(await realpath(join(root, 'release')), actual)
  if (!releasePath || releasePath.startsWith('..') || isAbsolute(releasePath)) throw new Error('程序目录必须位于项目 release 内。')
  if (basename(actual) !== `MomentNest-${version}-win32-x64`) throw new Error('程序目录与本轮版本不一致。')
  const metadata = JSON.parse(await readFile(join(actual, 'resources', 'app', 'package.json'), 'utf8'))
  if (metadata.version !== version || metadata.name !== 'momentnest') throw new Error('程序包版本或身份不一致。')
  for (const path of ['resources/app/out/main/index.js', 'resources/app/out/renderer/index.html', 'resources/app/models/face_detection_yunet_2023mar.onnx', 'resources/app/models/face_recognition_sface_2021dec.onnx']) await access(join(actual, path))
  await copyFile(join(dirname(compiler), 'COPYING'), join(actual, 'resources', 'app', 'NSIS-COPYING.txt'))
  const files = await installerPayload(actual)
  const output = dirname(actual)
  const name = `MomentNest-${version}-win32-x64-Setup.exe`
  const destination = join(output, name)
  try { await access(destination); throw new Error('已有同名安装包，拒绝覆盖。') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const script = join(output, `MomentNest-${version}-installer.nsi`)
  await writeFile(script, installerScript({ directory: actual, destination, icon: join(root, 'assets', 'branding', 'momentnest.ico'), version, files }), { flag: 'wx' })
  await writeFile(join(output, 'installer-payload.json'), JSON.stringify({ version, files }, null, 2))
  console.log(`正在构建 Windows 安装包（${files.length} 个程序文件）：${name}`)
  await new Promise((resolveBuild, reject) => {
    const process = spawn(compiler, ['/NOCONFIG', '/INPUTCHARSET', 'UTF8', '/V3', script], { stdio: 'inherit', windowsHide: true })
    process.once('error', reject)
    process.once('exit', code => code === 0 ? resolveBuild() : reject(new Error(`NSIS 安装包构建失败：${code}`)))
  })
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(destination)) hash.update(chunk)
  const sha256 = hash.digest('hex')
  await writeFile(join(output, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`, { flag: 'wx' })
  return { path: resolve(destination), filename: name, sha256, compilerVersion: nsisVersion, payloadFiles: files.length }
}
