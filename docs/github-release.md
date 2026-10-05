# 拾光匣 GitHub 发布准备

首次上传采用私有仓库，保留现有项目授权状态。维护者已明确授权项目独立初始化、首次提交、创建远程与推送；已创建 [YouHanHan/momentnest](https://github.com/YouHanHan/momentnest)，源码采用 `main` 分支。首次提交沿用本机已配置的 Git 身份；认证与推送完成情况由实际远程核验记录确认。当前没有已发布的 GitHub Release，不在文档中放置虚构下载链接。

## 仓库边界

原项目没有自己的 `.git`，Git 曾向上找到用户目录的仓库。本次已为项目建立独立 Git 边界，初始分支为 `main`；没有修改上级仓库。后续操作仍先确认以下只读命令显示的顶层路径就是本项目：

```powershell
git rev-parse --show-toplevel
```

本轮 Git 初始化、首次提交、创建远程仓库和推送已获得维护者明确授权。后续 Git 写操作按协作约定获取相应授权；无需修改上级仓库历史，也无需移动当前项目目录。

## 源码上传范围

| 内容 | 处理方式 |
|---|---|
| 应用源码、测试、scripts、配置与锁文件 | 上传，排除生成目录与机器配置 |
| README、文档、更新记录及问题模板 | 上传 |
| 现有品牌图标 | 上传，来源应由维护者确认 |
| 模型下载脚本、manifest 与模型许可证 | 上传 |
| ONNX 模型二进制 | 由 `npm.cmd run models:setup` 准备，不进入首次 Git 提交 |
| `.local`、`.env`、签名材料、数据库、日志和配对信息 | 不上传 |
| node_modules、Flutter/Gradle 缓存、out、build、release | 不上传源码仓库 |
| design 中的历史设计图、临时测试图片 | 首次上传排除，公开截图另行制作与核查 |

忽略规则不是敏感信息审计的替代。提交前检查实际暂存清单、源文件中的硬编码凭据、私人路径以及素材来源；即使仓库私有，也不加入私人照片和发布密钥。测试夹具需确认是合成素材。

2026-10-05 的候选上传清单为 **288** 个文件，约 **4.9 MiB**。常见令牌和私钥格式检查没有匹配，未发现应排除文件或超过 100 MiB 的文件；两处历史文档个人绝对路径已脱敏。MomentNest 的完整清单与每个文件的 SHA-256 在本地 `.cache/momentnest-upload-review.json`，不随源码提交。正式暂存后还需核对实际清单，不能将候选清单视为已提交。

## GitHub 展示资料

- **标题**：拾光匣 · MomentNest。
- **简介**：本地家庭照片与视频管理工具，支持宝宝成长相册、离线人脸辅助整理，以及 Android 到 Windows 的局域网原文件传输与备份。
- **Topics**：`photo-management`、`family-album`、`local-first`、`flutter`、`electron`、`lan-transfer`。
- **截图**：Windows 图库、Android 相册、宝宝相册与成长水印；使用合成或已获许可的演示媒体，并隐藏本机路径、宝宝身份、地址及二维码。
- **问题反馈**：使用仓库内的问题模板；安全材料通过维护者私下指定的方式处理。

已准备四张 [当前界面演示截图](screenshots/README.md)，使用合成媒体和虚构档案，展示 Windows 图库、成长相册及 Android 两个相册页面；不将演示截图写成真实设备验收。

当前没有公布安全邮箱、官网或赞助地址，维护者决定后再补真实入口。

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
MomentNest-<手机版本>-build<构建号>-arm64-release.apk
MomentNest-<手机版本>-build<构建号>-arm64-debug.apk（旧调试版升级渠道）
SHA256SUMS.txt
```

Windows ZIP 包含完整便携目录，不只包含 EXE。私有 Release 下载也需要仓库访问权限；创建公开下载渠道属于新的可见性决定，不能用公开附件绕过私有源码的选择。

Release 标签对应一个明确源码提交，两端版本独立列明，例如 `Windows <版本> / Android <版本>+<构建号>`。说明模板：

```markdown
## 版本与平台
- Windows x64：<版本>
- Android：<版本>+<构建号>，<架构>

## 本次变化
- <面向用户的具体变化>

## 安装与升级
- Windows：解压完整目录，运行其中的 EXE。
- Android：正式版用于新安装；旧调试版沿用对应签名的升级包。
- 改名继续读取旧本机记录，数据目录见隐私说明。

## 已知限制与验证
- <已知限制、实际运行的检查及未进行的设备验证>

## 第三方组件
- <许可证、对应源码与构建资料入口>
```

使用发布内容生成 SHA-256 校验文件；日志及 `latest.json` 中的个人绝对路径不作为公开附件。

2026-10-05 已在本机完成 Windows **0.4.34** 与 Android **0.4.24+35** 的 MomentNest 构建、版本和签名核验及校验文件。它们尚未上传 GitHub；首次提交仅上传源码与文档。构建结果及桌面布局未通过项见 [验收记录](verification.md)，二进制对外分发仍需补齐第三方许可资料。

## 上传前完成条件

- 新名称、配置、引用和打包命名已经一致，旧安装身份与数据路径兼容。
- 上传清单只含本项目，私密配置、个人媒体与构建缓存已排除。
- README、手机说明、隐私说明与当前行为一致，历史材料明确标注。
- 维护者确认素材来源；有审核过的实际界面截图。
- 项目授权状态明确；二进制分发前补齐 [第三方许可要求](../THIRD_PARTY_NOTICES.md)，尤其 FFmpeg 的对应源码与构建信息。
- 验证记录真实，安装包内部版本和签名已检查。
- 仓库所属账号、名称、私有可见性及 Git 写操作授权已经确定。
