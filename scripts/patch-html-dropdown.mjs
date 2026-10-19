import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

// 1. 升级 Topbar：增加「🌐 全账号合计 / 👤 单账号明细」一键视图切换胶囊
const oldWelcome = `<div class="topbar-welcome">
          <h1 class="welcome-title">Dashboard</h1>
          <p class="welcome-sub">Welcome back! 微软积分全能自动化引擎稳定运行中</p>
        </div>`;

const newWelcome = `<div class="topbar-welcome">
          <div style="display: flex; align-items: center; gap: 14px;">
            <h1 class="welcome-title">Dashboard</h1>
            <div class="view-mode-capsule">
              <button class="mode-pill active" id="btn-mode-all">🌐 全账号合计</button>
              <button class="mode-pill" id="btn-mode-single">👤 单账号明细</button>
            </div>
          </div>
          <p class="welcome-sub" id="welcome-sub-desc">全部账号数据合并大盘统计 · 官方实时真实对账</p>
        </div>`;

content = content.replace(oldWelcome, newWelcome);

// 2. 升级侧边栏账号选择器为带下拉菜单的包裹层
const oldStoreSelector = `<div class="store-selector" id="account-quick-select">
          <div class="store-avatar">桂</div>
          <div class="store-info">
            <span class="store-name" id="current-user-name">桂林 (主账号)</span>
            <span class="store-badge">金牌会员</span>
          </div>
          <span class="store-chevron">▾</span>
        </div>`;

const newStoreSelector = `<div class="store-selector-wrap">
          <div class="store-selector" id="account-quick-select">
            <div class="store-avatar" id="current-view-avatar">🌐</div>
            <div class="store-info">
              <span class="store-name" id="current-view-name">全部账号合计</span>
              <span class="store-badge" id="current-view-badge">共 1 户接入</span>
            </div>
            <span class="store-chevron">▾</span>
          </div>
          <div class="account-dropdown hidden" id="account-dropdown-menu">
            <!-- 动态渲染下拉项 -->
          </div>
        </div>`;

content = content.replace(oldStoreSelector, newStoreSelector);

fs.writeFileSync('src/web/public/index.html', content, 'utf8');
console.log('index.html updated with total/single switcher');
