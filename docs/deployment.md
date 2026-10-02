# Next 发布与部署

Next 单应用沿用 `ghcr.io/saarjoye/mrs-core` 镜像名，替代旧版 Core/Web 双容器。**不是旧 Core 的接口兼容更新：旧 Web 依赖 3010 控制接口，不能继续搭配新版镜像。**

## 发布和切换

现有仓库的 `main` 分支通过 `.github/workflows/docker-image.yml` 构建。先执行离线测试、类型检查、ESLint、构建和 Compose 校验，再构建 `linux/amd64` 与 `linux/arm64` 候选镜像。候选镜像使用空数据、禁用外部网络做启动健康检查；成功后才更新 `5.0.0-next.21` 与 `latest`。完整提交固定标签为 `sha-<完整提交号>`。

## next.21 升级与兼容修复

本版包含：

- 首页领取控件的中英文识别、局部金额证据和慢加载只读等待；未知积分不记为零，
  禁用控件或非官方来源不点击，提交后未确认不重发。
- 认证入口的有界 commit 导航、主文档失败分类、超时与取消清理；普通密码和已有
  Session 恢复路径保留。新版通行密钥页只做被动识别与严格官方方式返回，不包含
  自动取消 WebAuthn、伪造认证或自动处理 MFA 的实验。
- 任务卡片按官方身份及目的地约束匹配，区分找不到、来源/类型冲突和仍未完成；
  已提交的 pending 任务只能只读复核。
- 同一官方任务的多来源观察选择整条权威记录，避免混合来源、类型和进度；SQLite
  只在同一不可变任务身份内刷新派生分类，保留历史、任务键和 mutation 账本。

应用镜像为 `ghcr.io/saarjoye/mrs-core:5.0.0-next.21`。只有 GitHub Actions 的
候选验证与提升步骤成功后，该版本及 `latest` 才可用于升级；代码推送成功不等于
镜像已发布。多架构构建仍使用锁定的依赖和 Patchright 1.61.1 浏览器层。

### 已有 Docker 服务更新

1. 在管理页停止当前任务并确认完全空闲，避开定时触发窗口；按原部署方式做一致性
   备份，记录旧镜像标签或 digest。不要直接用强制重启代替任务正常停止。
2. 保留原 Compose 文件、项目名、服务名、端口、全部数据卷、主密钥和环境配置。
   如需固定版本，只把原服务的 `image` 改为上述 next.21 镜像；不要用示例文件覆盖
   现有部署。已有调度继续保留，`RUN_ON_START` 应为 `false`。
3. 在原 Compose 项目目录使用原来的 `-p` / `-f` / `--env-file` 参数拉取并重建
   应用服务。下面仅适用于已经使用本仓库 `compose.yaml` 及默认服务名的部署：

   ```sh
   docker compose pull microsoft-rewards-next
   docker compose up -d --no-deps --no-build --pull never microsoft-rewards-next
   docker compose ps microsoft-rewards-next
   ```

4. 检查容器健康、管理页版本、账号、历史、数据卷与定时设置。升级本身不自动启动
   真实账号任务；新一轮积分和正值领取仍须按授权范围核对。

不要执行 `docker compose down -v`、清理持久卷或重新生成密钥。需要回退时，先
确认空闲，再把原服务的 `image` 恢复为记录的旧镜像，并用相同项目/配置参数重建；
不得通过覆盖数据库或重复提交 pending 任务来“恢复”积分。

## 既有版本说明

next.20 修复最终结算读取 HTML 登录页导致账号失败的问题：识别鉴权跳转、保留 Flyout 最低 5 秒预算，结算重试耗尽后按已有有效余额证据完成或降级为 partial。日历改用轻量运行摘要与任务统计，并新增 8 个业务索引；迁移按基础表、账本表、索引顺序执行，支持空数据库与原数据卷升级。

本版同时补齐多账号及 PC/移动搜索每日去重：新增 search_query_reservations 表，提交前持久化占用，重启不释放；以账号持久 ID 和日期选择候选词，词库耗尽时停止而不重复使用。修复取消、异常和延迟弹窗泄漏，移除每第 10 次额外搜索导航，完善 24 小时预算与网页 stagnantLimit 设置。保留现有数据卷；回退 next.19 后每日严格去重保证不再生效，新增表和索引可保留。未验证真实账号积分增长或服务端风控效果。

