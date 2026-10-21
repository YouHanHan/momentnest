# 二进制发行许可核查

项目自有代码采用 [MIT 许可证](../LICENSE)。源码仓库公开和向他人分发 Windows / Android 程序需要分别核查；安装包还携带第三方程序、原生库、模型及其许可。组件清单见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

## 当前未完成事项

2026-10-05 的本机记录显示 Windows 包使用 FFmpeg `6.1.1-essentials_build-www.gyan.dev` 和 ffprobe `4.0.2`，均启用了 GPL 相关选项。这是历史采证结果，不替代下一次实际安装依赖和打包后的检查。

当前尚未归档与这两个实际二进制准确对应的完整源码、外部依赖源码、补丁和构建资料，也未确定可持续提供这些资料的发行位置。发布 Windows 包前必须补齐；不能仅以 FFmpeg 官网、上游仓库首页或 npm 包许可证代替。

2026-10-21 重新核验了 npm 包携带的 Windows x64 ffprobe：`4.0.2`，`-L` 报告 GPLv3-or-later，SHA-256 为 `4303ec85855340689b1f8aa5d9c1dc06ef3e3090682de3034edc3fca2b0798d5`。README 记载其来源为已停运的 Zeranoe。另有 `vdirs@0.1.8` 缺少可核实的对应版权与许可全文，见 [补充许可记录](../third_party/README.md)。这些问题仍阻碍程序对外分发。

## 采集实际工具信息

在完成正常的 `npm.cmd ci` 后，于项目根目录运行以下 PowerShell 命令。输出位于忽略目录，不读取个人相册或签名材料。

```powershell
$reportDirectory = Join-Path (Get-Location) '.cache/license-audit'
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
$ffmpegExecutable = node -p "require('ffmpeg-static')"
$ffprobeExecutable = node -p "require('ffprobe-static').path"
& $ffmpegExecutable -version | Set-Content -Encoding utf8 (Join-Path $reportDirectory 'ffmpeg-version.txt')
& $ffmpegExecutable -L | Set-Content -Encoding utf8 (Join-Path $reportDirectory 'ffmpeg-license.txt')
& $ffprobeExecutable -version | Set-Content -Encoding utf8 (Join-Path $reportDirectory 'ffprobe-version.txt')
& $ffprobeExecutable -L | Set-Content -Encoding utf8 (Join-Path $reportDirectory 'ffprobe-license.txt')
Get-FileHash -Algorithm SHA256 -LiteralPath $ffmpegExecutable, $ffprobeExecutable |
  ForEach-Object { '{0}  {1}' -f $_.Hash.ToLowerInvariant(), (Split-Path $_.Path -Leaf) } |
  Set-Content -Encoding utf8 (Join-Path $reportDirectory 'tool-SHA256SUMS.txt')
```

核对打包目录内的工具哈希与这些记录一致，保留完整的 `configuration:` 输出。`--enable-gpl`、`--enable-version3` 及启用的外部库决定相关义务；若出现 `--enable-nonfree`，应停止对外分发该构建并调查。`ffprobe-static` 的 npm 声明为 MIT，不能替代其携带二进制的许可。

## 对应源码与构建资料

为每个实际二进制建立可核对的记录：

| 项目 | 应提供的内容 |
|---|---|
| 二进制身份 | 工具名、平台、架构、版本、SHA-256、获取位置 |
| FFmpeg 源码 | 对应提交或发行版本的完整源码，以及实际应用的修改和补丁 |
| 外部组件 | 按构建配置逐项核实静态链接库的版本、源码、许可及所需声明 |
| 构建方式 | 配置参数、编译及安装脚本、工具链版本和必要说明 |
| 提供方式 | 按适用许可提供对应源码；网络发行优先与二进制在同一 Release 提供源码归档和说明，确保用户能取得 |

`ffmpeg-static` 上游记录其 Windows x64 工具来自 [Gyan builds](https://www.gyan.dev/ffmpeg/builds/)，见 [上游来源说明](https://github.com/eugeneware/ffmpeg-static#sources-of-the-binaries)。这只能帮助追查来源，不能证明某个现成源码包准确对应本次二进制。无法取得对应资料时，应先解决工具构建来源，再发布携带该工具的 Windows 包。

已核实的进一步线索：Gyan 的 [6.1.1 发布记录](https://github.com/GyanD/codexffmpeg/releases/tag/6.1.1) 将 FFmpeg 本体源码指向提交 [e38092ef9395d7049f871ef4d5411eb410e283e0](https://github.com/FFmpeg/FFmpeg/commit/e38092ef9395d7049f871ef4d5411eb410e283e0)。这条来源记录没有补齐静态外部库、补丁和完整构建资料，也尚未用实际发行二进制验证对应关系。GitHub 自动生成的构建仓库源码 ZIP 不能据此当作完整对应源码。可核实线索与剩余事项见 [来源记录](../third_party/provenance.json)。

官方依据：[FFmpeg 许可说明](https://ffmpeg.org/legal.html)、[GPLv3 正文](https://www.gnu.org/licenses/gpl-3.0.html)。按实际结合和分发方式核实义务，不根据项目 MIT 许可证推断第三方工具的许可。

## 每次发行核对

- 项目 MIT 文本位于 Windows 包 `resources/app/LICENSE`；根目录 Electron 的 `LICENSE` 与 `LICENSES.chromium.html` 分别保留。
- Windows 包 `resources/app/licenses/` 收集运行依赖声明及补充原文，并携带 GPLv3 正文；检查 `npm-manifest.json` 的 `missingNotices`，对未解决项逐一补核。该收集结果不能替代模型、原生二进制及对应源码核查。
- 保留 Electron、Chromium、sharp / libvips、ONNX Runtime、FFmpeg / ffprobe、模型及实际传递依赖要求的许可和版权声明。
- Android 单独核查 Flutter、Dart、插件、Gradle 原生依赖及模型。按实际 APK 的许可资料检查，不以桌面组件表代替。
- Release 附上准确对应的源码 / 构建资料与第三方说明，说明各部分许可范围。
- 对完整 Windows ZIP、APK 和源码资料生成 `SHA256SUMS.txt`；不把私钥、签名密码、数据库、个人路径或本机 `latest.json` 加入附件。
- 在干净用户环境解压或安装核对，再记录实际验证范围；未完成的许可事项不能写成「已通过」。
