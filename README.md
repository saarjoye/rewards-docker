# Microsoft Rewards Next

Microsoft Rewards Next 是一个重新设计的本地自动化项目，重点解决登录误判、不同账号任务差异、重复 mutation、Dashboard 数据源变化、搜索超时和容器浏览器重复下载问题。

当前仓库是独立实现，不读取旧项目的账号、Session、运行状态或密钥。Web 管理、真实运行编排、浏览器登录、Rewards 数据源和十类任务适配器已经接入；真实任务仍必须按只读、单账号受控 mutation、三账号全量和连续三日的顺序验收。

## 核心原则

- Microsoft、Bing、Rewards 数据三层验证后才接受登录成功。
- `web-desktop`、`web-mobile`、`app-oauth` 三个认证槽独立加密和更新。
- RSC、Bing flyout、App Dashboard 和旧 API 按字段提供证据，不要求单一响应包含全部数据。
- mutation 通过幂等账本提交；结果不明进入 `verification-pending`，续跑只读复核。
- 未知任务、缺失字段和未知余额不得转换成完成或零分。
- 所有 earning task 完成后最多执行一次“领取奖励积分”。

## 目录

- `src/domain/`：任务、字段证据、运行与账号状态。
- `src/auth/`：认证槽、登录状态和加密 Session。
- `src/rewards/`：数据源与任务适配接口。
- `src/orchestration/`：重试、幂等和七阶段流水线。
- `src/infra/`：SQLite、文件、日志和配置实现。
- `src/web/`：Fastify API 与 React 管理界面。
- `tests/`：只使用合成数据的单元、集成和端到端测试。

## 当前验证状态

- 离线 TypeScript、ESLint、Vitest 和 Web 构建已接入。
- 本机 Chrome 可通过 `scripts/read-only-cdp-check.ts` 做脱敏只读核对。
- Chromium 只在固定浏览器基础镜像首次构建或 Patchright 版本变化时下载。
- 三账号真实执行和 NAS 连续三日验收完成前，不替换旧服务。

## 源码机三账号只读验收

仅在源码机验收时，可在未提交的 `.env` 中配置连续三组
`ACCOUNT_1..3_EMAIL/PASSWORD`，然后运行：

```powershell
npm run verify:accounts
```

该命令使用三个互相隔离的临时浏览器 Context，只执行登录、身份、市场、数据源、
搜索 counter、领取状态和任务发现读取。它不会执行领取、搜索或其他 mutation，不会
写入账号数据库或 Session。脱敏结果写入被忽略的 `.codex-output/`；正式运行账号仍
只能通过 Web UI 加密管理。

## 文档

- [架构](docs/architecture.md)
- [安全](docs/security.md)
- [测试](docs/testing.md)
- [部署](docs/deployment.md)
