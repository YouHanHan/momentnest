# 开发说明

当前产品名称为「拾光匣 · MomentNest」，根 npm 项目为 `momentnest`，桌面 workspace 为 `@momentnest/desktop`，Dart 项目为 `momentnest_mobile`。Android 安装身份、数据目录、图标资源及本地协议独立使用 MomentNest 命名，详见 [品牌规则](branding.md)。

## 已验证的环境

| 组件 | 本机版本 |
|---|---|
| Node / npm | 23.11.0 / 11.14.0 |
| Electron | 44.4.5，内置 Node SQLite |
| Vue / electron-vite | 3.5.43 / 5.0.0 |
| Flutter / Dart | 3.38.5 / 3.10.4 |
| AGP / Gradle / Kotlin | 8.11.1 / 8.14 / 2.2.20 |
| 构建 JDK / Java 字节码 | 21 / 17 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 26 |

Windows 便携程序自带 Electron，运行无需 Node 或 Flutter。开发命令使用 PATH 中的 Node 和 Flutter；运行源码测试还需要支持 node:sqlite 与 --experimental-transform-types 的 Node 版本。表中为实际验证版本，不要求对本机工具做全局升级。

## 命令

在根目录先 npm ci、npm run models:setup；开发 Android 时再 npm run mobile:deps。依赖分别锁在 package-lock.json 与 apps/mobile/pubspec.lock。models:setup 从 OpenCV Zoo 的固定提交下载 YuNet 与 SFace，以仓库内 models/manifest.json 的 SHA-256 和大小为准；校验失败不覆盖已有模型，不更新清单或许可文本。初次需要联网，已有模型通过校验时无需联网，运行时全部使用本地模型。

Windows 桌面另需 Python 3，并运行一次 `npm.cmd run media:build -- -Python <Python可执行文件路径> -Jobs 2`，准备固定源码构建的 FFmpeg / ffprobe；内存较少时使用 `-Jobs 1`。便携编译器和构建工具只下载到项目缓存，不调整全局配置。来源清单、源码归档与各部分许可见 [本地媒体工具](../third_party/media-tools/README.md)。

模型升级需要单独审核新版本、来源与许可，显式更新清单中的固定提交、大小和哈希，并验证识别行为；不要将安装过程变为自动追随上游 main。

| 命令 | 用途 |
|---|---|
| npm run dev | Electron 开发窗口 |
| npm run build | 桌面类型检查与生产编译 |
| npm run desktop:test | 真实 HTTPS、SQLite 与文件系统恢复测试 |
| npm run desktop:ui:test | 先完成 build，再用独立 Electron 窗口、合成素材与真实 IPC 验收相册操作 |
| npm run models:setup | 下载并校验本地人脸模型，发布包及 Android assets 共用 |
| npm run media:build -- -Python <Python路径> -Jobs 2 | 从固定源码构建 Windows 媒体工具，并准备完整对应源码 ZIP |
| npm run desktop:package | 编译、递增桌面版本并生成带版本号的 Windows x64 便携目录与 EXE |
| npm run preview | 运行已编译桌面程序 |
| npm run dev:web | 仅浏览器页面预览，无原生系统能力 |
| npm run mobile:dev | Flutter 调试运行 |
| npm run mobile:analyze | Dart 静态检查 |
| npm run mobile:test | 小屏界面与 Dart → Node 协议测试 |
| npm run mobile:apk | 递增手机版本及构建号，构建并归档调试 APK |
| npm run mobile:apk:release | 递增手机版本及构建号，构建并归档正式签名 APK |
| npm run mobile:apk:all | 同一新版本同时构建调试与正式 APK |
| npm run package:test | 打包版本、交付命名及旧包保护专项验证 |
| npm run check:env | 只读环境检查 |
| npm run opensource:check | 检查源码、Git 本地可达历史及许可元数据，在 .cache/open-source 中生成脱敏报告 |

## 首次检出的验证顺序

