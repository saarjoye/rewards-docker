# 数据安全

- `data/`、`sessions/`、`secrets/`、`.env`、备份、诊断包和真实日志默认禁止读取、输出、提交或外传。
- 密码使用 AES-256-GCM 加密；管理员密码只保存 `scrypt` 摘要。Session、Cookie 与 OAuth Token 只以密文落盘。
- 日志不得包含密码、验证码、Cookie、Token、Session、Authorization、完整邮箱、请求头、响应正文或带查询参数 URL。
- 自动测试仅使用合成数据。真实登录、奖励、搜索、外部通知和远程发布必须获得当次明确授权。
- mutation 发送后不得自动重试；不确定结果进入 `verification-pending`，仅允许只读复核。
- 发现凭证时只报告类型和相对位置，停止外传并建议轮换。
