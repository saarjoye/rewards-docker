# 测试工作

目标：以最小有效测试集验证受影响行为。

前置：检查 `package.json`、Node 版本和 `scripts/tests/`。步骤：先运行定向离线测试，再执行 `npm run build`、相关 ESLint 和合理回归；共享接口变化时扩大范围。产物：命令、通过/失败、环境和未测试项。异常：未经授权不安装工具，不删除断言或忽略失败。验收：不使用真实账号、Cookie、Token 或真实 Rewards 操作。
