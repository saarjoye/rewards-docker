import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

// 1. 移除侧边栏菜单中的 Dashboard 项
const oldMenuDash = `<a href="#" class="menu-item active" data-section="dashboard">
            <span class="menu-icon">⊞</span>
            <span>Dashboard</span>
          </a>\n`;

content = content.replace(oldMenuDash, '');
// 如果没有换行匹配，再次精确匹配
content = content.replace(/<a href="#" class="menu-item active" data-section="dashboard">[\s\S]*?<\/a>\s*/i, '');

// 2. 移除 Topbar 左侧的标题 Dashboard
const oldTopWelcome = `<div class="topbar-welcome">
          <div style="display: flex; align-items: center; gap: 14px;">
            <h1 class="welcome-title">Dashboard</h1>
            <div class="view-mode-capsule">
              <button class="mode-pill active" id="btn-mode-all">🌐 全账号合计</button>
              <button class="mode-pill" id="btn-mode-single">👤 单账号明细</button>
            </div>
          </div>
          <p class="welcome-sub" id="welcome-sub-desc">全部账号数据合并大盘统计 · 官方实时真实对账</p>
        </div>`;

const newTopWelcome = `<div class="topbar-welcome">
          <div class="topbar-left-controls">
            <div class="view-mode-capsule">
              <button class="mode-pill active" id="btn-mode-all">🌐 全账号合计</button>
              <button class="mode-pill" id="btn-mode-single">👤 单账号明细</button>
            </div>
            <span class="welcome-sub-inline" id="welcome-sub-desc">全部账号数据合并大盘统计 · 官方实时数据驱动</span>
          </div>
        </div>`;

content = content.replace(oldTopWelcome, newTopWelcome);

// 3. 移除铃铛图标
const oldBell = '<div class="icon-btn-badge" id="btn-bell" title="今日到账通知">🔔<span class="badge-dot"></span></div>';
content = content.replace(oldBell, '');

// 4. 在用户芯片旁增加安全「退出」按钮
const oldUserChip = `<div class="user-chip">
            <div class="user-avatar-sm">桂</div>
            <div class="user-meta-sm">
              <span class="user-title-sm" id="user-display-name">桂林</span>
              <span class="user-role-sm">Admin</span>
            </div>
          </div>`;

const newUserChip = `<div class="user-chip">
            <div class="user-avatar-sm">管</div>
            <div class="user-meta-sm">
              <span class="user-title-sm" id="user-display-name">管理员</span>
              <span class="user-role-sm">Admin</span>
            </div>
            <button class="btn-logout-pill" id="btn-admin-logout" title="安全退出系统登录">退出</button>
          </div>`;

content = content.replace(oldUserChip, newUserChip);

fs.writeFileSync('src/web/public/index.html', content, 'utf8');
console.log('index.html cleanly updated: Dashboard removed from both sidebar and topbar, bell removed, logout added');
