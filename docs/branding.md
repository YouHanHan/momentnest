# 拾光匣品牌与应用身份

中文产品名为 **拾光匣**，英文名为 **MomentNest**，定位是本地家庭照片、视频与成长记忆管理。项目采用独立应用身份，首次使用重新建立本机档案、照片库与设备配对。

## 名称与标识

| 用途 | 名称 |
|---|---|
| 手机启动器、桌面窗口 | 拾光匣 |
| GitHub 标题 | 拾光匣 · MomentNest |
| 私有仓库 | YouHanHan/momentnest |
| 根 npm 项目 / 桌面 workspace | momentnest / @momentnest/desktop |
| Dart 项目 | momentnest_mobile |
| Android applicationId 与 Kotlin namespace | dev.momentnest.app |
| Android 平台通道 | dev.momentnest/family、dev.momentnest/network、dev.momentnest/media |
| Android 私有数据库 | momentnest.sqlite |
| Windows 数据目录 | %USERPROFILE%/.momentnest |
| 桌面协议与预加载接口 | momentnest://、window.momentnest |
| 接收临时分块目录 | .momentnest-incoming |
| 图标资源前缀 | momentnest |
| 新 Android 水印副本目录 | Pictures/MomentNest |

源码不读取其他应用身份下的相册、宝宝档案、配对记录或数据库。应用记录重新建立，原照片、视频、归档与水印文件继续保留，可以重新授权并索引。

## 安装与后续升级

当前 APK 使用独立 Android 应用 ID 和 MomentNest 正式证书，需要按新应用安装。正式 APK 与调试 APK 签名不同，后续升级使用同一渠道、同一证书，不通过卸载假定本机记录能够保留。规则见 [Android 应用身份](https://developer.android.com/build/configure-app-module) 与 [签名说明](https://developer.android.com/studio/publish/app-signing)。

正式签名保存在本机忽略目录 .local/momentnest-signing，不进入源码、安装包或 GitHub。后续 MomentNest 版本固定使用这里的证书和上述应用身份。

## 交付命名

Windows：MomentNest-<版本>-win32-x64/MomentNest-<版本>.exe，ZIP 包含整个目录。Android：MomentNest-<版本>-build<构建号>-<架构>-debug.apk 与对应 release.apk。

两端使用统一打包入口自动递增补丁版本，Android 同步递增构建号。同轮调试与正式 APK 共用版本；归档检查包内实际版本、架构与签名，不用修改文件名冒充新构建。

MomentNest 已有 [同名纪念日服务](https://momentnest.app/om/)，本项目按维护者选择使用该名称，不宣称名称唯一。
