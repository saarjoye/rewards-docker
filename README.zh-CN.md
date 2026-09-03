# Microsoft Rewards v4 中文控制台部署

本仓库由原版 v4.3.2 核心和独立中文 Web 组成。核心负责账号登录与 Rewards 任务，Web 只负责脱敏展示、持久历史、企业微信通知以及受限的启动/停止控制。

## 数据边界

- `runtime/core.env` 保存 Microsoft 账号和核心 API Token。
- `runtime/web.env` 保存同一个 Control API Token、Web 管理员和可选企业微信凭证。
- `config-v4/`、`sessions-v4/`、`web-data/` 与旧 v3 目录分离，旧数据保持不变。
- 核心端口 `3010` 只在 Compose 网络可见，NAS 只发布中文 Web 的 `8787` 端口。
- Web 不提供账号、核心配置、定时计划、会话或企业微信凭证的写接口。

## 首次准备

1. 将 `runtime/core.env.example` 复制为 `runtime/core.env`，将 `runtime/web.env.example` 复制为 `runtime/web.env`。
2. 生成至少 32 字节的随机 Token，分别写入 `API_TOKEN` 和 `CONTROL_API_TOKEN`，两个值必须相同。
3. 在 `runtime/core.env` 填写 `ACCOUNT_N_*`，旧 `PROXY_AXIOS` 改为 `PROXY_HTTP`。
4. 初次验证保持 `CRON_SCHEDULE=`、`RUN_ON_START=false`，不要让旧、新容器同时运行同一账号。
5. 执行 `docker compose build rewards-core rewards-web`，然后执行 `docker compose up -d`。
6. 打开 `http://<NAS地址>:8787` 初始化管理员，通过 Web 一次只运行一个账号。

## 配置原则

核心首次启动会从 `config.example.json` 生成 `config-v4/config.json`。默认只使用内置 `local` 搜索词库，并关闭外部搜索词源和实验性 HTTP 搜索。其他任务延迟保持上游默认值。

真实账号验证完成后，在 `runtime/core.env` 设置五段式 `CRON_SCHEDULE` 并重建核心容器。计划变更不通过 Web 执行。

旧 Cookie 和指纹不迁移。需要人工登录时使用上游 v4 的 `manual-login` 流程，并确保登录网络、地区与自动任务一致。

## 旧积分历史

先把旧文件复制到 `web-data/import/points-history.json`，再执行预检：

```bash
docker compose exec rewards-web node scripts/import-v3-history.mjs /app/data/import/points-history.json --dry-run
```

确认统计后才使用 `--apply`。导入工具只接受旧版积分历史结构，不读取 checkpoint、任务进度、会话或原始日志，原文件不会被修改。

## 验收与回滚

- 确认 NAS 主机没有发布 `3010`，浏览器响应中没有完整邮箱或 Control API Token。
- 验证中文状态、单账号启动、正常停止、积分更新和 Web 重启后的历史记录。
- 单账号通过后再逐个增加账号，最后启用定时计划。
- 回滚时先停止新栈，再恢复旧容器；不要同时启动两套任务。
