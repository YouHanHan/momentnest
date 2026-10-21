# 拾光匣第三方许可说明

项目自有代码采用 [MIT 许可证](LICENSE)。以下第三方软件和模型仍按各自许可使用，项目的 MIT 声明不改变它们的版权与授权，也不表示整个安装包的所有组件都采用 MIT。

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
| 本地 FFmpeg / ffprobe | 6.1.1，两项工具同一源码构建 | 独立工具为 GPL-3.0-or-later；自有 JavaScript 路径适配代码为 MIT，随包提供对应源码 ZIP |
| x264 | 固定提交 `31e19f92f00c7003fa115047ce50978bc98c3a0d` | GPL-2.0-or-later，与当前 FFmpeg 构建按 GPLv3-or-later 分发 |
| dav1d | 1.5.1，固定提交 `42b2b24fb8819f1ed3643aa9cf2a62f03868e3aa` | BSD-2-Clause，保留版权声明 |
| zlib | 1.3.1，固定提交 `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` | Zlib，保留原始声明 |
| YuNet 模型 | face_detection_yunet_2023mar.onnx | [MIT 许可文件](models/face_detection_yunet-LICENSE.txt) |
| SFace 模型 | face_recognition_sface_2021dec.onnx | [Apache-2.0 许可文件](models/face_recognition_sface-LICENSE.txt) |

Flutter、Dart 及手机端插件按各自许可使用，完整依赖版本保存在 `apps/mobile/pubspec.lock`。打包时还需核对 Gradle 与插件携带的原生组件及声明。

桌面打包收集实际运行依赖的许可、版权和 NOTICE，覆盖编入 JavaScript 的依赖，生成 `resources/app/licenses/npm-manifest.json`。缺少随包许可的已核实版本使用 [补充许可资料](third_party/README.md)，上游来源和文件哈希逐项记录。`vdirs@0.1.8` 按作者在 npm 中发布的 MIT 与作者声明附上标准许可正文，并标注整理依据，不冒充上游原始 LICENSE。这里的组件表不替代 Electron、原生库、Android 插件等实际二进制的发行核查。

模型来源、大小与 SHA-256 保存在 [模型清单](models/manifest.json)，下载地址固定到 OpenCV Zoo 提交 `48b10fa505aeb51fbd127fc60a5c660040e823b7`，由 [下载脚本](scripts/setup-models.mjs) 按清单准备。原始许可文本随源码保留，安装准备不会自动覆盖清单或许可文件；发布包携带模型与许可文本。

## 当前媒体工具与对应源码

当前源码不再使用 `ffmpeg-static`、`ffprobe-static`。本地包 [@momentnest/media-tools](third_party/media-tools/README.md) 从固定提交构建两项独立工具，外部运行库仅启用 x264、dav1d 和 zlib，禁用自动发现外部库和非本地输入协议。所有运行库源码、固定构建工具清单及哈希见 [构建清单](third_party/media-tools/build-manifest.json)。

构建成功时生成含四个完整源码归档、实际构建脚本、许可、版本和二进制哈希的源码 ZIP。桌面打包先核验二进制、构建脚本及源码 ZIP 的 SHA-256，再将该 ZIP 放在便携程序目录旁。对外分发时，在同一 Release 同时提供 Windows 程序 ZIP 与对应源码 ZIP，保留其许可和版权说明；不能只上传程序或泛用上游链接。操作见 [二进制发行许可核查](docs/binary-distribution.md)。

## 历史预构建工具（不适用于新工具）

本机 Windows x64 依赖在品牌调整时实际报告：

| 二进制 | 版本 | 构建许可相关标志 |
|---|---|---|
| ffmpeg | 6.1.1-essentials_build-www.gyan.dev | `--enable-gpl --enable-version3 --enable-static` |
| ffprobe | 4.0.2 | `--enable-gpl --enable-version3` |

两者不是仅 LGPL 的构建。`ffprobe-static` 的 npm 包标记 MIT 也不能替代 ffprobe 本身的许可要求。FFmpeg 的许可随启用的组件而变化，官方依据见 [FFmpeg 许可说明](https://ffmpeg.org/legal.html)，工具包来源见 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 与 [ffprobe-static](https://github.com/joshwnj/ffprobe-static)。

2026-10-21 按锁文件重新安装后，实际执行 `ffprobe -version` 和 `-L` 再次确认 Windows x64 工具为 `4.0.2`、GPLv3-or-later，SHA-256 为 `4303ec85855340689b1f8aa5d9c1dc06ef3e3090682de3034edc3fca2b0798d5`。包内 README 将 Windows 来源指向现已停运的 Zeranoe 服务；不能据此假定对应构建源码仍可取得。

历史包的完整对应源码及构建资料仍未核实；本次自行构建生成的源码 ZIP 只对应新工具，不能用于为旧 Gyan / Zeranoe 二进制补作证明。旧包保留，后续交付从当前源码重新构建并按统一入口递增版本。

源码仓库不包含媒体工具、模型或构建缓存的二进制。新的源码归档机制补齐媒体工具的资料对应关系，不宣称已完成所有平台和组件的法律或二进制发行审计。
