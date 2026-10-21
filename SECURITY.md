# 拾光匣安全说明

发现凭据泄露、越权文件访问、未授权传输或其他安全问题时，请优先使用 GitHub 的私密漏洞报告：进入 [仓库 Security 页面](https://github.com/YouHanHan/momentnest/security)，选择 **Report a vulnerability**。

此入口需要维护者在公开仓库中单独启用；添加本文件不会自动开启。若看不到该按钮，请通过已有私下联系方式联系维护者，或提交标题为「请求安全报告联系方式」的普通 Issue，正文仅请求私密渠道，不包含漏洞细节、攻击步骤或敏感附件。维护者尚未公布专用安全邮箱。

不要在普通 Issues 中上传配对二维码、令牌、私钥、个人照片、人脸特征、完整数据库或包含这些内容的日志。也不要为复现问题关闭证书校验、放宽局域网边界或连接未授权的媒体目录。

报告可先说明影响版本、平台、触发条件、预期权限与实际行为。后续复现材料使用隔离环境、合成媒体和临时测试凭据。

维护优先覆盖当前 `main` 和后续最新发行版。旧版本问题请注明是否能在当前版本复现；当前未承诺固定响应时限或长期维护周期。

维护者公开仓库时，应按 [GitHub 配置说明](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) 启用私密漏洞报告，并实际确认报告入口可见。

应用当前使用局域网 HTTPS、证书指纹校验与设备授权；桌面保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。数据处理方式见 [隐私说明](docs/privacy.md)，网络规则见 [局域网规则](docs/lan-only.md)。
