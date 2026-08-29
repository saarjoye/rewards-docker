# 数据安全

- `.env`、`src/config.json`、`src/accounts.json`、`config/`、`sessions/`、`logs/`、`diagnostics/` 含凭证、会话或用户数据，默认禁止读取、输出、提交或外传。
- Cookie、Authorization、OAuth code、access token、RequestVerificationToken、账号密码、TOTP 和 webhook 密钥不得进入日志、测试 fixture、提交信息或项目记录。
- 网络、浏览器、MCP、Skill 或第三方服务只能接收完成任务所需的最小脱敏信息；内部内容外传前必须取得明确确认。
- 测试使用合成账号、响应和临时目录，不执行真实 Rewards 任务。发现凭证时只报告类型与相对位置并建议轮换。
- 诊断只记录状态码、错误分类、内容类型、字段名、长度和去除查询参数的路径，不保存完整响应体或页面内容。