验证：399 项离线测试、类型检查、ESLint、前后端构建通过；合成整月日历独立测试由约 2386ms 降至 59ms（31 天、62 次运行、3 个账号、3720 条任务快照、7440 条证据记录），结果一致。月度 LIKE 查询仍可能扫描表，收益主要来自移除深层详情与证据展开。

next.19 修复搜索执行器 60 分钟硬编码超时限制并放宽搜索延迟上限：解除整轮搜索截止时间的 60 分钟死上限（调整为动态预算驱动并设 24 小时兜底保护），彻底解决长延时防风控模式下搜索任务运行满 60 分钟被误判超时中断的问题；同时将系统配置与 Web 界面的单次搜索延迟上限从 300 秒放宽至 900 秒（15 分钟）。无新增数据库迁移，保留全部历史与数据卷；可保留数据卷回退 next.18。

next.18 移植 wangxun 拟人化搜索执行模型：实现单页面会话级复用并在退出时安全收口；每 10 次搜索周期性携带 PC=U531、FORM=ANNTA1 及 32 位十六进制 cvid 导航刷新；支持拟人打字延迟与三击清空模拟；视口高度相对平滑随机滚动；点击结果时自动清理弹窗标签页；连续 10 次无涨分自动停滞跳出（stagnant detection）转为 verification-pending；内置 1,117 条本地高质量离线中文词库与确定性轮询。无新增数据库迁移，保留全部历史与数据卷；可保留数据卷回退 next.17。

next.17 新增“搜索设置”页面，保存搜索间隔、随机滚动、结果点击与结果页停留时间，保存后下一次搜索即生效。搜索框未就绪时最多重试一次且不重复提交；未完成的 PC/移动搜索在运行收口时保留进度并转为 verification-pending。无新增数据库迁移，保留全部历史与数据卷；可保留数据卷回退 next.16。

next.12 在 next.11 的 dashboard 进度保护基础上，增加 verification-pending 搜索的显式、受限重试：默认只读复核，仅单账号、指定账号、变更模式且用户授权时最多提交一次；continue 模式拒绝目标账号和重试参数。保留今日得分、账号总分、定时和通知反代；可保留数据卷回退 next.11。升级后检查观察进度及部分完成状态；单次成功不保证后续搜索持续计分。

next.10 首页每个账号并列展示“今日得分”和“账号总分”：前者保留上海日期内的余额净变化，后者取该账号最新有效余额，附更新时间。当天尚无记录仍显示历史最新总分；从未有数据或最新同刻余额冲突显示破折号，真实零保留。不累加任务预计积分、不因页面刷新额外请求Rewards。无新增迁移，保留全部历史、定时设置及反代；可保持原卷回退next.9。

next.9 统一 Offer 执行与检查的三页面查找，最多两轮动态候选等待，点击前绑定并复核目标；激活前缺失、认证、网络、浏览器、激活失败及明确拒绝分别分类。链接不可用保持部分完成，激活结果未知禁止再次提交。账号完成必须具备本运行必需任务完成证据；详情与通知同口径，历史只在查询时保守展示，不重写旧数据或重发旧通知。失败及部分完成缺少最终余额时尝试一次有时限只读收口，保留真实余额和任务到账数字，缺失显示破折号。

本版无新增迁移，保留 next.8 定时设置、通知反代及全部数据卷。已有 Next 用户在 Portainer 更新同一 Stack 并重新拉取 latest，先停止任务并完成一致性备份；不执行 down -v。可保留数据库回退 next.8，但旧版不包含此次错误分类和完成约束。离线验收不代表生产 Offer 已恢复；升级后核对版本、定时设置、链接不可用状态、账号余额和部分完成通知。

next.7 分离执行模式、批次状态和账号结果，统一详情、首页、日历、报告与通知的状态映射和账号计数。三账号 partial 显示已结束3/3、完全完成0/3、部分完成3。没有新增迁移；沿用next.6的Schema 5，保留卷与全部历史。可以回退到兼容同一Schema的next.6，不能直接让next.5旧writer写新增列后的数据库。

next.6 聚合任务级实时总余额与到账金额，增加可空任务快照关联。升级会幂等执行Schema 5，保留全部历史和卷，先做一致性备份。旧版余额writer不兼容新增列，不能简单切回next.5继续写入；回退应使用兼容Schema 5的镜像或恢复升级前备份并保留升级后数据副本。禁止删表、删列或重建数据卷。

