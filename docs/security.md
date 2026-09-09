# 安全

账号由 Web UI 管理。账号密码使用 AES-256-GCM 加密，管理员密码使用 Node `crypto.scrypt` 加盐摘要。主密钥优先从 Docker Secret 读取，缺省时在数据卷内生成权限受限的独立密钥文件。

Session、Cookie 和 OAuth Token 只以密文落盘，运行时只在内存解密。只有 Microsoft、Bing 和 Rewards 三层验证成功后，才允许通过临时密文文件原子替换旧 Session。

日志仅记录运行标识、脱敏账号、任务、阶段、状态、耗时、重试次数、HTTP 状态和无查询参数路径。密码、验证码、Cookie、Token、Session、请求头、响应正文和完整邮箱禁止进入日志。

验证码只在 Web UI 内存中限时使用。FIDO 或 CAPTCHA 无法安全回退时进入 `action-required`，不循环等待，也不假报成功。

普通导出不包含认证材料。完整备份可以包含密文数据库与 Session，但不包含主密钥。
