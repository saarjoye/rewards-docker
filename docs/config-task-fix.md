# 配置、调度与任务证据修复

## 修改文件清单

- `README.zh-CN.md`
- `compose.yaml`
- `scripts/api/apply-schedule.js`
- `scripts/api/cryptoVault.js`
- `scripts/api/logParser.js`
- `scripts/api/scheduleStore.js`
- `scripts/api/server.js`
- `scripts/api/taskEligibility.test.js`
- `scripts/api/taskEvents.js`
- `scripts/api/taskTelemetry.test.js`
- `scripts/api/trigger.js`
- `scripts/docker/entrypoint.sh`
- `scripts/docker/run_daily.sh`
- `src/browser/BrowserFunc.ts`
- `src/browser/ReactFunc.ts`
- `src/crontab.template`
- `src/functions/activities/api/ActivateSearchPerk.ts`
- `src/functions/activities/api/ClaimBonusPoints.ts`
- `src/functions/activities/api/ClaimReward.ts`
- `src/functions/activities/api/EnsureStreakProtection.ts`
- `src/functions/activities/api/UrlReward.ts`
- `src/functions/activities/app/AppPromotions.ts`
- `src/functions/activities/app/AppReward.ts`
- `src/functions/activities/app/DailyCheckIn.ts`
- `src/functions/activities/rewards/PunchCards.ts`
- `src/functions/activities/search/SearchManager.ts`
- `src/functions/activities/search/SearchProgress.ts`
- `src/util/TaskEligibility.ts`
- `src/util/TaskTelemetry.ts`
- `src/util/Utils.ts`
- `web/Dockerfile`
- `web/public/app.js`
- `web/public/index.html`
- `web/public/run-view.js`
- `web/src/crypto-vault.mjs`
- `web/src/history.mjs`
- `web/src/server.mjs`
- `web/src/settings.mjs`
- `web/src/status.mjs`
- `web/src/task-view.mjs`
- `web/src/wecom.mjs`
- `web/test/server.integration.test.mjs`
- `web/test/task-eligibility.test.mjs`
- `web/test/task-records.test.mjs`
- `web/test/wecom.test.mjs`
- `docs/config-task-fix.md`
- `scripts/api/activityEvidence.test.js`
- `scripts/api/cryptoVault.test.js`
- `scripts/api/schedule.test.js`
- `scripts/api/scheduleController.js`
- `scripts/api/scheduleRoutes.js`
- `src/util/BusinessDate.ts`
- `web/scripts/entrypoint.mjs`
- `web/test/vault-recovery.test.mjs`

## 交付状态

本次 cn12 增加日历逐账号余额展示和账号起止时间、执行时长，修复 null 积分导致结束日志丢失，并保留 cn11 的实时余额修复。完整配置见 [compose.yaml](../compose.yaml)，生产使用 `ghcr.io/saarjoye/mrs-core:latest` 和 `ghcr.io/saarjoye/mrs-web:latest`；工作流同时保留 `4.3.2-cn12` 固定标签。确认发布工作流成功后即可拉取，无须修改 Compose 标签或自行构建；发布不会自动部署运行机。

cn12 不新增 schema 迁移，不回填历史积分或账号时间；旧记录缺少明确起止时间时继续显示待确认。新运行需要同时更新 Core/Web 才能完整显示时间。账号级即时通知、持久通知队列尚未实现，不包含在本次发布。

cn11 使用事件合并刷新和运行中轻量轮询，余额暂时值与最终值分开，快照或事件没有正式历史时日历仍显示记录。复用既有快照表的 live 阶段，不增加 schema 迁移。最新提出的双账本归因、进度证据降级和未归属积分进一步分析按用户要求暂缓；此版本不承诺识别余额残差的真实来源。

cn10 将任务上报与确认积分分开，单次运行不再累加历史，上海日期余额净变化不回退为任务事件合计；缺少可靠观测时间或结束余额显示待确认，余额下降保留负数。余额变化并不等同微软官方全天赚取。

Web 首次启动会在事务中添加 `point_events.evidence_json` 和 `balance_snapshots`，不会重写历史积分，旧记录按未核验处理。升级前应在维护窗口完成 SQLite 一致性备份，保留数据库、WAL 及原有挂载和密钥，不删除数据。新增列可能不兼容旧版本无列名 INSERT；不要直接降级旧镜像写入升级后的数据库。回退须验证兼容版本或备份恢复方案，并保全升级后产生的新记录。

## 配置与权限

