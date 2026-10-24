# 拾光匣界面演示截图

生成日期：2026-10-23。本轮展示用户选定的 A「奶油杏桃」主题，早期绿色与粉暖色截图保留。所有截图来自当前界面代码，使用合成图片、测试接口与虚构档案；「小满」不是用户真实宝宝资料。没有读取个人相册、配对信息或已登录浏览器状态。

| 文件 | 内容 | 生成方式 |
|---|---|---|
| [desktop-library-cream-apricot.png](desktop-library-cream-apricot.png) | Windows 家庭图库，1180×800 | 独立无头浏览器渲染当前 Vue 界面 |
| [desktop-growth-cream-apricot.png](desktop-growth-cream-apricot.png) | Windows 成长相册与文字水印，1180×800 | 同一合成图库与已完成任务状态 |
| [mobile-gallery-cream-apricot.png](mobile-gallery-cream-apricot.png) | Android 普通相册，390×844 | Flutter 生产主题的界面测试截图 |
| [mobile-baby-cream-apricot.png](mobile-baby-cream-apricot.png) | Android 宝宝相册，390×844 | 同一界面测试中的虚构宝宝 |
| [desktop-preview-cream-apricot.png](desktop-preview-cream-apricot.png) | Windows 浅色原图预览，1180×800 | 读取合成原文件，保持独立缩放和水印 |
| [mobile-preview-cream-apricot.png](mobile-preview-cream-apricot.png) | Android 浅色原图预览，360×780 | 生产预览布局与合成原文件 |

桌面复用 [现有布局验收脚本](../../scripts/verify-desktop-layout.mjs) 的合成媒体与受限接口，文档截图仅将演示档案名设为「小满」、图库名设为「家庭照片」并使用已完成任务状态；未修改正式界面。实际生成脚本在本地 `.cache/capture-apricot-a.mjs`，不作为产品运行依赖。

手机来源为 [现有截图测试](../../apps/mobile/test/mobile_layout_preview_test.dart)：

```powershell
flutter test --no-pub --reporter expanded --dart-define=MOBILE_LAYOUT=true test/mobile_layout_preview_test.dart
```

该命令在 `apps/mobile` 中运行，将合成截图写入本地 `.cache/mobile-layout-v2`。文档使用当前输出的副本；页面中的核对状态、人物归属和水印只展示界面，不代表真实人脸识别、原文件传输或实体手机验收。实际验证边界与已知失败见 [验收记录](../verification.md)。
