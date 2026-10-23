# 二进制发行许可核查

项目自有代码采用 [MIT 许可证](../LICENSE)。独立 FFmpeg / ffprobe 程序与静态运行库采用各自的许可；原文件备份与媒体预览的行为约束不因许可证准备而改变。

## 新的媒体工具构建

当前源码已替换原 `ffmpeg-static` 与 `ffprobe-static`，使用本地 [@momentnest/media-tools](../third_party/media-tools/README.md)。FFmpeg 与 ffprobe 都来自 6.1.1 的同一固定提交。外部库仅启用 x264、dav1d 和 zlib，关闭自动发现额外库与 FFmpeg 网络协议；内建 H.264、HEVC、VP9、JPEG、PNG 等解码能力继续由 FFmpeg 提供，AV1 解码来自 dav1d，视频水印沿用 x264 与 AAC。

所有运行库的完整源码归档、下载位置、提交、大小及 SHA-256 固定于 [构建清单](../third_party/media-tools/build-manifest.json)，实际构建脚本为 `scripts/build-media-tools.ps1`。构建工具只下载到项目缓存，不进行全局安装。未修改四个运行库的上游源码。

准备命令：

```powershell
npm.cmd run media:build -- -Python <Python可执行文件路径> -Jobs 2
```

可用内存较少时使用 `-Jobs 1`。构建脚本对 GCC 的内存回收参数进行显式记录，每轮使用独立源码、安装前缀和构建目录；只复用通过完整指纹核验的下载包与已准备的工具链，不复用旧源码或编译结果，不降低图像解码或导出质量。

构建成功后：

- `third_party/media-tools/bin/win32-x64/` 包含两项工具和 `build-info.json`，该生成目录不提交 Git。
- 包内 `licenses/` 保留 FFmpeg、x264、dav1d、zlib 及 MinGW-w64 运行时声明；JavaScript 路径适配代码仍按项目 MIT 授权。
- `.cache/media-tool-build/archives/` 包含对应源码 ZIP：四个完整运行库源码压缩包、固定工具链清单、实际构建脚本、许可及实际二进制哈希。
- 便携编译器、Meson、Ninja、NASM 属于通用构建工具，版本及校验信息列入清单；源码 ZIP 里的构建入口会按该清单准备它们。

桌面打包在分配新版本前核验媒体二进制、清单、构建脚本与源码 ZIP 的 SHA-256。任何一项缺失或不符均停止，不能拿旧工具、其他版本的源码或上游首页代替。实际生成的源码 ZIP 会放到本轮便携目录旁。

## 对外发布时提供的附件

同一 Release 至少同时提供：

```text
MomentNest-<桌面版本>-win32-x64.zip
MomentNest-media-tools-6.1.1-<构建指纹>-sources.zip
SHA256SUMS.txt
```

Windows ZIP 包含完整便携目录。媒体工具源码 ZIP 与程序 ZIP 保持可下载，并在 Release 说明中链接，保留 GPLv3、各运行库和编译器运行时的版权声明。程序或媒体工具变化后，重新构建、核验和生成对应源码，不复用旧构建指纹。

发布前核对实际便携目录中的工具哈希与 `build-info.json` 一致；确认源码 ZIP 内包含四个源归档、构建脚本和清单，不把 GitHub 自动生成的构建仓库源码 ZIP 当成完整对应源码。

## 历史预构建包

旧 Windows 包曾携带 Gyan FFmpeg `6.1.1-essentials_build-www.gyan.dev` 与来源已停运的 Zeranoe ffprobe `4.0.2`。它们的完整对应资料未核实，来源追溯保存在 [历史记录](../third_party/provenance.json)。新源码归档只对应本项目新构建的工具，不能为旧包补作证明。

旧包保留。后续交付必须从当前源码重新打包，使用统一入口递增版本，并为实际新产物生成校验值，不能只改旧包文件名。

## 其他第三方组件

运行依赖声明由 `scripts/third-party-licenses.mjs` 收集，覆盖编入 JavaScript 的依赖，生成 `resources/app/licenses/npm-manifest.json`。`vdirs@0.1.8` 的 MIT 标准正文和作者归属按已发布 npm 元数据整理，记录其依据并检查版本、作者、许可一致性，不声称找到了上游原始 LICENSE。

每次发行还应核查 Electron / Chromium、sharp / libvips、ONNX Runtime、模型及其他实际原生组件的声明；保留 Electron 根目录的 LICENSE 与 LICENSES.chromium.html。项目 LICENSE 位于 `resources/app/LICENSE`，不替换 Electron 自己的许可。

Android 单独核查 Flutter、Dart、插件、Gradle 原生依赖及模型，核对正式签名、版本与架构。Windows 的媒体工具源码归档不代表 Android 的所有发行资料已经完成。

不将私钥、签名密码、数据库、个人路径或本机 `latest.json` 加入 Release 附件。对程序 ZIP、源码 ZIP 和 APK 生成准确的 `SHA256SUMS.txt`，并区分结构检查、实际构建和真机验证。

依据：[FFmpeg 许可说明](https://ffmpeg.org/legal.html)、[GPLv3 正文](https://www.gnu.org/licenses/gpl-3.0.html)。本轮补齐的是媒体工具的可追溯构建与源码提供机制，不冒充所有平台、所有组件的法律审计结论。