- Core 配置继续来自挂载后的 `dist/config/config.json`，不会改用旧根配置或 config-v4。
- Web 企业微信唯一发送来源为 `WEB_DATA_DIR` 中的加密设置库。Core webhook 不会隐式同步或覆盖它；原环境配置通过专用迁移按钮导入，普通保存不读取环境凭证。
- 密钥仅在启动时从只读 Secret 复制到私有临时目录，权限为仅 Web 用户可读；服务器降权运行。不更换原密钥，不扩大其权限，不递归修改持久目录。
- 仅新建或空的 Web 数据目录由入口准备所有权。已有文件不可读写时明确报错，需在运行机核验具体文件所有权；不得删除加密库、重新生成密钥或批量改权限来掩盖问题。
- 保存成功意味着原子替换完成且配置已 reload；显示 encrypted 来源和具体保存时间。权限、格式、解密、写入错误不会被当成保存成功。

## 调度

Core 使用显式 `SCHEDULE_FILE`，否则使用 `CONFIG_FILE` 所在目录的 schedule.json。兼容旧 schedule 字段，保存时规范为 cron；时区固定 Asia/Shanghai。Web 通过认证 GET/PATCH /api/schedule 代理 Core GET/PATCH /schedule，不写宿主机文件。

容器只安装一份项目专属系统 cron 条目，通过认证 POST /schedule/trigger 调用现有进程管理器。项目旧用户 crontab 条目迁移时只移除此项目入口，其他条目保留。保存失败恢复原调度；配置损坏不回退成运行全部账号。

运行中默认跳过；关闭跳过后最多合并排队一次，当前运行结束后补执行。改配置、停用、停止或重启取消排队，不跨重启重放旧触发。触发成功和任务结果分开显示，任务结果不依据退出码单独判定。

API 模式的 cron 入口不再叠加外层随机睡眠与 shell 锁，执行时间由调度配置决定，任务内部延迟不变。非 API 模式保留原执行脚本。

运行机可能存在宿主 cron、旧 Stack 或其他定时器；本次未连接运行机，不能声称已排除它们。部署前应只读确认，避免不同入口重复运行同一账号。

## 任务与积分

- 请求提交、任务完成、积分确认分别记录。运行前已完成标记跳过，缺失积分保持 null，明确零积分为 confirmed-zero。
- 活动直接积分或活动进度支持任务得分确认。仅余额变化不归因给某项任务，独立显示未归类变化；保留并行搜索，不重复累计父子积分。
- 相同账号本轮共享网页 offer 防重入，不跨账号拦截。复核只读、最多三次，不因待确认重领；认证失败和限流终止复核。
- UrlReward、签到、App 活动、领取和打卡报告提交证据；余额减少和合法零值照实更新。没有直接积分字段或活动进度时，即使余额增加也不宣称该任务已到账。
- 打卡合并 API 已知子任务 ID 与网页可解析子任务，校验锁定、日期和提交条件。未知结构不猜测 hash 或执行协议。
- 移动额度缺失时有限读取 earn、flyout；仍无法确认则不提交搜索。无真实推广、应用活动、保护天数或搜索加成时结束为跳过或不可用。
- 默认只展示执行计划中可执行及实际执行任务，其他记录在排除原因中保留。旧历史值不改为新口径已确认积分。
- 历史统计、任务日期和显示时间按上海时间切日；日历内部日期算术使用 UTC 日期对象仅作日期运算，不表示按 UTC 统计。

仍不支持没有可靠执行器的 quiz、未知推广、未知应用协议、直接上报多日搜索完成；手动兑换及未获配置授权的领取保持排除。离线 fixture 通过不证明真实账号到账。

## 验证与升级边界

离线命令：核心 `npm run build`、`npm run lint`、`node --test scripts/api/*.test.js`；Web 目录运行 `npm run check`、`npm test`。测试使用合成响应和临时目录，不连接 Rewards 或企业微信。

Linux 非 root 权限测试需要在 Linux 非 root 环境执行 Web 测试；Windows 会明确跳过。当前未运行 Docker 构建、真实容器权限验收、浏览器视觉验收或真实任务。

两份镜像均需重新构建。之后才可经授权更新 Core/Web 容器；本次没有执行这一步。升级保留现有账号库、配置、日志、会话、Web 数据及两份原密钥。若旧环境账号尚未迁移，先保留原环境注入配置；当前 Compose 不会自动读取旧 env 文件。

升级使用 Compose 中的 `latest` 标签；版本号只在回滚或审计时使用，不需要每次修改 Compose。回退时恢复旧镜像及其 Compose；不要恢复或更换与现有加密数据不匹配的密钥。
