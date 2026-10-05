# MomentNest 当前验收记录

日期：2026-10-05。本轮以独立应用身份重新构建，旧参考工程和历史品牌文档已清理；功能与后续计划见 [首页](../README.md) 和 [开发计划](development-plan.md)。

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
