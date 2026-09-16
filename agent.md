# Microsoft Rewards Next

## 项目背景

本项目是基于 Node.js、TypeScript、Patchright、Fastify、React 和 SQLite 的 Microsoft Rewards 本地自动化服务。运行状态、任务证据、积分证据和浏览器会话均在本地隔离处理。

## 本次修复

- 合法 Bing flyout fallback 计数器现在经过完整数值和关系校验后参与 PC 搜索进度判断。
- 批量 `continue + mutating` 遇到历史 pending PC 搜索时先只读复核，随后最多恢复一次下一条查询。
- `read-only` 始终禁止提交搜索；公开 `retryPendingSearch` 仍只适用于单账号授权。
- 跨运行恢复保留历史 `submittedCount`，并按 `recoveryAttemptedRunId` 防止同一运行重复恢复。
- 普通批量 PC 搜索在有效计数器 `progress-unchanged` 时继续执行下一个查询；仍受 `maxQueries` 和整轮 deadline 限制，singleQuery 与只读 pending 保持单次/只读语义。
- 搜索页增加 opened/closed/activePageCount 结构化日志；超时或取消会 abort、关闭并等待有限清理窗口，避免无限创建页面或遗留未处理操作。
- 运行锁扩展为按 SQLite store 的进程级互斥，多个协调器共享同一 store 时第二次启动返回 `RunAlreadyActiveError`。
- `verification-pending` 收口写入脱敏 `search-verification-pending` 事件，保留提交数和最后有效进度。

## 根因线索

- `SearchExecutor` 原先在结构校验前因 `usedFallback` 直接返回 `counter-fallback`，使合法 fallback 计数器无法确认。
- 批量继续模式没有向搜索执行器传递恢复授权，导致 pending 状态只能复核而不能恢复。
- 旧逻辑在运行 ID 变化时重置提交计数，可能导致恢复查询偏移错误。

## 关键文件

- `src/orchestration/SearchExecutor.ts`
- `src/orchestration/RunCoordinator.ts`
- `src/rewards/RewardsTaskExecutor.ts`
- `src/domain/Task.ts`
- `tests/search-progress.test.ts`

## 验证

- 使用合成 dashboard 数据、临时 SQLite 和浏览器 mock；不连接外部服务，不使用真实账号。
- `npx vitest run tests/search-progress.test.ts --reporter=dot`：41 项通过。
- `npm test -- --reporter=dot`：39 个测试文件、324 项通过。
- `npm run check`：server/web/eslint 类型检查通过；`npx --no-install eslint src tests`：通过。
- `npm run build`：server TypeScript 与 web Vite 构建通过；`git diff --check`：通过。
- `npm run lint`：失败于既有 `.codex-output` 压缩构建和历史脚本产物，共 789 条 ESLint 错误；未修改这些产物或 lint 规则。
- 本轮新增回归：延迟 dashboard 增长（0/60→3/60→6/60）继续批量查询、连续未增长在 50 次上限停止、页面超时清理、共享 store 并发启动互斥；定向测试 46 项通过。
- 本轮完整定向搜索/生命周期测试共 53 项通过；构建后未出现新的源码或敏感文件差异。
- 构建产物只通过项目既有 `npm run build` 生成，不手工修改 `dist`。

## 数据和安全边界

- 不读取或记录 `.env`、密码、Cookie、Token、Session、代理凭证、生产日志或完整账号。
- 不修改生产数据库、历史积分、认证会话或 Docker 数据卷。

## 遗留风险

- 离线测试不能证明 Rewards 服务端会在所有网络条件下及时更新搜索进度。
- 生产容器需要按现有发布流程重新构建和部署后再观察真实账号行为。
