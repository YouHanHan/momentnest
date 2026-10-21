# 固定源码构建的媒体工具

此本地包提供 Windows x64 的 FFmpeg 和 ffprobe 路径，供桌面服务与测试共用。两个程序都从 FFmpeg 6.1.1 的固定提交构建，外部运行库仅启用同样固定源码的 x264、dav1d 和 zlib。关闭自动发现外部依赖及 FFmpeg 网络协议，避免不同电脑的构建静默引入其他库。相册局域网传输仍由原接收服务处理。

JavaScript 路径适配代码采用项目 MIT 许可证，见 `LICENSE`；独立媒体可执行程序采用 GPL-3.0-or-later，各个静态运行库适用自己的许可证，原文在 `licenses/`。包元数据的复合声明表示这些不同部分各自适用的许可，不将媒体程序改授 MIT。

在项目根目录准备一次：

```powershell
npm.cmd run media:build -- -Python <Python可执行文件路径> -Jobs 2
```

需要 Python 3、Node.js 22.12+ 和 Windows 自带的 `tar.exe`。编译器、NASM、Meson 与 Ninja 由脚本下载到项目 `.cache`，按清单校验 SHA-256，不做全局安装；可用内存较少时使用 `-Jobs 1`。首次编译需要时间，失败后复用已核实的下载和编译结果。

`build-manifest.json` 固定源码提交、下载 URL、工具版本、大小和 SHA-256。`scripts/build-media-tools.ps1` 是实际构建与安装脚本，没有修改四个库的上游源码。所有工具输出都在项目目录内，只有当前构建进程的环境变量会临时调整，结束后恢复。

成功后，`bin/win32-x64/` 包含两个可执行文件及 `build-info.json`。`scripts/media-source-bundle.mjs` 将四个库的完整源码压缩包、许可、构建脚本、固定工具清单和二进制哈希归档到 `.cache/media-tool-build/archives/`。Windows 打包入口先核对这些记录，再将源码 ZIP 放到便携目录旁；Release 需同时提供程序 ZIP 和对应源码 ZIP。

旧包携带的 Gyan FFmpeg 与 Zeranoe ffprobe 不因此获得新的发行证明。后续交付必须重新构建应用并递增版本，不能将新源码资料挂到旧包名下。版本和平台范围见 [开发说明](../../docs/development.md)。
