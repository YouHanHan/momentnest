# 补充许可原文

此目录保存发行需要的第三方许可，不改变项目根目录的 MIT 许可，也不表示二进制发行核查已经完成。

| 文件 | 来源及用途 |
|---|---|
| `licenses/GPL-3.0.txt` | 原样保留 `ffmpeg-static@5.3.0` 携带的 GPLv3 正文，供 FFmpeg / ffprobe 相关许可声明使用 |
| `licenses/css-render-LICENSE.txt` | 来自 CSS Render 提交 `9345145da71707d1d05a99c1d3a6e89315ac0574` 的 MIT 原文；该提交来自 npm 对应版本的 gitHead |
| `licenses/onnxruntime-LICENSE.txt` | 来自 ONNX Runtime `v1.30.0` 的 MIT 原文；原生二进制的其他第三方声明仍需单独核查 |

`npm-notices.json` 将缺少许可原文的 npm 包精确映射到当前版本、原文文件、上游来源和 SHA-256。桌面打包先收集实际运行依赖的顶层许可文件或含许可全文的 README，再使用这些补充文件；不为未知新版本沿用旧的许可记录。生成的 `resources/app/licenses/npm-manifest.json` 列出采集结果及未找到声明的包。

当前 `vdirs@0.1.8` 的包元数据声明为 MIT，但包内未附许可全文，尚未找到可核实的对应上游原文。应在程序对外分发前取得作者声明与许可文本；不以其他同作者项目的许可冒充。

进一步核查确认官方仓库为 `07akioni/vdirs`，当前根目录没有独立许可文件；npm 版本元数据记录的 gitHead 在该仓库查询返回 404，不能据此证明对应历史内容。FFmpeg 上游构建发布记录已追到本体源码提交，其外部库和完整构建资料仍待补齐。逐项来源与状态见 [provenance.json](provenance.json)。

更换依赖或补充资料时，重新核实原文、版本及来源，保留版权文字。完整的 FFmpeg / ffprobe 对应源码、构建配置与外部库要求见 [二进制发行许可核查](../docs/binary-distribution.md)。
