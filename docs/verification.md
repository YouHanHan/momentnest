# MomentNest 当前验收记录

## 2026-10-21：媒体工具与发行资料补齐

- Windows 统一打包入口实际生成 **0.4.36**，同步源码及锁文件版本，保留旧包；Android 版本仍为 **0.4.25+36**，本轮未构建 APK。
- FFmpeg 和 ffprobe 都从 6.1.1 的固定源码构建，外部库为固定提交的 x264、dav1d、zlib；构建工具只位于项目缓存，不修改全局安装或系统设置。
- 生成实际 Windows ZIP（339,170,568 字节）、完整媒体工具对应源码 ZIP（19,278,356 字节）及 `SHA256SUMS.txt`。源码 ZIP 包含四个完整源码归档、构建脚本、工具清单、实际二进制哈希和许可证。
- 26 项构建 / 许可脚本测试通过；49 项桌面相关测试通过，包含实际视频元数据、缩略图、抽帧、水印预览与导出及原视频完整性。
- 类型检查、生产编译和实际便携包构建通过；从最终便携包加载媒体工具路径、执行版本命令并核对工具哈希，确认两项工具同版。两项 EXE 仅依赖 Windows 系统 DLL。
- 最终包保留项目 MIT、Electron LICENSE 与 LICENSES.chromium.html；运行依赖许可清单覆盖 119 个包，缺少声明列表为空。包旁的媒体源码 ZIP 与包内构建记录哈希一致。
- `main` 的 PR 要求、管理员受限、禁止强推 / 删除及讨论解决规则已通过 GitHub API 回查，审批人数为 0，支持单人维护。

本轮没有启动 Electron 图形窗口，没有进行 Android、实体设备或全新电脑安装验收；不将原生工具和结构验证写成真实设备验证。其他原生库及 Android 发行资料仍按具体产物核查。媒体工具源码 ZIP 只对应新工具，不为历史 Gyan / Zeranoe 二进制补作证明。

## 2026-10-05：独立应用身份的历史验收

本轮以独立应用身份重新构建，旧参考工程和历史品牌文档已清理；功能与后续计划见 [首页](../README.md) 和 [开发计划](development-plan.md)。

## 源码与身份

- 当前源码清单 272 个文件，旧品牌名称扫描无匹配，常见令牌和私钥格式无匹配，本地文档链接有效。
- 既有业务代码注释保留，npm 依赖版本未变，桌面源码与锁文件版本一致。
- Android 应用 ID 与 Kotlin namespace 为 dev.momentnest.app，平台通道和私有数据库使用 MomentNest 命名。
- Windows 使用 .momentnest、momentnest:// 和 window.momentnest；图标和临时分块目录同步命名。
- 正式签名来自独立忽略目录 .local/momentnest-signing，安装包内不包含私钥。

## 自动化与实际启动

| 检查 | 实际结果 |
|---|---|
| 桌面 TypeScript / Vue 类型检查 | 通过 |
| 统一打包入口专项测试 | 6/6 通过 |
| 桌面功能测试 | 首次 403/404 通过；1 项界面启动等待超时，独立复测 1/1 通过 |
| Flutter 静态分析 | 无问题 |
| Flutter 测试 | 191/191 通过 |
| 实际 Electron 启动与 IPC | 隔离记录目录下通过；新协议和接口可用，库、设备、文件和宝宝记录均为空 |
| Electron 安全配置 | contextIsolation: true、sandbox: true、nodeIntegration: false |

桌面首次超时发生在测试页等待 .family-workspace 显示阶段，单独复测通过。本轮未改动预览业务逻辑。受限执行环境首次 Electron GPU 子进程无法加载 DLL；相同隔离启动验证在正常本机权限下通过。

既有桌面布局问题仍待处理：820×600 预览高度、信息栏独立滚动及中文日历可见性。本轮未重跑完整布局套件，不宣称全部界面布局验收通过。

## 实际构建与交付

- Windows x64：0.4.35，使用 desktop:package 实际构建；EXE ProductName 为拾光匣，FileVersion 与 ProductVersion 均为 0.4.35。
- Android arm64：0.4.25+36，同轮调试和正式包使用 mobile:apk:all 实际构建；包内 versionCode 为 2036，applicationId 为 dev.momentnest.app，显示名称为拾光匣。
- 两种 APK 均通过 apksigner 验签；正式证书与本轮 MomentNest 证书一致，调试和正式证书分别管理。
- Windows ZIP 包含完整便携目录，交付同时提供两种 APK、SHA256SUMS.txt 和本地 delivery-verification.json。
- 实际交付位于 release 下本轮生成目录；版本化旧交付包保留，未以改文件名制作新包。

## 应用记录与设备范围

维护者明确授权按全新应用开始。本机旧桌面数据库、TLS 身份及界面状态已清理：9 个记录文件、3 个状态目录；媒体与生成图片缓存保留。新应用不读取其他安装身份下的旧相册、宝宝档案或配对信息。

当前没有连接 Android 设备，未进行真机安装、设备内旧应用数据清除或真实个人图库验收。新 APK 按独立应用安装，使用者重新建档、授权照片库并配对。

源码仓库保持私有，本轮安装包尚未发布 GitHub Release。二进制对外分发前仍需补齐 [第三方许可资料](../THIRD_PARTY_NOTICES.md)，尤其 FFmpeg 的对应源码与构建信息。
