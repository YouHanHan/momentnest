# 拾光匣品牌与兼容规则

中文产品名为 **拾光匣**，英文展示名为 **MomentNest**，原名为「近传 · Jinchuan」。定位是本地家庭照片、视频与成长记忆管理，局域网传输是其中的备份能力。

英文名表达「珍藏家庭时刻的小窝」。中文启动器和窗口继续显示「拾光匣」，中英文项目介绍使用「拾光匣 · MomentNest」。GitHub 私有仓库目标为 `YouHanHan/momentnest`。

2026-10-05 的同名检索发现已有 [MomentNest 纪念日服务](https://momentnest.app/om/)；本项目按维护者确认使用该英文名，不以此宣称名称唯一。先前本机试用的英文名 `ShiguangBox` 不再用于新构建命名，历史交付包及其验收记录保留。

## 名称对应

| 用途 | 名称 |
|---|---|
| 手机启动器、桌面窗口、界面文案 | 拾光匣 |
| GitHub 标题与介绍 | 拾光匣 · MomentNest |
| 建议 GitHub 仓库名 / 根 npm 项目 | momentnest |
| 桌面 workspace | @momentnest/desktop |
| Dart 源码项目 | momentnest_mobile |
| Windows 与 APK 文件前缀 | MomentNest |
| 新手机水印副本目录 | Pictures/MomentNest |

目录 `apps/desktop` 和 `apps/mobile` 继续表达平台。现有照片与爱心图标继续使用；素材文件名和资源标识仍保留 `jinchuan`，它们是内部引用，不影响显示名称。

## 兼容身份

以下名称继续沿用：

- Android `applicationId`：`dev.jinchuan.app`；Kotlin namespace：`dev.jinchuan.jinchuan_mobile`。
- Android 平台通道：`dev.jinchuan/family`、`dev.jinchuan/network`、`dev.jinchuan/media`。
- Android 私有数据库：`jinchuan.sqlite`；系统安全存储中的配对令牌键及记录结构。
- Windows 持久数据：`%USERPROFILE%/.jinchuan`；旧 `%APPDATA%/jinchuan` 只用于既有兼容迁移。
- 桌面本地协议与预加载接口：`jinchuan://`、`window.jinchuan`。
- 上传临时分块目录：`.jinchuan-incoming`；现有证书、签名文件与密钥别名。

改名不重签旧身份，不迁移用户照片，不修改数据库结构，不重建已有相册或上传回执。新水印副本进入 `Pictures/MomentNest`，已有 `Pictures/Jinchuan` 与试名阶段的 `Pictures/ShiguangBox` 文件继续保留，记录中的原路径继续可读。

Android 更新需要使用原应用标识与兼容签名，见 [Android 应用身份规则](https://developer.android.com/build/configure-app-module)。当前正式包与调试包分别沿用自己的签名；正式包无法直接覆盖旧调试版，下载说明必须区分新安装和已有调试版升级。

## 交付命名

```text
MomentNest-<桌面版本>-win32-x64/
  MomentNest-<桌面版本>.exe
MomentNest-<桌面版本>-win32-x64.zip
MomentNest-<手机版本>-build<构建号>-<架构>-debug.apk
MomentNest-<手机版本>-build<构建号>-<架构>-release.apk
```

源码首次改名不直接改变版本；交付打包由既有统一入口递增。桌面同步根配置、workspace 和锁文件版本，手机同步版本名与构建号。同轮 APK 使用 `mobile:apk:all`，每个平台的版本独立维护，Release 说明列出两端兼容组合。已有旧品牌交付包保留原名称和真实版本。
