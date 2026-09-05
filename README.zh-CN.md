# Microsoft Rewards v4 中文控制台部署

本仓库由原版 v4.3.2 核心和独立中文 Web 组成。核心负责账号登录与 Rewards 任务，Web 提供加密账号管理、中文运行记录、任务与积分展示、企业微信通知以及受限的启动/停止控制。

## 数据边界

- `runtime/core.env` 只保留核心 API Token 和一次性迁移前的 `ACCOUNT_N_*`；迁移后账号加密保存在 `config/accounts.enc.json`。
- `runtime/web.env` 保存同一个 Control API Token 和可选的首次管理员设置；企业微信保存后使用 Web 独立加密配置库。
- 核心账号库和 Web 配置分别使用 `/home/docker/rewards/secrets/` 下的独立 32 字节密钥，密钥只读挂载且不进入环境变量、镜像、数据库或 Web 响应。
- 原有 `/home/docker/rewards/config`、`sessions`、`logs` 继续使用；Web 历史位于 `/home/docker/rewards/web-data`。
- 核心端口 `3010` 只在 Compose 网络可见，NAS 只发布中文 Web 的 `8787` 端口。
- 结构化运行记录长期保留；原始脱敏诊断日志保留 7 天并限制为 10000 条。

## 首次准备

1. 创建 `/home/docker/rewards/config`、`sessions`、`logs`、`web-data`、`runtime` 和 `secrets`，其中 `secrets` 权限设为 `700`。
2. 将两个示例环境文件放到 `/home/docker/rewards/runtime/`，生成随机 Control API Token，分别写入 `API_TOKEN` 和 `CONTROL_API_TOKEN`，两个值必须相同。
3. 仅首次安装生成密钥；升级时不得覆盖已有密钥。以管理员身份执行以下命令，已有文件会保留。Web 以 UID/GID `1000:1000` 运行，绑定目录和密钥需要对应权限；Compose 文件型 secret 不会自动修改宿主机文件所有者。

    ```bash
    umask 077
    test -e /home/docker/rewards/secrets/core_accounts.key || openssl rand -out /home/docker/rewards/secrets/core_accounts.key 32
    test -e /home/docker/rewards/secrets/web_settings.key || openssl rand -out /home/docker/rewards/secrets/web_settings.key 32
    chmod 600 /home/docker/rewards/secrets/core_accounts.key /home/docker/rewards/secrets/web_settings.key
    chown 1000:1000 /home/docker/rewards/secrets/web_settings.key
    chown -R 1000:1000 /home/docker/rewards/web-data
    ```

    两份密钥必须分别生成并单独备份；丢失后加密数据无法恢复。`secrets` 父目录保持 `700`，容器只读取指定的只读挂载文件。

4. 如需迁移旧账号，暂时保留 `runtime/core.env` 中的 `ACCOUNT_N_*`；旧 `PROXY_AXIOS` 改为 `PROXY_HTTP`。
5. 初次验证保持 `CRON_SCHEDULE=`、`RUN_ON_START=false`，不要让旧、新容器同时运行同一账号。
6. `4.3.2-cn2` 镜像只有在仓库中手动执行容器发布工作流后才能拉取。发布完成后执行 `docker compose pull && docker compose up -d`。
7. 打开 `http://<NAS地址>:8787` 初始化管理员，在“账号管理”中执行一次性迁移或直接新增账号。确认迁移成功后可从环境文件删除 `ACCOUNT_N_*` 并重建核心容器。

## 配置原则

核心首次启动会从 `config.example.json` 生成 `/home/docker/rewards/config/config.json`。默认只使用内置 `local` 搜索词库，并关闭外部搜索词源和实验性 HTTP 搜索。其他任务延迟保持上游默认值。

真实账号验证完成后，在 `runtime/core.env` 设置五段式 `CRON_SCHEDULE` 并重建核心容器。计划变更不通过 Web 执行。运行中的任务使用启动时账号快照，账号增删改仅在核心空闲时允许，下一次运行立即生效。

企业微信在 Web 中配置。选择“直连”时访问官方地址；选择“自定义反代”时，配置地址替换官方基础地址，同时保留 `/cgi-bin/gettoken` 和 `/cgi-bin/message/send`。反代必须使用可信 HTTPS 地址且不得包含账号、查询参数或片段，因为反代会接触 `corpsecret` 和 `access_token`。

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
