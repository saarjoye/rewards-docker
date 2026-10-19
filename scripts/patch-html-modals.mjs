import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

// 1. 更新侧边栏菜单：包含 官网数据同步、账号健康体检、全局配置中心
const oldSidebarNav = `<nav class="sidebar-menu">
          <div class="menu-label">Menu</div>
          <a href="#" class="menu-item" data-section="tasks">
            <span class="menu-icon">📋</span>
            <span>四大板块任务</span>
          </a>
          <a href="#" class="menu-item" data-section="wework">
            <span class="menu-icon">💬</span>
            <span>企业微信推送</span>
          </a>
          <a href="#" class="menu-item" data-section="logs">
            <span class="menu-icon">📟</span>
            <span>实时日志流水</span>
          </a>
          <a href="#" class="menu-item" data-section="settings">
            <span class="menu-icon">⚙️</span>
            <span>系统与代理设置</span>
          </a>
        </nav>`;

const newSidebarNav = `<nav class="sidebar-menu">
          <div class="menu-label">Core Actions</div>
          <a href="#" class="menu-item active" id="menu-sync-official">
            <span class="menu-icon">⏳</span>
            <span>官网数据同步</span>
          </a>
          <a href="#" class="menu-item" id="menu-health-check">
            <span class="menu-icon">🔍</span>
            <span>账号健康体检</span>
          </a>
          <a href="#" class="menu-item" id="menu-global-config">
            <span class="menu-icon">⚙️</span>
            <span>全局配置中心</span>
          </a>

          <div class="menu-label" style="margin-top: 10px;">Monitoring</div>
          <a href="#" class="menu-item" id="menu-open-logs">
            <span class="menu-icon">📟</span>
            <span>实时日志推流</span>
          </a>
        </nav>`;

content = content.replace(oldSidebarNav, newSidebarNav);

// 2. 插入模态框：【官网数据同步】(对标图 7)
const syncModalHtml = `
  <!-- 模态框 5：官网数据同步 (对标图 7) -->
  <div id="modal-sync-official" class="modal-backdrop hidden">
    <div class="modal-card modal-card-md">
      <div class="modal-head">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 20px;">⏳</span>
          <h3 class="modal-h3">官网同步</h3>
        </div>
        <button class="modal-close-x" id="close-sync-modal">&times;</button>
      </div>

      <div class="sync-status-box">
        <span class="sync-tag-prep" id="sync-stage-tag">准备中</span>
        <span class="sync-stage-desc" id="sync-stage-desc">正在从微软官网同步真实任务完成度...</span>
      </div>

      <!-- 动态进度条 -->
      <div class="sync-progress-outer">
        <div class="sync-progress-inner" id="sync-progress-fill" style="width: 25%;"></div>
      </div>

      <!-- 步骤指示列表 (对标图 7 四项) -->
      <div class="sync-steps-list">
        <div class="sync-step-row active" id="step-row-1">
          <span class="step-bullet">●</span>
          <span class="step-txt">锁定账号上下文</span>
        </div>
        <div class="sync-step-row" id="step-row-2">
          <span class="step-bullet">○</span>
          <span class="step-txt">请求官网数据 (/earn 与 /dashboard)</span>
        </div>
        <div class="sync-step-row" id="step-row-3">
          <span class="step-bullet">○</span>
          <span class="step-txt">解析真实进度 (RSC Flight 协议解码)</span>
        </div>
        <div class="sync-step-row" id="step-row-4">
          <span class="step-bullet">○</span>
          <span class="step-txt">刷新看板与历史对账</span>
        </div>
      </div>

      <div class="modal-foot" style="justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button type="button" class="btn-cancel" id="btn-sync-bg">后台运行</button>
        <button type="button" class="btn-primary-blue" id="btn-sync-close">关闭</button>
      </div>
    </div>
  </div>
`;

