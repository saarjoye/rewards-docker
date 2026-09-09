# Next 发布与部署

Next 单应用沿用 `ghcr.io/saarjoye/mrs-core` 镜像名，替代旧版 Core/Web 双容器。**不是旧 Core 的接口兼容更新：旧 Web 依赖 3010 控制接口，不能继续搭配新版镜像。**

## 发布和切换

现有仓库的 `main` 分支通过 `.github/workflows/docker-image.yml` 构建。先执行离线测试、类型检查、ESLint、构建和 Compose 校验，再构建 `linux/amd64` 与 `linux/arm64` 候选镜像。候选镜像使用空数据、禁用外部网络做启动健康检查；成功后才更新 `5.0.0-next.1` 与 `latest`。完整提交固定标签为 `sha-<完整提交号>`。

不再发布 `mrs-web`，旧版本标签保留。发布不会自动部署运行机，不能只对旧 Compose 执行 pull/up。

1. 停止新任务并等待当前任务退出，在维护窗口一致性备份旧数据、会话，保存旧 Compose 及镜像摘要或固定版本。
2. 停止旧 Core/Web，保留其数据、目录和卷，不执行 `down -v`。禁止新旧调度同时操作账号。
3. 在独立 Next 目录使用本项目的单应用 Compose，不能挂载旧数据库或会话。
4. 设置首次管理员引导变量后启动，确认健康状态再管理账号与验收真实任务。

```sh
docker compose pull
docker compose up -d --no-build
docker compose ps
```

账号、历史和会话不自动从旧项目导入。定时计划仍为上海时间每天 07:00，启动不自动运行。

## 本地构建

需要本地 Docker 环境；固定浏览器基础层，构建与运行均不配置代理：

```sh
docker build -f docker/Dockerfile.browser -t microsoft-rewards-next-browser:patchright-1.61.1 .
docker build -t microsoft-rewards-next:local .
```

流水线基础层复用同一镜像的 `browser-patchright-1.61.1` 标签和构建缓存。Rewards 浏览器运行时继续使用 `--no-proxy-server`。

默认端口为 `8788`，与旧项目隔离。`data`、`sessions`、`logs` 和 `backups` 使用独立挂载目录。账号只通过 Web UI 添加，不使用账号环境变量。

`WEB_ADMIN_USER` 与 `WEB_ADMIN_PASSWORD` 仅允许首次引导管理员；初始化完成后应从运行配置移除。生产环境优先将主密钥挂载为 Docker Secret。

## 回退

停止 Next 并保留其独立数据卷，使用保存的旧 Compose 和旧版固定镜像恢复旧 Core/Web，不能使用已指向 Next 的 `latest`。不要让旧程序读写 Next 数据库，也不要删除数据库来回退。
