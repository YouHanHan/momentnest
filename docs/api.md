# 首版实际接口

默认 HTTPS TCP 45831。先使用电脑生成的一次性 secret 配对，再在请求头发送 Authorization: Bearer <token>。除配对外所有端点需要设备认证；拒绝带 Origin 的网页请求。移动端必须固定配对提供的 SHA-256 证书指纹，并禁止跳转。

| 方法与路径 | 功能 |
|---|---|
| POST /v1/pair | secret、name 换取 receiverId、deviceId 与设备 token |
| GET /v1/receiver | 查询身份、接收开关、已启用接收目录、currentLibraryId、currentLibraryAvailable、chunkSize |
| POST /v1/assets/check | libraryId + assets[{hash,size}]，返回当前库 receipt、其他接收库/历史目录 matches、范围完整性 complete；一次最多 50 张 |
| POST /v1/batches | clientKey、libraryId、mode(capture/upload/manual)、manualDate（手动模式）创建不可变批次 |
| POST /v1/uploads | clientKey、batchId、filename、hash、size、captureDate（可选）建立会话或复用完成回执 |
| POST /v1/family/sync | 合并宝宝档案、人工归属和日期，并分页读取图库；不生成上传回执 |
| GET /v1/family/assets/:id/thumb | 返回本地生成的缩略图 dataUrl，原文件需来自已启用授权目录 |
| GET /v1/family/assets/:id/content | 只读原文件二进制流，支持单个字节 Range，保留原字节 |
| GET /v1/uploads/:id | 查询持久化状态、offset 或完成回执 |
| PUT /v1/uploads/:id/content?offset=N | 写原始二进制分块，Content-Length 明确；单块不超过 4 MiB |
| POST /v1/uploads/:id/complete | 校验整图，提交并返回回执；重复调用安全 |
| POST /v1/uploads/:id/cancel | 取消本设备未完成任务并清理其临时文件；已完成返回原成功状态 |

JSON 响应错误字段为 error。认证失败 401，越权会话不可见 404，偏移或幂等参数冲突 409，文件哈希不符 422，繁忙或限流 429，暂停接收 503。具体字段以 types.ts、receiver.ts 与 receiver_api.dart 为准；设计稿中的草案接口不是兼容承诺。

客户端应先查询会话确认偏移再续传；连接断开不意味着上一请求未生效。发送完全部字节也不意味着成功，必须取得并校验 complete 回执。

0.4.0 新批次只接受电脑当前可用照片库，目标已改变或当前库不可用时返回 409，客户端刷新目标后重新确认。已存在的 clientKey 保持原批次目标及日期，电脑切库不会改变续传。新保存回执包含真实 batchId；旧回执可从对应上传会话只读补全批次身份，无会话来源的旧归档记录不冒充上传批次。

桌面受限 IPC 支持 setCurrentLibrary，以及显式 libraryId 的图库、人物、扫描、预览、定位和水印操作。库选择持久化；没有当前库时界面显示选择入口，不发送全局媒体查询。家庭同步协议保持跨库共用记录，未将当前库作为手机已有家庭相册的权限边界。

0.3.0 上传可附加 creationDate（YYYY-MM-DD），capture 规则缺少拍摄日时优先使用源创建日期，再使用冻结的批次上传日。照片与视频白名单均支持原字节传输；单文件仍限制为 2 GiB。

family/sync 请求包含 babies、decisions，以及可选 dates、cursor、decisionCursor、dateCursor、limit。assets 每页最多100，人工归属与日期每页最多500，三个响应游标 nextCursor/nextDecisionCursor/nextDateCursor 分别为下一偏移或 null。手机推送人工归属与日期每次最多100条。归属只同步 origin=manual 且 included/excluded；recognition 和 candidate 不作为跨端人工决定。

资产 id 是完整 SHA-256 加连字符和大小。归属按 babyId+assetId 合并，日期按 assetId 合并；有效 updatedAt 较新的记录生效。宝宝档案包含 id/name/birthday/autoMatch/updatedAt，参考人脸保留在各自设备。响应不携带电脑绝对路径、凭据和人脸特征，缩略图与原文件访问沿用既有设备认证。

桌面根目录管理、扫描、配对信息生成、撤销授权和照片预览通过本地受限 IPC，未提供未认证的网络管理 API。

0.2.0：每个核对结果包含 complete。无 receipt/matches 且 complete=true 才能标记未备份。扫描未完成、启用目录不可访问或旧版本未返回 complete 时只能标记待核对。matches 中历史目录使用 rootId，其他接收库使用 libraryId；均附 path 和 checkedAt。备份结论仅涵盖已登记范围。