// 3. 插入模态框：【账号健康体检】(对标图 8 四维诊断)
const healthModalHtml = `
  <!-- 模态框 6：账号健康体检 (对标图 8) -->
  <div id="modal-health-check" class="modal-backdrop hidden">
    <div class="modal-card modal-card-lg">
      <div class="modal-head">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 20px;">🔍</span>
          <h3 class="modal-h3">微软账号登录状态体检</h3>
        </div>
        <button class="modal-close-x" id="close-health-modal">&times;</button>
      </div>

      <!-- 体检范围切换 (对标图 8 顶部) -->
      <div class="health-scope-row">
        <span class="health-scope-label">体检范围</span>
        <div class="health-scope-pills">
          <button class="scope-pill active" id="btn-health-single">单个账号</button>
          <button class="scope-pill" id="btn-health-all">全部账号</button>
        </div>
        <select class="f-select-sm" id="health-select-account" style="margin-left: 8px;">
          <!-- 动态填充账号 -->
        </select>
      </div>

      <!-- 诊断状态大标头 -->
      <div class="health-summary-banner" id="health-summary-banner">
        <div class="health-status-circle green" id="health-status-icon"></div>
        <div>
          <div class="health-summary-title" id="health-summary-title">诊断检测通过</div>
          <div class="health-summary-sub" id="health-summary-sub">账号已具备全部任务执行所需凭据，状态正常良好</div>
        </div>
      </div>

      <!-- 四维诊断列表卡片 (对标图 8) -->
      <div class="health-cards-stack">
        <!-- 1. 必应网页端 Cookie -->
        <div class="health-card-item">
          <div class="h-card-top">
            <div class="h-card-name"><span class="h-icon">💻</span> 必应网页端 Cookie</div>
            <span class="h-status-tag" id="h-cookie-tag">检测中</span>
          </div>
          <div class="h-card-desc" id="h-cookie-desc">--</div>
        </div>

        <!-- 2. 移动端 App 授权 (DAPI) -->
        <div class="health-card-item">
          <div class="h-card-top">
            <div class="h-card-name"><span class="h-icon">📱</span> 移动端 App 授权 (DAPI)</div>
            <span class="h-status-tag" id="h-oauth-tag">检测中</span>
          </div>
          <div class="h-card-desc" id="h-oauth-desc">--</div>
        </div>

        <!-- 3. 容器出口 IP 与国区防风控 -->
        <div class="health-card-item">
          <div class="h-card-top">
            <div class="h-card-name"><span class="h-icon">🌐</span> 容器出口 IP 与国区防风控</div>
            <span class="h-status-tag" id="h-net-tag">检测中</span>
          </div>
          <div class="h-card-desc" id="h-net-desc">--</div>
        </div>

        <!-- 4. 微软平台实时配额 -->
        <div class="health-card-quota-row">
          <div class="h-quota-col">
            <span class="h-quota-lbl">微软平台实时总积分</span>
            <span class="h-quota-val" id="h-quota-balance">--</span>
          </div>
          <div class="h-quota-col">
            <span class="h-quota-lbl">PC 搜索配额状态</span>
            <span class="h-quota-val" id="h-quota-search">--</span>
          </div>
          <div class="h-quota-col">
            <span class="h-quota-lbl">新闻阅读任务进度</span>
            <span class="h-quota-val" id="h-quota-news">--</span>
          </div>
        </div>
      </div>

      <div class="modal-foot" style="justify-content: flex-end; gap: 10px; margin-top: 18px;">
        <button type="button" class="btn-cancel" id="btn-re-check">🔄 重新检测</button>
        <button type="button" class="btn-primary-blue" id="btn-health-confirm">确定</button>
      </div>
    </div>
  </div>
`;

