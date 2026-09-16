# 术语

- `accountId`：账号持久标识，不表示数组位置。
- `runAccountIndex`：Web 运行选择使用的 1 基序号。
- `mutation`：会改变 Rewards、账号或外部服务状态的请求或页面动作。
- `verification-pending`：mutation 已发送但结果未确认，只能只读复核。
- `authentication slot`：`web-desktop`、`web-mobile` 或 `app-oauth` 独立认证槽。
- `field evidence`：携带来源、可信度、观测时间和 `valid/missing/invalid/unknown` 状态的字段值。
- `local day`：由 Node 进程本地时区计算的业务日期；审计时间继续使用 UTC ISO。
