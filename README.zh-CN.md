# Microsoft Rewards v4 中文控制台部署

本仓库由原版 v4.3.2 核心和独立中文 Web 组成。核心负责账号登录与 Rewards 任务，Web 提供加密账号管理、中文运行记录、任务与积分展示、企业微信通知以及受限的启动/停止控制。

cn6 包含任务能力、计划快照、移动搜索额度和状态展示修复。完整 Compose 使用 `4.3.2-cn6` 镜像标签；部署前阅读 [修复与升级说明](docs/config-task-fix.md)。发布镜像不会自动更新运行机。

## 数据边界

- 当前 Compose 不依赖 `runtime/core.env` 或 `runtime/web.env`，使用部署环境中的 `REWARDS_API_TOKEN` 为两个容器传入同一个控制令牌。账号继续使用 `config/accounts.enc.json`，Web 通知仅使用独立加密配置库。
- 旧环境账号及通知配置只通过显式迁移操作导入。未完成迁移的旧部署必须先保留其原环境注入方式，不能直接移除后期望从不存在的环境中恢复配置。
- 核心账号库和 Web 配置分别使用 `/home/docker/rewards/secrets/` 下的独立 32 字节密钥，密钥只读挂载且不进入环境变量、镜像、数据库或 Web 响应。
- 原有 `/home/docker/rewards/config`、`sessions`、`logs` 继续使用；Web 历史位于 `/home/docker/rewards/web-data`。
- 核心端口 `3010` 只在 Compose 网络可见，NAS 只发布中文 Web 的 `8787` 端口。
- 结构化运行记录长期保留；原始脱敏诊断日志保留 7 天并限制为 10000 条。

## 首次准备

1. 创建 `/home/docker/rewards/config`、`sessions`、`logs`、`web-data`、`runtime` 和 `secrets`，其中 `secrets` 权限设为 `700`。
2. 在部署环境设置随机 `REWARDS_API_TOKEN`，不要写入仓库或截图。Compose 会在缺失时拒绝部署。
3. 仅首次安装生成密钥；升级时不得覆盖已有密钥。Web 启动入口读取原 Secret 到私有临时文件后降权运行；不依赖 Compose 文件型 secret 的所有者重映射，也不把原 Secret 设为全局可读。

    ```bash
    umask 077
    test -e /home/docker/rewards/secrets/core_accounts.key || openssl rand -out /home/docker/rewards/secrets/core_accounts.key 32
    test -e /home/docker/rewards/secrets/web_settings.key || openssl rand -out /home/docker/rewards/secrets/web_settings.key 32
    chmod 600 /home/docker/rewards/secrets/core_accounts.key /home/docker/rewards/secrets/web_settings.key
    ```

    两份密钥必须分别生成并单独备份；丢失后加密数据无法恢复。`secrets` 父目录保持 `700`，容器只读取指定的只读挂载文件。

4. 如需迁移旧账号，暂时保留 `runtime/core.env` 中的 `ACCOUNT_N_*`；旧 `PROXY_AXIOS` 改为 `PROXY_HTTP`。
5. 初次验证保持 `CRON_SCHEDULE=`、`RUN_ON_START=false`，不要让旧、新容器同时运行同一账号。
6. 确认 cn6 镜像构建成功后，拉取并部署 Compose 中的两个 `4.3.2-cn6` 镜像，无须自行构建。Portainer 中先设置 `REWARDS_API_TOKEN` 环境变量，并保留原有加密密钥和数据挂载；不能通过拉取旧 cn5 镜像获得此次修复。
7. 打开 `http://<NAS地址>:8787` 初始化管理员，在“账号管理”中执行一次性迁移或直接新增账号。确认迁移成功后可从环境文件删除 `ACCOUNT_N_*` 并重建核心容器。

## 配置原则

核心首次启动会从 `config.example.json` 生成 `/home/docker/rewards/config/config.json`。默认只使用内置 `local` 搜索词库，并关闭外部搜索词源和实验性 HTTP 搜索。其他任务延迟保持上游默认值。

在 Web“定时任务”设置每日时间或五段 cron，固定上海时区。Core 管理 `schedule.json`，Web 只调用认证 Control API；保存后生效，不需要为每次调度修改重建容器。配置文件优先于启动环境默认值。运行中的任务使用启动时账号快照，账号增删改仅在核心空闲时允许。

