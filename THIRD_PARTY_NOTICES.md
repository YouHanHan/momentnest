# 拾光匣第三方许可说明

项目当前保留原有授权状态，未选择项目级开源许可证。以下第三方软件和模型仍按各自许可使用，本文件不改变它们的版权与授权。

## 已核对的主要组件

版本来自本机依赖元数据、源码配置与模型许可文件。完整传递依赖和二进制分发资料应在发布具体包时一并核查；不能只根据 npm 包的许可证推断其携带二进制的许可证。

| 组件 | 当前版本或文件 | 许可与说明 |
|---|---|---|
| Electron | 44.4.5 | MIT；携带的 Chromium 等组件另有许可，保留发行目录中的 LICENSE 与 LICENSES.chromium.html |
| Vue | 3.5.43 | MIT |
| Naive UI | 2.45.3 | MIT |
| exifr | 7.1.3 | MIT |
| qrcode | 1.5.4 | MIT |
| selfsigned | 5.5.0 | MIT |
| sharp | 0.35.5 | Apache-2.0；libvips 与附带库适用各自许可，保留原生包许可文件 |
| ONNX Runtime Node | 1.30.0 | MIT；保留随包附带的第三方声明 |
| ONNX Runtime Android | 1.22.0 | MIT；依 Android 构建产物附带资料核查第三方组件 |
| ffmpeg-static 包 | 5.3.0 | GPL-3.0-or-later；对应 FFmpeg 二进制需单独核查 |
| ffprobe-static 包 | 3.1.0 | npm 包标记 MIT，其携带的 ffprobe 二进制另有 GPL 要求 |
| YuNet 模型 | face_detection_yunet_2023mar.onnx | [MIT 许可文件](models/face_detection_yunet-LICENSE.txt) |
| SFace 模型 | face_recognition_sface_2021dec.onnx | [Apache-2.0 许可文件](models/face_recognition_sface-LICENSE.txt) |

Flutter、Dart 及手机端插件按各自许可使用，完整依赖版本保存在 `apps/mobile/pubspec.lock`。打包时还需核对 Gradle 与插件携带的原生组件及声明。

模型来源、大小与 SHA-256 保存在 [模型清单](models/manifest.json)，由 [下载脚本](scripts/setup-models.mjs) 准备，发布包携带模型与原始许可文本。

## 当前 FFmpeg / ffprobe 二进制

本机 Windows x64 依赖在品牌调整时实际报告：

| 二进制 | 版本 | 构建许可相关标志 |
|---|---|---|
| ffmpeg | 6.1.1-essentials_build-www.gyan.dev | `--enable-gpl --enable-version3 --enable-static` |
| ffprobe | 4.0.2 | `--enable-gpl --enable-version3` |

两者不是仅 LGPL 的构建。`ffprobe-static` 的 npm 包标记 MIT 也不能替代 ffprobe 本身的许可要求。FFmpeg 的许可随启用的组件而变化，官方依据见 [FFmpeg 许可说明](https://ffmpeg.org/legal.html)，工具包来源见 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 与 [ffprobe-static](https://github.com/joshwnj/ffprobe-static)。

向他人分发具体 Windows 包前，应为实际携带的两个二进制补齐对应许可证、版权说明、准确对应的源码与构建配置，依适用许可证选择可核实的源码提供方式，并核查启用的外部库。只提供泛用的上游首页或宣称整个包采用 MIT 都不足以完成这项检查。

当前这份文件记录已发现的组件与待补齐资料，不宣称已完成二进制发行许可审计。首次私有源码上传不附带 Windows 程序或模型二进制；公开或向其他使用者分发安装包前继续核对。
