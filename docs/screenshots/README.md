# 拾光匣界面演示截图

生成日期：2026-10-05。所有截图来自当前界面代码，使用合成图片、测试接口与虚构档案；「小满」不是用户真实宝宝资料。没有读取个人相册、配对信息或已登录浏览器状态。

| 文件 | 内容 | 生成方式 |
|---|---|---|
| [desktop-library.png](desktop-library.png) | Windows 家庭图库，1180×800 | 独立无头浏览器渲染当前 Vue 界面 |
| [desktop-baby.png](desktop-baby.png) | Windows 成长相册与文字水印，1180×800 | 同一合成图库与已完成任务状态 |
| [mobile-gallery.png](mobile-gallery.png) | Android 普通相册，390×844 | Flutter 生产主题的界面测试截图 |
| [mobile-baby.png](mobile-baby.png) | Android 宝宝相册，390×844 | 同一界面测试中的虚构宝宝 |

桌面复用 [现有布局验收脚本](../../scripts/verify-desktop-layout.mjs) 的合成媒体与受限接口，文档截图仅将演示档案名设为「小满」、图库名设为「家庭照片」并使用已完成任务状态；未修改正式界面。实际生成脚本在本地 `.cache/capture-doc-screenshots.mjs`，不作为产品运行依赖。

手机来源为 [现有截图测试](../../apps/mobile/test/mobile_layout_preview_test.dart)：

```powershell
flutter test --no-pub --reporter expanded --dart-define=MOBILE_LAYOUT=true test/mobile_layout_preview_test.dart
```

该命令在 `apps/mobile` 中运行，将合成截图写入本地 `.cache/mobile-layout-v2`。文档使用当前输出的副本；页面中的核对状态、人物归属和水印只展示界面，不代表真实人脸识别、原文件传输或实体手机验收。实际验证边界与已知失败见 [验收记录](../verification.md)。