企业微信在 Web 中配置。选择“直连”时访问官方地址；选择“自定义反代”时，配置地址替换官方基础地址，同时保留 `/cgi-bin/gettoken` 和 `/cgi-bin/message/send`。反代必须使用可信 HTTPS 地址且不得包含账号、查询参数或片段，因为反代会接触 `corpsecret` 和 `access_token`。

配置完整与启用通知分别显示；保存不会自动发送测试消息。新 Secret 与清除 Secret 不允许同时提交，留空保留原值。测试返回成功只证明企业微信接口接受，仍需检查客户端收件、应用可见范围与成员状态。

运行通知在整次运行结束后发送，并非每个账号切换时发送。当前 Web 进程首次接收的新运行会进入待发送队列；未配置时保留等待，发送失败后在 1 分钟和 5 分钟后最多再处理两轮。每轮沿用通知客户端最多三次请求尝试，并启用企业微信重复消息检查。成功记录持久化，待发送和失败队列仅存在于当前进程内；重启不自动补发此前漏发的历史通知。页面显示待发送数、失败数和最近错误，不把跳过发送记为成功。

积分日历恢复旧版范围筛选、每日深浅网格及账号日期分组的执行明细；无记录和待确认积分不填零，旧记录保持未核验。日期筛选读取完成后才切换加载状态，避免筛选条件丢失。

旧 Cookie 和指纹不迁移。需要人工登录时使用上游 v4 的 `manual-login` 流程，并确保登录网络、地区与自动任务一致。

## 旧积分历史

先把旧文件复制到 `web-data/import/points-history.json`，再执行预检：

```bash
docker compose exec rewards-web node scripts/import-v3-history.mjs /app/data/import/points-history.json --dry-run
```

确认统计后才使用 `--apply`。导入工具只接受旧版积分历史结构，不读取 checkpoint、任务进度、会话或原始日志，原文件不会被修改。

## 验收与回滚

### 任务记录与积分口径

- cn4 将明确不支持、未解锁或配置关闭的未执行任务从当日列表排除；失败、数据未知、待复核及历史记录仍保留。新版没有问答和找图执行器，不代表旧版请求协议仍可使用。
- 修复 Bing 浮层附加任务分组未进入推广队列、搜索额度缺失被误判为零而跳过的问题。额度缺失时只读复核，仍无法确认则显示未执行，不强行搜索；另一平台的有效任务继续调度。

- 核心直接输出版本化任务状态，区分执行中、待复核、部分完成、未得分停止和中断；进程正常退出不等于全部任务成功。
- 任务预计分值、剩余额度、已确认得分与账号余额变化分开显示。缺失数据保留为待确认；只有有效的任务积分计数或对应活动响应才能确认任务得分。
- 无法归因的余额变化单列，不按比例分配到任务，也不计入“今日已确认新增”。其他设备的活动可能影响账号余额。
- 提交后缺少证据时只读复核，立即一次，等待 2 秒和 10 秒后各一次；认证失败或限流停止复核。不因确认失败重复领取，不在运行结束后新增后台账号查询。
- 运行详情支持具体中文日志、级别与关键词筛选、自动刷新开关。连续相同调试消息折叠计数；长时间无进展提示不会自动重跑任务。
- Web 首次使用此修复时以事务增加确认元数据和积分事件表。旧记录及原数值保留并标记“旧记录未核验”，不计入新口径的确认统计；重复升级不会清空数据。
- 确认统计按 `TZ` 和确认时间分日，运行中与结束记录按同一事件去重；跨日确认计入确认日。升级前应在服务停止后备份 Web 数据目录及原密钥，回退前恢复对应备份，避免新旧版本混写。
- 此修复没有新增依赖、环境变量或 Compose 挂载。源码本地验证不代表镜像已发布或真实账号已获得积分。

### 离线检查

```text
npm run build
npm run lint
node --test scripts/api/*.test.js
cd web
npm run check
npm test
```

测试使用模拟响应与临时合成数据；不需要浏览器、真实账号或外部通知。界面浏览器验收与运行机部署验收须另行进行。

### 运行机验收

- 确认 NAS 主机没有发布 `3010`，浏览器响应中没有完整邮箱或 Control API Token。
- 验证中文状态、单账号启动、正常停止、积分更新和 Web 重启后的历史记录。
- 单账号通过后再逐个增加账号，最后启用定时计划。
- 回滚时先停止新栈，再恢复旧容器；不要同时启动两套任务。