next.5 将本轮实时余额与最终余额分开，统一账号、运行、上海日期统计范围；账号推送显示最新观测的“实时总分”，保留本轮增量，未知显示破折号。无需新增数据库迁移，保留历史、消息反代设置及数据卷。回退使用 next.4 固定标签并保留数据库。真实官方积分证据的可用性仍需运行端验证，不从余额残差伪造任务收入。

next.4 修复活动链接匹配、partial 生命周期、失败通知、失败后的只读余额收口及任务证据显示。无新增数据库迁移，不批量纠正旧历史。官方到账回执仅在明确身份与金额匹配时接入，线上字段可用性尚未验证；任务进度不会冒充到账。升级保持企业微信反代、原数据卷及端口，回退可使用 next.3 固定标签并保留数据库。

next.3 包含 TDesign 全页面重构、移动端与操作保护，以及企业微信可选 HTTPS 反代。已有 Next 升级时保留原端口、数据卷和主密钥；新增反代地址在“消息推送”保存，留空使用官方接口，不影响 Rewards 直连。反代地址使用独立加密兼容列，不改写历史积分。回退 next.2 时保留数据库，旧版忽略反代字段并使用官方接口。

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

账号、历史和会话不自动从旧项目导入。定时计划默认上海时间每天 07:00，启动不自动运行。

next.8 新增导航“定时任务”：启停、每日时间、保存反馈、下次执行时间和未保存离开保护。保存立即重新排期，不立即执行；已存在运行时跳过，不排队补跑。配置通过幂等事务创建的独立 `schedule_settings` 表保存，优先于启动变量；首次读取 `RUN_SCHEDULE`，兼容 `CRON_SCHEDULE`，否则默认 07:00。自定义 cron 保留到用户主动保存每日时间。重启恢复已保存设置，不修改历史积分或既有卷。回退 next.7 时保留新表，但旧应用忽略页面设置，需核对启动变量防止意外调度。

next.8 同时让有效隔离任务余额参与共享汇总，查询不新增积分记录，任务详情证据优先展示最新复核、其次回执、最后执行记录。

## 本地构建

需要本地 Docker 环境；固定浏览器基础层，默认不配置代理。下载受限时可以按下文
LXC 部署说明仅为构建临时配置代理，应用运行时保持直连：

```sh
docker build -f docker/Dockerfile.browser -t microsoft-rewards-next-browser:patchright-1.61.1 .
docker build -t microsoft-rewards-next:local .
```

流水线基础层复用同一镜像的 `browser-patchright-1.61.1` 标签和构建缓存。Rewards 浏览器运行时继续使用 `--no-proxy-server`。

默认端口为 `8788`，与旧项目隔离。`data`、`sessions`、`logs` 和 `backups` 使用独立挂载目录。账号只通过 Web UI 添加，不使用账号环境变量。

`WEB_ADMIN_USER` 与 `WEB_ADMIN_PASSWORD` 仅允许首次引导管理员；初始化完成后应从运行配置移除。生产环境优先将主密钥挂载为 Docker Secret。

## 回退

已经使用 Next 单容器的用户升级时保留原服务名、`8787:3000` 映射及全部 Next 数据卷；无需套用示例的 8788 端口。先停止任务并做一致性备份，再重新拉取 `mrs-core:latest` 并重建容器。不要重新创建空卷，否则配置看起来会消失。

next.2 启动以幂等事务新增账号完成事件、积分账本和通知队列表，不批量改写历史积分。通知设置位于“消息推送”，使用企业微信应用官方接口。旧双容器的通知密文不会导入；在 Next 中重新填写应用配置。Next 自身设置加密保存在数据卷，升级和重启不清空。

本轮统计与通知规则见[运行状态、通知与积分证据](run-notifications-points.md)。回退到 next.1 时保留新增表和数据卷；旧应用不展示新通知功能。不要删除表或数据库来回退。

停止 Next 并保留其独立数据卷，使用保存的旧 Compose 和旧版固定镜像恢复旧 Core/Web，不能使用已指向 Next 的 `latest`。不要让旧程序读写 Next 数据库，也不要删除数据库来回退。

## LXC 本地源码独立部署

`compose.lxc.yaml` 是独立的本地源码部署入口，不与默认拉取发布镜像的
`compose.yaml` 合并。默认管理端口仍为 `8788`，容器使用非 root 的 `node` 用户、
`init`、512 MB 共享内存和独立持久卷，不使用 `privileged`。

- 先确认 LXC 内 Docker Engine、Compose 与 Buildx 均可用。保留已有可用的 Docker；
  缺少 Buildx 时只补装对应发行版插件，不为了构建替换正在使用的引擎。