// 4. 插入模态框：【全局配置中心】(对标图 1-5 + 图 6 五大 Tab 完整矩阵)
const globalConfigModalHtml = `
  <!-- 模态框 7：全局配置中心 (对标图 1-6) -->
  <div id="modal-global-config" class="modal-backdrop hidden">
    <div class="modal-card modal-card-xl">
      <div class="modal-head">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 20px;">⚙️</span>
          <h3 class="modal-h3">全局配置中心</h3>
        </div>
        <button class="modal-close-x" id="close-global-modal">&times;</button>
      </div>

      <!-- 五大 Tab 标签栏 (对标图 1) -->
      <div class="cfg-tabs-row">
        <button class="cfg-tab active" data-cfgtab="account"><span class="cfg-icon">👤</span> 账号与凭证</button>
        <button class="cfg-tab" data-cfgtab="network"><span class="cfg-icon">🌐</span> 网络与代理</button>
        <button class="cfg-tab" data-cfgtab="tasks"><span class="cfg-icon">⚡</span> 任务与防风控</button>
        <button class="cfg-tab" data-cfgtab="scheduler"><span class="cfg-icon">⏰</span> 定时巡检</button>
        <button class="cfg-tab" data-cfgtab="notify"><span class="cfg-icon">🔔</span> 消息推送</button>
      </div>

      <!-- Tab 1 内容：账号与凭证 + 图 6 拟人化错峰时段设定 -->
      <div class="cfg-pane" id="pane-cfg-account">
        <div class="cfg-section-title">切换当前编辑的账号</div>
        <div style="display: flex; gap: 10px; margin-bottom: 16px;">
          <select id="cfg-select-acc" class="f-select" style="flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1;">
            <!-- 动态填充 -->
          </select>
          <button type="button" class="btn-sm-ghost" id="cfg-btn-refresh-accs">刷新列表</button>
        </div>

        <!-- 嵌入图 6「拟人化错峰时段设定」 -->
        <div class="cfg-card-box" style="margin-top: 14px;">
          <div class="cfg-box-title">⏰ 拟人化错峰时段设定 (4小时时间窗)</div>
          <div class="peak-slots-grid">
            <button type="button" class="slot-select-btn active">🌅 09:00 - 13:00 (上午)</button>
            <button type="button" class="slot-select-btn active">☀️ 13:00 - 17:00 (下午)</button>
            <button type="button" class="slot-select-btn active">☕ 17:00 - 21:00 (傍晚)</button>
            <button type="button" class="slot-select-btn active">🌙 21:00 - 次日 01:00 (夜间)</button>
            <button type="button" class="slot-select-btn">✏️ 自定义时间</button>
          </div>
          <div class="cfg-tip-txt" style="margin-top: 8px;">
            区间内 0~60 分钟随机启动，PC 搜索将在 2 小时内平缓分散执行，彻底模拟真人上网作息。
          </div>
        </div>
      </div>

      <!-- Tab 2 内容：网络与代理 (对标图 2) -->
      <div class="cfg-pane hidden" id="pane-cfg-network">
        <div class="f-checkbox" style="font-size: 14px; font-weight: 600; margin-bottom: 12px;">
          <input type="checkbox" id="cfg-net-enabled">
          <label for="cfg-net-enabled">启用网络代理</label>
        </div>

        <div class="f-group">
          <label style="font-weight: 700;">代理地址 (支持 HTTP / HTTPS / SOCKS5)</label>
          <input type="text" id="cfg-net-proxy" placeholder="例如：http://192.168.1.10:7890 或 socks5://127.0.0.1:1080">
        </div>

        <div class="f-checkbox" style="margin: 14px 0;">
          <input type="checkbox" id="cfg-net-lock-cn" checked>
          <label for="cfg-net-lock-cn" style="font-weight: 700;">锁定中国大陆 IP（非 CN 出口自动停止，防封号）</label>
        </div>

        <button type="button" class="btn-cancel" id="btn-test-network-egress" style="padding: 9px 18px;">测试当前网络连通性与出口地区</button>
        <span id="network-test-msg" style="margin-left: 10px; font-size: 12px; font-weight: 600;"></span>
      </div>

      <!-- Tab 3 内容：任务与防风控 (对标图 3) -->
      <div class="cfg-pane hidden" id="pane-cfg-tasks">
        <div class="cfg-checkbox-grid">
          <label class="task-check-lbl"><input type="checkbox" id="t-chk-checkin" checked> 每日双端签入 (PC+App)</label>
          <label class="task-check-lbl"><input type="checkbox" id="t-chk-read" checked> 新闻资讯自动阅读 (10篇)</label>
          <label class="task-check-lbl"><input type="checkbox" id="t-chk-search" checked> 必应 PC 搜索任务 (60分)</label>
          <label class="task-check-lbl"><input type="checkbox" id="t-chk-quiz" checked> 活动卡片与 Quiz 自动答题</label>
          <label class="task-check-lbl"><input type="checkbox" id="t-chk-dailyset" checked> 每日连续活动集 (Daily Set)</label>
          <label class="task-check-lbl"><input type="checkbox" id="t-chk-weekly" checked> 桌面端专属每周打孔卡 (70分/周)</label>
        </div>

        <div class="f-checkbox" style="margin-top: 10px;">
          <input type="checkbox" id="t-chk-rerun" checked>
          <label for="t-chk-rerun">全部完成后，手动重跑仍完整执行（定时任务每账号每天只排一次）</label>
        </div>

        <!-- 搜索节奏设置 (对标图 3) -->
        <div class="cfg-card-box" style="margin-top: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div class="cfg-box-title">⏱️ 搜索节奏设置 (全局生效，所有账号共用)</div>
            <div style="display: flex; gap: 8px;">
              <button type="button" class="preset-pill active" id="btn-preset-fast">⚡ 极速拟人 (18s+6s)</button>
              <button type="button" class="preset-pill" id="btn-preset-relaxed">🐢 悠闲防风控 (180s+30s)</button>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div class="f-group">
              <label>每次搜索基础间隔 (秒)</label>
              <input type="number" id="pacing-base" value="18" min="5" max="300">
            </div>
            <div class="f-group">
              <label>每次随机浮动 (秒，只会延后)</label>
              <input type="number" id="pacing-jitter" value="6" min="1" max="60">
            </div>
          </div>

          <div class="f-group" style="margin-top: 6px;">
            <label>停滞保护：连续多少次搜索没有加分就主动停手</label>
            <input type="number" id="pacing-stagnation" value="10" min="1" max="20">
          </div>
          <div class="cfg-tip-txt">
            搜索额度已到顶或账号被限流时，继续搜只会白白增加风控暴露面。达到该次数即主动结束本轮搜索。
          </div>
        </div>

        <!-- 执行引擎 -->
        <div class="f-group" style="margin-top: 14px;">
          <label>PC 搜索执行引擎</label>
          <select id="cfg-engine-select" class="f-select" style="padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1;">
            <option value="playwright">Playwright / Chromium 拟人浏览器引擎 (强烈推荐：真实键盘打字/滚轮，抗封锁最强)</option>
          </select>
        </div>
      </div>

      <!-- Tab 4 内容：定时巡检 (对标图 4) -->
      <div class="cfg-pane hidden" id="pane-cfg-scheduler">
        <div class="f-checkbox" style="font-size: 14px; font-weight: 700; margin-bottom: 12px;">
          <input type="checkbox" id="cfg-sched-enabled" checked>
          <label for="cfg-sched-enabled">开启后台自动定时巡检</label>
        </div>

        <div class="f-group">
          <label>Cron 调度表达式</label>
          <input type="text" id="cfg-sched-cron" value="*/25 * * * *" placeholder="*/25 * * * *">
          <span class="f-hint">常用预设：*/25 * * * * (每25分钟检测一次) | 0 8,12,18 * * * (每天8点、12点、18点)</span>
        </div>

        <div class="cfg-card-box" style="margin-top: 16px;">
          <div class="cfg-box-title">🔒 管理员登录</div>
          <div class="cfg-tip-txt" style="margin-top: 6px;">
            管理员账号已由安全网关流程建立，配置页不再保存明文 Web 密码。如需修改账号或密码，请退出登录后使用登录页重新初始化。
          </div>
        </div>
      </div>

      <!-- Tab 5 内容：消息推送 (对标图 5) -->
      <div class="cfg-pane hidden" id="pane-cfg-notify">
        <div class="f-group">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label>企业微信机器人 Webhook Key 或完整链接</label>
            <button type="button" class="btn-sm-ghost" id="btn-test-wework-bot">测试</button>
          </div>
          <input type="text" id="cfg-wework-robot" placeholder="例如：xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx">
        </div>

        <!-- 企业微信应用消息 (对标图 5) -->
        <div class="cfg-card-box" style="margin-top: 12px;">
          <div class="f-checkbox" style="font-weight: 700;">
            <input type="checkbox" id="cfg-ww-app-enabled" checked>
            <label for="cfg-ww-app-enabled">📱 企业微信应用消息 (自建应用推送)</label>
          </div>
          <div class="cfg-tip-txt" style="margin-bottom: 10px;">需在企业微信管理后台创建自建应用，获取 CorpID、AgentId 与 Secret。启用后按下方配置发送应用消息。</div>

          <div class="f-group">
            <label>API Base URL (留空使用官方地址)</label>
            <input type="text" id="cfg-ww-baseurl" placeholder="https://qyapi.weixin.qq.com">
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="f-group">
              <label>企业 CorpID</label>
              <input type="text" id="cfg-ww-corpid" placeholder="ww...">
            </div>
            <div class="f-group">
              <label>应用 AgentId</label>
              <input type="text" id="cfg-ww-agentid" placeholder="1000002">
            </div>
          </div>

          <div class="f-group">
            <label>应用 Secret</label>
            <input type="password" id="cfg-ww-secret" placeholder="输入应用的 Secret 密钥">
            <span class="f-hint">已保存 Secret，留空或保持占位符不会覆盖。</span>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <div class="f-group">
              <label>接收成员 (touser)</label>
              <input type="text" id="cfg-ww-touser" value="@all" placeholder="@all">
            </div>
            <div class="f-group">
              <label>最大重试次数</label>
              <input type="number" id="cfg-ww-retries" value="5" min="1" max="10">
            </div>
          </div>

          <div style="text-align: right; margin-top: 8px;">
            <button type="button" class="btn-cancel" id="btn-test-ww-app-modal">测试应用推送</button>
          </div>
        </div>

        <div class="f-group" style="margin-top: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <label>钉钉机器人 Access Token 或完整链接</label>
            <button type="button" class="btn-sm-ghost" id="btn-test-dingtalk-bot">测试</button>
          </div>
          <input type="text" id="cfg-dingding-robot" placeholder="access_token (需设置关键词包含 #)">
        </div>
      </div>

      <div class="modal-foot" style="justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button type="button" class="btn-cancel" id="cancel-global-modal">取消</button>
        <button type="button" class="btn-primary-blue" id="btn-save-all-config">保存所有配置</button>
      </div>
    </div>
  </div>
`;

// 插入到 index.html
if (!content.includes('modal-sync-official')) {
  content = content.replace('  <!-- 模态框 4：启动任务选择器', syncModalHtml + '\n' + healthModalHtml + '\n' + globalConfigModalHtml + '\n  <!-- 模态框 4：启动任务选择器');
  fs.writeFileSync('src/web/public/index.html', content, 'utf8');
  console.log('index.html updated with 3 sidebar modals (Images 1-8)');
} else {
  console.log('modals already exist');
}