桌面开发需要 Node 和 npm，首次准备媒体工具另需 Python 3；Android 另需上表中的 Flutter、Android SDK 与 JDK。以下命令不启动应用界面，也不分配新版本：

```powershell
npm.cmd ci
npm.cmd run models:setup
npm.cmd run media:build -- -Python <Python可执行文件路径> -Jobs 2
npm.cmd run package:test
npm.cmd run build
```

`npm ci` 的安装脚本会准备 Electron 和其他运行依赖，首次安装可能需要较长时间及可访问的上游下载地址。`npm ci --ignore-scripts` 仅可用于受限环境中的静态编译检查，不能视为已经准备好可运行或可分发的程序。

Android 首次准备执行 `npm.cmd run mobile:deps`，再运行 `mobile:analyze` 与 `mobile:test`。普通 `mobile:dev` 和非离线 APK 入口由 Flutter 准备平台工具；`--offline` 入口只适用于已完成依赖、Gradle Wrapper 和构建缓存准备的本机，不是全新检出的默认入口。

需要实际开发窗口或交付包时，再按项目启动约定检查并复用实例，使用统一入口。正式签名只由发行维护者保管；其他贡献者使用自己的调试身份，不需要也不应取得项目正式私钥。外部分发还须完成 [二进制发行许可核查](binary-distribution.md)。

Android 的 local.properties 含本机 SDK 路径，不纳入源码。若 Google Maven 在本地出现 TLS 连接错误，优先恢复正常网络；也可自行选择可信镜像。该环境本次构建使用单次 Gradle init script 将 Google Maven 地址映射到阿里云镜像，未关闭 TLS 校验，也未修改全局配置。可选示例见 scripts/android-google-mirror.init.gradle；在 apps/mobile/android 执行：

```powershell
./gradlew.bat --init-script "../../../scripts/android-google-mirror.init.gradle" :app:assembleDebug
```

标准 Flutter APK 路径是 apps/mobile/build/app/outputs/flutter-apk/app-debug.apk；直接 Gradle 的路径是 apps/mobile/build/app/outputs/apk/debug/app-debug.apk。不要误取旧目录中的历史包。调试包沿用原调试签名；正式包从本机签名目录读取持久证书，生成与备份方法见下方「应用 Logo 与 Android 正式签名」。

## 模块

桌面 main 负责窗口、来源验证和受控系统文件夹选择；preload 仅开放明确 IPC；renderer 展示服务快照。窗口启用 contextIsolation 与 sandbox，禁用 nodeIntegration，并限制导航和本地资源协议。

桌面基础交互使用 Naive UI 2.45.3，通过 UiDatePicker、UiSelect、UiPopover、UiDialog 共用中文语言、A「奶油杏桃」主题与紧凑尺寸。桌面窗口、CSS 与组件库从 `apps/desktop/src/shared/theme-palette.ts` 读取色板；手机使用 `apps/mobile/lib/gallery_style.dart` 中对应的语义色。浅杏桃填充与暖灰前景分别维护，避免为白字对比度而加深大面积按钮。桌面照片网格为四列，并与虚拟列表共用 8 像素间距；窄屏保留自适应列数，Android 主相册继续使用三列。日期保持 YYYY-MM-DD 字符串，以本地日历校验；手动输入在确认时更新，非法草稿阻止提交。临时浮层统一管理互斥与 Esc 顺序，日期与下拉挂载在所属弹窗或预览内部，避免焦点约束和全屏造成遮挡。照片画布、视频播放、缩放和翻页仍由 MediaPreview 负责，浅奶油画布与工具叠层不改变原文件、完整画面和预览分辨率。

service/worker.ts 承载 Receiver，处理 HTTPS、SQLite、历史扫描、流式哈希与文件提交。main 通过 ServiceBridge 请求工作线程；生产编译将运行依赖打包进 out，便携发布无额外 npm 安装步骤。