- 使用新的部署目录，只传应用源码、构建清单及 Docker 配置。不复制源码机的 `.env`、
  `lxc106/`、账号数据、会话、密钥、日志、备份或 `node_modules/`。
- 创建部署专用的 `.env`，可设置 `IMAGE_TAG`、`APP_VERSION`、`WEB_BIND_IP` 和
  `WEB_PORT`。管理员变量仅用于首次引导，并应使用独立强密码，不能复用 SSH 密码。
- 首次初始化独立主密钥后保留它；不得在升级时重建或覆盖。

首次创建密钥（部署目录中以 root 执行；只适用于尚无主密钥的新安装）：

```sh
install -d -m 0700 secrets
test ! -e secrets/rewards_master_key
(umask 077; head -c 32 /dev/urandom > secrets/rewards_master_key)
chown 1000:1000 secrets/rewards_master_key
chmod 0400 secrets/rewards_master_key
```

浏览器基础层使用 Debian 官方源的 HTTPS 地址，保留 TLS 证书校验。精简 Node 镜像
的系统 CA 包通过 Node 自带的可信根证书临时引导安装，引导文件和配置随后删除。

浏览器基础层将 npm 安装、系统 CA、浏览器依赖与 Chromium 下载分为独立缓存层。apt 下载失败
最多重试两次，临时重试配置在依赖安装成功后移除；后续浏览器下载失败不会导致
已完成的系统依赖重新下载。

应用编译后使用已有 npm 缓存离线重新安装生产依赖，替代目标环境中长时间未完成的
`npm prune`。最终编译与生产依赖准备层禁止联网，不执行安装脚本，也不修改依赖版本或
锁文件。该步骤跳过在线审计以保持离线；不能将镜像构建成功视为依赖安全审计通过，
导入真实账号前应单独检查生产依赖告警，依赖升级需另行确认。

构建浏览器基础层与应用：

```sh
docker build -f docker/Dockerfile.browser -t microsoft-rewards-next-browser:patchright-1.61.1 .
docker compose -f compose.lxc.yaml --env-file .env config --quiet
docker compose -f compose.lxc.yaml --env-file .env build
```

Docker Hub 不可达而项目 GHCR 可达时，可以复用本项目固定版本的浏览器基础层，
不需要更换第三方镜像源或修改 Docker daemon 网络配置：

```sh
docker pull ghcr.io/saarjoye/mrs-core:browser-patchright-1.61.1
docker tag ghcr.io/saarjoye/mrs-core:browser-patchright-1.61.1 microsoft-rewards-next-browser:patchright-1.61.1
docker compose -f compose.lxc.yaml --env-file .env build
```

如果 GHCR 大镜像下载也很慢，可将浏览器构建的 Node 基础层切换为 Docker 官方
在 AWS Public ECR 发布的同版本镜像。只覆盖已有的 `NODE_IMAGE` 构建参数，
仍固定 Node 24.11.1 和 Patchright 1.61.1，不修改 daemon 镜像源或运行时代理：

```sh
docker pull public.ecr.aws/docker/library/node:24.11.1-bookworm-slim
docker build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:24.11.1-bookworm-slim -f docker/Dockerfile.browser -t microsoft-rewards-next-browser:patchright-1.61.1 .
docker compose -f compose.lxc.yaml --env-file .env build
```

依赖下载需要 HTTP 代理时，只通过 Docker 预定义的构建参数传递。将下面占位符
替换为可从 LXC 访问的代理地址；先确认该端口确实提供 HTTP 代理且允许局域网访问。
大小写参数同时提供，以兼容 npm、浏览器下载和 apt。使用子 Shell 限定代理作用域，
不写入 Dockerfile 的 `ENV`、Compose 运行环境或 Docker daemon 配置：

```sh
(
  export HTTP_PROXY='http://<proxy-host>:<proxy-port>'
  export HTTPS_PROXY="$HTTP_PROXY"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTP_PROXY"
  docker build \
    --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:24.11.1-bookworm-slim \
    --build-arg HTTP_PROXY --build-arg HTTPS_PROXY \
    --build-arg http_proxy --build-arg https_proxy \
    -f docker/Dockerfile.browser -t microsoft-rewards-next-browser:patchright-1.61.1 .
  docker compose -f compose.lxc.yaml --env-file .env build \
    --build-arg HTTP_PROXY --build-arg HTTPS_PROXY \
    --build-arg http_proxy --build-arg https_proxy
)
```

