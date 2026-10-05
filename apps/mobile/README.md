# 拾光匣手机端

Flutter + Dart 应用，面向 Android 8.0（API 26）及以上。支持系统相册浏览、收藏与搜索、本机宝宝成长相册、成长水印，以及 Android → Windows 局域网原文件上传和备份核对。

在此目录执行：

```powershell
flutter pub get
flutter analyze
flutter test
flutter run
```

交付打包从项目根目录执行 `npm.cmd run mobile:apk:all`，一次递增版本与构建号并生成调试、正式签名 APK。正式签名配置仅从本机忽略目录读取；同轮两种 APK 共用版本。需要 Android SDK、JDK 与 Gradle 依赖，完整命令见 [开发说明](../../docs/development.md)。

源码项目名为 `momentnest_mobile`，手机显示名称为「拾光匣」。Android 应用标识、Kotlin namespace、平台通道、私有数据库和已有签名继续沿用旧身份，规则见 [品牌与兼容](../../docs/branding.md)。正式 APK 不能直接覆盖旧调试签名版本，已有用户应使用对应签名的升级包。

宝宝档案、人脸参考、人工归属、拍摄日期及水印在手机本机处理，不与电脑宝宝相册同步，不下载电脑原文件。进入后台时保存进度并暂停，不承诺锁屏持续上传或整理。

相册与原文件使用说明见 [用户指南](../../docs/user-guide.md)，权限与记录位置见 [隐私说明](../../docs/privacy.md)。真实构建、自动化及设备验证分别记录在 [验收记录](../../docs/verification.md)。
