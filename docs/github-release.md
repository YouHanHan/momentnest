# 拾光匣 GitHub 发布准备

源码仓库为 [YouHanHan/momentnest](https://github.com/YouHanHan/momentnest)，采用 [MIT 许可证](../LICENSE)，默认分支为 `main`。仓库可见性以 GitHub 实际设置为准；修改本地文档不会公开仓库。当前尚未发布 GitHub Release，不放置虚构下载链接。

## 仓库边界

项目使用独立 Git 仓库。操作前先确认以下只读命令显示的顶层路径就是本项目：

```powershell
git rev-parse --show-toplevel
```

提交、推送、修改远程设置或将仓库改为公开，均遵循当前任务的维护者授权，不以历史文档中的授权记录代替本次确认。公开后源码和已有提交历史可能被长期复制，不能依赖之后改回私有来收回。

## 源码上传范围

| 内容 | 处理方式 |
|---|---|
| 应用源码、测试、scripts、配置与锁文件 | 上传，排除生成目录与机器配置 |
| README、文档、更新记录及问题模板 | 上传 |
| 现有品牌图标 | 上传，来源应由维护者确认 |
| 模型下载脚本、manifest 与模型许可证 | 上传 |
| ONNX 模型二进制 | 由 `npm.cmd run models:setup` 按固定清单准备，不进入 Git 提交 |
| `.local`、`.env`、签名材料、数据库、日志和配对信息 | 不上传 |
| node_modules、Flutter/Gradle 缓存、out、build、release | 不上传源码仓库 |
| design 中的历史设计图、临时测试图片 | 排除，公开截图单独制作与核查 |

忽略规则不是敏感信息审计的替代。提交前检查实际暂存清单、源文件中的硬编码凭据、私人路径以及素材来源；即使仓库私有，也不加入私人照片和发布密钥。测试夹具需确认是合成素材。

每次上传前重新核对实际源码清单、完整可达提交历史、硬编码凭据、私人路径与文件大小。`.gitignore` 不会移除已提交的内容；若发现真实凭据，先撤销或轮换，再单独处理历史与副本。清理历史属于独立操作，不在普通发布中自动执行。

## 首次开源准备记录（2026-10-21，补齐前的历史状态）

- 源码授权沿用根目录现有 MIT 文本；npm 元数据、README、贡献说明和打包声明统一为 MIT，Windows 包加入项目 LICENSE、运行依赖声明与许可采集报告。
- 模型内容不变；下载地址固定到 OpenCV Zoo 提交，准备过程按已审核大小和 SHA-256 校验，不重写模型清单与许可。
- 基于提交 `04adeb2` 的 273 个受跟踪文件及本地可见的 3 个提交进行了常见凭据模式与敏感路径检查，未命中。该结果不覆盖远程不可见引用、图片内容、所有凭据类型或后续提交，不能代替完整安全审计。
- 原 LICENSE 的版权署名为 `Johnie Nahari`，本轮保留，维护者须确认署名及授权权利。两张参考夹具已目视确认是纯色图，四张演示截图已目视检查为合成媒体界面；这些检查不证明素材的版权归属。图标生成提示记录见 `assets/branding/logo-prompt.txt`，演示截图制作说明见 [截图说明](screenshots/README.md)。
- GitHub 私密漏洞报告的说明和入口已准备；仓库公开后仍需在设置中启用并实际检查，修改 SECURITY.md 不会开启远程功能。
- FFmpeg / ffprobe 对应源码与构建资料、`vdirs@0.1.8` 的对应许可全文尚未补齐，Windows 包对外分发仍受阻，见 [二进制发行许可核查](binary-distribution.md)。

本轮验证：按原锁文件安装本地依赖（跳过依赖安装脚本），桌面类型检查与生产编译通过；17 项脚本测试通过，并在没有 `.cache` 的隔离源码目录验证首次运行。两个真实模型按固定来源下载，大小和原有 SHA-256 均通过。许可收集检查 139 个运行依赖，保留 142 项声明文件或目录，剩余 `vdirs@0.1.8` 一项缺少许可全文。包含本次新增内容的 283 个源码文件常见凭据模式检查、修改文档的本地链接检查及 Git 差异空白检查通过。

未运行 Electron 窗口、完整便携包 / APK 构建或真实设备验证，未把跳过安装脚本的依赖树当作完整运行环境。本轮未分配新发行版本、提交、推送、发布 Release 或更改远程可见性与安全设置；全新电脑的完整安装、运行和二进制发行仍需另行验收。

## 可重复的整备检查

在项目根目录运行：

```powershell
npm.cmd run opensource:check
```

命令读取当前源码（含未忽略的新文件）、本地全部可达提交和项目授权配置，并收集已安装运行依赖的许可。它不联网、不安装软件、不启动应用、不修改 Git 或分配新版本；只在忽略目录 `.cache/open-source/check-*/` 写入 `report.json`、可读说明及许可副本，保留旧报告。没有安装依赖时，报告中的运行依赖许可状态会标为不可用。

报告仅保留命中规则、相对文件路径和必要行号，不写出匹配到的凭据。退出码 0 表示源码自动检查通过；版权与素材权利、远程安全入口和二进制发行资料始终单列待人工确认，退出码 0 不表示这些事项已经完成。远程不可见的 Git 引用、媒体图像内容与所有凭据类型不在完整覆盖范围内。

继续整备验证（2026-10-21）：21 项脚本测试通过；新入口检查 286 个源码文件和 3 个本地可达提交，常见敏感模式及敏感路径命中为 0。运行依赖许可仍有 `vdirs@0.1.8` 原文缺口。进一步确认 Gyan 的 FFmpeg 6.1.1 发布记录指向源码提交 `e38092ef9395d7049f871ef4d5411eb410e283e0`，但实际二进制对应关系与完整外部库 / 构建资料仍未完成；采证来源及剩余事项保存在 [来源记录](../third_party/provenance.json)。

## 媒体工具与保护规则补齐（2026-10-21）

经维护者明确同意，旧预构建工具已替换为从固定源码构建的 FFmpeg / ffprobe 6.1.1。本轮实际编译了 FFmpeg、x264、dav1d 和 zlib，保留完整源码压缩包、构建脚本、固定便携工具链信息、各运行库及编译器运行时声明，生成与实际二进制哈希绑定的媒体源码 ZIP。Windows 打包校验对应关系并将源码 ZIP 放在便携目录旁，不能将新资料用于证明旧 Gyan / Zeranoe 包的来源。

`vdirs@0.1.8` 已按作者在 npm 发布的 MIT 与作者声明补上标准正文，并注明整理依据，许可收集会核对版本、作者和声明一致性。实测收集 119 个运行依赖，缺少声明列表为空；不把这项结果扩写成所有平台、所有二进制组件的法律审计。

验证：26 项构建 / 许可脚本测试通过；49 项桌面相关测试通过，含实际视频元数据、H.264 编码、缩略图、抽帧、水印预览和导出、原文件完整性及既有成长整理回归。两项工具仅依赖 Windows 系统 DLL；媒体工具与源码归档 SHA-256 校验通过。桌面类型检查和生产编译通过。此记录不冒充 Electron 图形窗口、Android APK 或真机验收。

统一入口实际构建 Windows **0.4.36**，生成完整程序 ZIP、媒体工具对应源码 ZIP 和 `SHA256SUMS.txt`；实际最终包内的工具版本、二进制哈希、119 个运行依赖声明、项目 / Electron 许可及包旁源码 ZIP 哈希均已核查。产物保存在本机 `release/`，本轮没有发布 GitHub Release。

GitHub `main` 的分支保护已设置并回查：要求通过 PR 更新、管理员同样受限、禁止强推和删除、要求解决讨论，审批人数为 0，以支持单人维护。当前没有设置必须通过的 CI 检查。具体日常流程见 [仓库写入与分支保护](repository-security.md)。

## GitHub 展示资料

- **标题**：拾光匣 · MomentNest。
- **简介**：本地家庭照片与视频管理工具，支持宝宝成长相册、离线人脸辅助整理，以及 Android 到 Windows 的局域网原文件传输与备份。
- **Topics**：`photo-management`、`family-album`、`local-first`、`flutter`、`electron`、`lan-transfer`。
- **截图**：Windows 图库、Android 相册、宝宝相册与成长水印；使用合成或已获许可的演示媒体，并隐藏本机路径、宝宝身份、地址及二维码。
- **问题反馈**：使用仓库内的问题模板；敏感问题按 [安全说明](../SECURITY.md) 私密报告。

已准备四张 [当前界面演示截图](screenshots/README.md)，使用合成媒体和虚构档案，展示 Windows 图库、成长相册及 Android 两个相册页面；不将演示截图写成真实设备验收。

当前没有公布安全邮箱、官网或赞助地址，不编造联系方式。仓库公开后，在 Settings → Security 中启用 Private vulnerability reporting，并从仓库 Security 页面实际确认 Report a vulnerability 入口；具体路径以 [GitHub 配置说明](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) 为准。

## 验证与构建

先进行与修改相关的类型检查、Flutter 静态分析、已有测试和打包专项验证。结构检查、实际二进制构建、模拟器与真机验证分别记录，不把测试通过写成真机验收通过。

交付只使用统一入口：

```powershell
npm.cmd run desktop:package
npm.cmd run mobile:apk:all
```

已经准备好本机缓存时，可用既有离线 Android 入口 `npm.cmd run mobile:apk:all -- --offline --arm64`。它依赖本机 SDK、Gradle 和签名配置，不是新电脑的默认安装方法。

每次交付自动递增补丁版本；Android 同步递增构建号，同轮调试与正式包共用版本。归档检查包内真实版本、架构和签名；保留旧包，不通过复制旧包后改名制作新版本。

## Release 附件与说明

源码通过 Git 仓库管理，安装程序通过 Releases 分发。GitHub 普通 Git 文件超过 100 MiB 会被阻止，单个 Release 附件须小于 2 GiB，见 [文件限制](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github) 和 [Releases 说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。

建议附件：

```text
MomentNest-<桌面版本>-win32-x64.zip
MomentNest-media-tools-6.1.1-<构建指纹>-sources.zip
MomentNest-<手机版本>-build<构建号>-arm64-release.apk
MomentNest-<手机版本>-build<构建号>-arm64-debug.apk（旧调试版升级渠道）
SHA256SUMS.txt
```

Windows ZIP 包含完整便携目录，不只包含 EXE。公开源码前完成署名、素材、隐私及文档检查；发布程序前另行核查实际二进制的许可、对应源码和构建资料，不能把源码开放等同于安装包已满足发行条件。

Release 标签对应一个明确源码提交，两端版本独立列明，例如 `Windows <版本> / Android <版本>+<构建号>`。说明模板：

```markdown
## 版本与平台
- Windows x64：<版本>
- Android：<版本>+<构建号>，<架构>

## 本次变化
- <面向用户的具体变化>

## 安装与升级
- Windows：解压完整目录，运行其中的 EXE。
- Android：按独立应用安装；后续升级固定使用同一渠道与证书。
- 首次使用重新建档和配对，数据目录见隐私说明。

## 已知限制与验证
- <已知限制、实际运行的检查及未进行的设备验证>

## 第三方组件
- <许可证、对应源码与构建资料入口>
- <FFmpeg / ffprobe 的实际版本、许可范围及对应源码附件>
```

使用发布内容生成 SHA-256 校验文件；日志及 `latest.json` 中的个人绝对路径不作为公开附件。

2026-10-05 已在本机完成独立应用身份的 Windows **0.4.35** 与 Android **0.4.25+36** 构建、版本、签名及 SHA-256 核验。它们尚未上传 GitHub；首次提交仅上传源码与文档。构建结果及桌面布局未通过项见 [验收记录](verification.md)，二进制对外分发仍需补齐第三方许可资料。

## 上传前完成条件

- 新名称、安装身份、数据目录、平台通道、图标和打包命名已经一致。
- 上传清单只含本项目，私密配置、个人媒体与构建缓存已排除。
- README、手机说明、隐私说明与当前行为一致，历史材料明确标注。
- 维护者确认素材来源；有审核过的实际界面截图。
- 项目授权状态明确；二进制分发前补齐 [第三方许可要求](../THIRD_PARTY_NOTICES.md)，尤其 FFmpeg 的对应源码与构建信息。
- 验证记录真实，安装包内部版本和签名已检查。
- 仓库所属账号、名称、目标可见性及 Git 写操作授权已经确定。
- 公开仓库的私密漏洞报告已经启用并检查入口；不能只添加 SECURITY.md。