首次管理员引导使用权限为 `0600` 的临时 `.bootstrap.env`，其中只有
`WEB_ADMIN_USER` 和 `WEB_ADMIN_PASSWORD`，不能提交或显示其内容：

```sh
docker compose -f compose.lxc.yaml --env-file .env --env-file .bootstrap.env up -d --no-build --wait
```

管理员初始化成功后，先在 Web UI 的“定时任务”关闭调度，再添加真实账号。
`RUN_ON_START=false` 只阻止启动时自动执行，不等于关闭每日调度。删除临时引导文件，
不含管理员密码的 `.env` 保持不变，重新创建容器以移除引导环境变量：

```sh
rm -- .bootstrap.env
docker compose -f compose.lxc.yaml --env-file .env up -d --no-build --force-recreate --wait
docker compose -f compose.lxc.yaml --env-file .env ps
```

管理员摘要、调度设置和账号数据存于独立数据卷；主密钥单独以 Secret 挂载。
停止服务使用 `docker compose -f compose.lxc.yaml --env-file .env down`，不要加 `-v`。
保留 `secrets/rewards_master_key` 和全部持久卷，不与旧服务共享数据或同时操作同一账号。
管理端口仅限可信内网，跨不可信网络访问时使用 SSH 隧道或另行配置 HTTPS；
本部署不修改宿主机防火墙，也不创建公网端口转发。

## 首页领取与部分完成排查

- 首页领取使用按钮的可见文字、`aria-label`、`title`，以及最多三层的单控制近邻
  “可领取/待领取”金额。页面总余额不作为可领取金额，缺失、冲突或格式异常保持未知。
- 支持原生按钮与 `role="button"`。领取汇总展开后，可以选择唯一的无数字“领取全部”
  动作；已展开的汇总不会再次点击收起，存在 `aria-controls` 时仅在指定面板查找。
- 金额为明确正整数且领取动作唯一、可见、可用时才提交。多个独立领取按钮不会相加
  或猜测目标，隐藏、禁用、兑换按钮和非官方 Rewards 页面不会作为领取入口。
- 点击不等于领取成功。动作仍经过原有 mutation 账本、服务端回执和只读金额复核；
  提交后结果不确定进入 `verification-pending`，不会自动重复领取。
- 一轮运行结束不等于所有账号或任务成功。认证导航超时且未读到余额时，积分应视为
  未知而非确认的零分；任务 `skipped` 要区分配置禁用、未发现任务与不可执行原因。
- 回归测试使用合成控件、DOM 树和响应，不登录或领取真实账号。其他服务机的截图
  不能用于确认本机运行失败；发布、重启和真实账号验收需分别确认，并保留持久卷
  与独立主密钥。保留调度时，还应核对下次执行时间，避免部署验收与定时任务重叠。

## 登录导航与慢加载容错

- 桌面、移动端、Bing 会话恢复与 App OAuth 的认证入口等待导航 `commit`，
  再由登录状态机观察可见控件；不再因 `domcontentloaded` 延迟直接跳过整个账号。
  单次导航仍最多 30 秒，登录流程保持 120 秒整体预算，不使用无限等待。
- 导航超时与网络失败分别记录为 `login-navigation-timeout` 和
  `login-navigation-error`，仅保留来源和路径，不记录原始异常中的查询参数或认证材料。
  网络故障不会被当成登录成功；Session 仍需 Rewards/Bing 验证后才保存。
- 未开始认证交互的未知登录页最多进行一次恢复导航；发送账号或密码后不再刷新登录入口。
  同一账号/密码步骤提交后只观察状态变化，不连续重填或重发。仅在没有可用主按钮、
  尚未点击时才使用 Enter 提交，点击结果不确定时不会再用 Enter 重试。
- 首页和展开领取面板最多追加 10 次只读控件快照、间隔 500 毫秒，等待慢加载控件。
  明确零值立即保留为零；等不到有效证据仍是未知。等待和提交前重新检查官方来源，
  取消时停止后续动作；只读重查不等于再次发送领取请求。
- 上述是源码及合成回归修复，不代表目标服务机的真实账号已经恢复。发布、容器重启、
  真实登录及领取仍需当次确认。不得通过永久代理、禁用 TLS、删除会话/数据卷或重装 Docker
  掩盖网络或账号问题；既有调度、账号、数据卷和独立主密钥保持不变。
