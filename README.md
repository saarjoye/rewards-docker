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

## 搜索词隔离与停滞控制

搜索使用随构建发布的 1000+ 条词库；词库不可用时回退至 52 个基础词。账号的持久 ID 和业务日期决定候选起点，SQLite 原子占用记录确保同一数据库内各账号及 PC/移动任务当天不重复分配查询词。占用在提交前持久化，取消、失败或重启不释放；显式 `singleQuery` 也遵守去重规则。

首次启动新版会新增 `search_query_reservations` 表，不改写历史任务。表中只保存规范化查询词的 SHA-256、业务日期与分配归属，不保存查询正文。去重自新版首次分配起生效，无法追溯旧版已发送的查询，也不跨独立数据库协调。词库耗尽时任务进入 `action-required`（`search-query-pool-exhausted`），显式查询重复时原因为 `search-query-already-reserved`。保留占用表才能维持当日保证；回退到旧版本运行不再提供这一保证。

网页搜索设置和配置文件均支持 `search.stagnantLimit`：整数 1–100，默认 10。有效计数连续无增长达到阈值时停止本轮并保留待复核状态，有进度则重置计数。延迟支持 360–720 秒等长间隔，默认仍为 30–60 秒；单轮预算上限为 24 小时。每个任务复用一个搜索标签页，并在结束、异常或取消时清理其弹窗。以上行为不保证服务端积分增长。

网页离线冒烟验证：构建后运行 `node scripts/search-settings-offline-smoke.mjs`。脚本使用已安装的浏览器和临时无头会话，拦截全部页面请求并提供合成响应，检查设置加载、保存、刷新回读和校验；不安装浏览器、不读取真实账号。非标准安装路径可通过 `SEARCH_SMOKE_BROWSER` 指定。

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
