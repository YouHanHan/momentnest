# 补充许可原文

此目录保存发行需要的第三方许可，不改变项目根目录的 MIT 许可，也不表示二进制发行核查已经完成。

| 文件 | 来源及用途 |
|---|---|
| `licenses/GPL-3.0.txt` | 原样保留 `ffmpeg-static@5.3.0` 携带的 GPLv3 正文，供 FFmpeg / ffprobe 相关许可声明使用 |
| `licenses/css-render-LICENSE.txt` | 来自 CSS Render 提交 `9345145da71707d1d05a99c1d3a6e89315ac0574` 的 MIT 原文；该提交来自 npm 对应版本的 gitHead |
| `licenses/onnxruntime-LICENSE.txt` | 来自 ONNX Runtime `v1.30.0` 的 MIT 原文；原生二进制的其他第三方声明仍需单独核查 |
| `licenses/vdirs-0.1.8-NOTICE.txt` | 根据 npm 发布元数据中的作者与 MIT 声明整理，附标准 MIT 正文，明确不是上游原始 LICENSE |
| `media-tools/` | 固定源码构建的 FFmpeg / ffprobe、源码与工具清单、各运行库许可；二进制生成目录不提交 |

`npm-notices.json` 将缺少许可原文的 npm 包精确映射到当前版本、原文文件、上游来源和 SHA-256。桌面打包先收集实际运行依赖的顶层许可文件或含许可全文的 README，再使用这些补充文件；不为未知新版本沿用旧的许可记录。生成的 `resources/app/licenses/npm-manifest.json` 列出采集结果及未找到声明的包。

`vdirs@0.1.8` 的 [发布元数据](https://registry.npmjs.org/vdirs/0.1.8) 已由作者声明 MIT、作者为 `07akioni`，但未附独立许可全文。本轮保留这些已发布声明并补上 [SPDX MIT 标准正文](https://spdx.org/licenses/MIT.html)，通知文本中区分声明来源与整理文本，不补造上游版权年份或原始文件。许可收集会核对已安装包的版本、作者和许可，只有一致时才沿用该通知。

进一步核查确认 `vdirs` 官方仓库为 `07akioni/vdirs`，当前根目录没有独立许可文件；npm 版本元数据记录的 gitHead 在该仓库查询返回 404，不能据此证明对应历史内容。新媒体工具使用本项目实际执行的固定源码构建，替代无法核实完整资料的旧预构建工具；原有来源线索按历史记录保留。逐项来源与状态见 [provenance.json](provenance.json)。

更换依赖或补充资料时，重新核实原文、版本及来源，保留版权文字。完整的 FFmpeg / ffprobe 对应源码、构建配置与外部库要求见 [二进制发行许可核查](../docs/binary-distribution.md)。