0.3.0 新增 MediaCatalog 负责原内容索引、多个位置、冻结导入计划与相册记录；MediaTools 使用 sharp/exifr 和随程序分发的 FFmpeg/ffprobe。两项媒体工具现在统一来自本地 `@momentnest/media-tools`，从固定源码构建，打包前校验二进制、构建脚本和对应源码的完整哈希，替代原先两个不同来源的静态工具包。FaceEngine 使用 CPU ONNX Runtime、YuNet 检测与 SFace 128 维人物特征，工作线程运行，不向界面和手机导出特征向量。便携打包复制实际安装的原生运行依赖及模型，运行应用无需用户安装 Python、Node 或媒体工具。

手机 FamilyController 与传输队列分开，复用现有完整内容身份；Android FamilyMediaEngine 在单独 executor 中进行本地模型推理、视频抽帧与 Canvas 水印。宝宝档案、人工决定和参考人脸在各自设备处理，当前手机不调用旧宝宝相册同步或电脑原文件下载入口；历史协议代码保留不代表界面提供该能力。上传及核对沿用固定证书指纹、已授权设备凭据及局域网网络绑定。

手机 HomeScreen/PairingScreen 负责页面；TransferController 管理相册、状态与队列；ReceiverApi 负责固定证书指纹的 HTTPS；LocalStore 保存任务、核对记录与安全令牌。BackgroundWork 为上传准备、同步、核对和人脸扫描分别取得后台资格，等待原生服务确认就绪后允许离开界面继续；进度通知按秒合并，系统中断统一转为暂停。

Android MomentNestApplication 持有共享 FlutterEngine 和 MediaPlatformChannels 原生工作线程，MainActivity 只持有界面相关选择器。BackgroundWorkService 根据任务启用 dataSync / mediaProcessing（Android 15 之前的本地文件处理使用 dataSync），显示通知并按实际任务持有部分 CPU 唤醒锁与传输 Wi-Fi 锁，完成或暂停后释放。服务采用 START_NOT_STICKY，不在系统强制停止后自行重启；Android 15 超时立即停止服务并通知业务保留断点。人脸缓存每 100 项或约 10 秒保存检查点，单项推理结束后再响应暂停。

## 数据可靠性

完整内容身份是 SHA-256 + size；历史匹配与当前库回执分开保存。已确认偏移只在分块写入并 fsync 后提交。临时文件保存在所选接收库的 .momentnest-incoming 中，与最终文件同卷；最终提交使用独占目标、完整哈希校验和 SQLite 事务，重启处理 committing 中间状态。

所有上传会话绑定授权设备、目标库和不可变批次日期。重放创建请求复用 clientKey；同目录同内容复用已验证回执，不能因换文件名重复写入。缺失或损坏的已保存图会在核对时识别，可重新传输。

SQLite 使用 WAL；桌面 Store 采用 records 与 locations 持久化，内容指纹、幂等键与近期时间建立索引。手机 SQLite 保存队列与核对状态，令牌不进入普通偏好记录。不要把测试数据、个人照片、配对 JSON 或证书加入源码。

桌面日常启动固定使用 `app.getPath('home')/.momentnest`，Windows 对应 `%USERPROFILE%/.momentnest`。该目录位于 AppData 之外，避免从商店应用启动时被 Windows 重定向，开发、预览、版本化 EXE 共用同一份 `receiver/receiver.sqlite`、媒体缓存及界面偏好。启动时核对物理目录；首次用 SQLite 一致快照沿用原 `%APPDATA%/momentnest/receiver` 的记录和生成缓存，并修正应用内部缓存路径，校验后启用，原目录仅作迁移备份保留。后续启动不再读取备份，不接受旧 `--momentnest-data-directory` 参数切换相册。自动化验收在加载主进程前显式设置独立目录，保持合成数据隔离。升级和普通构建不会清空数据；清除记录需用户明确授权，不删除用户选择的原媒体及导出目录。

