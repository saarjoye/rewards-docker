const fs = require('fs');

let html = fs.readFileSync('src/web/public/index.html', 'utf8');

// 统一侧边栏：彻底合并不冲突的菜单，仅保留 官网数据同步、账号健康体检、全局配置中心、实时日志推流
const sidebarStart = html.indexOf('<nav class="sidebar-menu">');
const sidebarEnd = html.indexOf('</nav>', sidebarStart);

if (sidebarStart !== -1 && sidebarEnd !== -1) {
  const cleanNav = `<nav class="sidebar-menu">
          <div class="menu-label">平台核心中枢</div>
          <a href="#" class="menu-item" id="menu-sync-official">
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

          <div class="menu-label" style="margin-top: 10px;">实时监控</div>
          <a href="#" class="menu-item" id="menu-open-logs">
            <span class="menu-icon">📟</span>
            <span>实时日志推流</span>
          </a>
        </nav>`;

  html = html.slice(0, sidebarStart) + cleanNav + html.slice(sidebarEnd + 6);
  fs.writeFileSync('src/web/public/index.html', html, 'utf8');
  console.log('Sidebar cleaned and unified with zero conflicts');
}