Windows 原生 Electron 验收需在正常本机执行环境运行，使用独立数据目录和随机回环端口。受限执行环境可能使原生子进程无法加载组件并触发崩溃弹窗；遇到此情况先停止重试并检查残留测试进程，不通过修改系统错误报告或关闭应用窗口的安全隔离来绕过。

## 验证范围

自动测试使用隔离临时目录和合成数据。Flutter 协议测试会调用根目录 Node，直接与 TypeScript 接收端互通。测试不依赖个人相册或生产服务。实际模拟器联调与 Windows 便携包验收结果见 verification.md。

## 应用 Logo 与 Android 正式签名

当前 Logo 位于 `assets/branding/momentnest-logo-baby-pink.png`，采用相叠照片、明亮樱花粉与蜜桃色爱心，早期绿色原稿 `assets/branding/momentnest-logo.png` 保留。`npm run icons:build` 从当前 Logo 使用已有 sharp 依赖生成 Windows 多尺寸 ICO、PNG 与 Android 各密度启动图标；Android 自适应图标由独立前景和奶油白背景组成。原有 Flutter 默认图标文件保留，清单指向新的 `momentnest_launcher`。Windows 打包和窗口使用同一 ICO。

首次在本机执行 `npm run mobile:signing:init`，生成 RSA 3072 位、有效期 10000 天的正式签名证书。私钥、密码及 `release.properties` 位于 `.local/momentnest-signing/`，已由 `.gitignore` 的 `.local/` 规则排除。生成脚本拒绝覆盖已有文件；后续版本沿用同一证书。`momentnest-release.cer` 和 `.pem` 为不含私钥的公开证书，指纹及有效期见 `certificate-info.json`。

`npm run mobile:apk:release` 构建正式签名的分 ABI APK；`npm run mobile:apk` 仍使用原调试签名。正式构建缺少签名配置时失败，不自动回退调试证书。当前 APK 按独立应用安装，不承接其他应用记录。正式证书与调试证书不同，后续升级固定使用相同渠道与证书。签名目录需要单独妥善备份，丢失密钥后无法用相同身份发布后续升级。参见 [Android 签名规则](https://developer.android.com/studio/publish/app-signing)。

## 打包版本与交付命名

桌面与手机分别维护版本，每次交付打包将末位补丁号加 1。桌面同步根目录、桌面 `package.json` 和 `package-lock.json` 的版本；手机同步 `pubspec.yaml` 的版本名、构建号以及已有本机 `local.properties` 的 Gradle 版本字段。同轮多种 APK 用同一版本，可使用 `npm run mobile:apk:all`；分开执行调试和正式打包命令则各自递增。版本已分配后失败不回退，下一次打包继续递增。普通编译、类型检查及测试不递增版本。

Windows 目录和 EXE 使用 `MomentNest-<版本>-win32-x64/MomentNest-<版本>.exe`。Android 交付文件使用 `MomentNest-<版本>-build<构建号>-arm64-debug.apk` 与对应 `release.apk`。归档前检查 Gradle 构建清单里的真实版本名、版本码和架构，拒绝旧包改名交付；同名文件禁止覆盖，已有旧品牌交付包全部保留。各平台的 `latest.json` 记录最近产物，Windows 同时记录完整启动路径。本机启动器动态读取该路径，版本化 EXE 不影响下次启动。

Android 可加 `--arm64` 只构建 arm64；已有依赖缓存时可加 `--offline`，单次使用项目现有镜像配置和 Gradle Wrapper，不修改全局设置：

```powershell
npm.cmd run mobile:apk:all -- --offline --arm64
```

Windows PowerShell 使用 `npm.cmd` 传递以上参数，避免 `npm.ps1` 将它们识别成 npm 配置。Android 应用标识与 MomentNest 专用签名固定复用；递增的是应用版本及交付文件名。Flutter 分 ABI 时会给版本码附加架构偏移，例如构建号 19 的 arm64 APK 为 2019。
