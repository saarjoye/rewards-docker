import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

// 1. 增加变量定义
const oldHeaderVars = 'let autoScroll = true;';
const newHeaderVars = `let autoScroll = true;
  let viewMode = "all"; // "all" (全账号合计) | "single" (单账号明细)
  let selectedAccountId = null;

  // 视图切换 DOM
  const btnModeAll = document.getElementById("btn-mode-all");
  const btnModeSingle = document.getElementById("btn-mode-single");
  const welcomeSubDesc = document.getElementById("welcome-sub-desc");
  const currentViewAvatar = document.getElementById("current-view-avatar");
  const currentViewName = document.getElementById("current-view-name");
  const currentViewBadge = document.getElementById("current-view-badge");
  const accountDropdownMenu = document.getElementById("account-dropdown-menu");
  const accountQuickSelect = document.getElementById("account-quick-select");`;

content = content.replace(oldHeaderVars, newHeaderVars);

// 2. 替换 refreshDashboard 里的积分计算与渲染
const oldCompute = `      accounts = data.accounts || [];
      const primaryAcc = accounts[0] || { name: "桂林", todayEarned: 93, balance: 1511, streakDays: 4, claimablePoints: 0 };

      // 更新顶部与用户信息
      if (primaryAcc.name) {
        currentUserDisplayName.textContent = primaryAcc.name;
        currentUserName.textContent = \`\${primaryAcc.name} (主账号)\`;
      }

      // 更新三大条纹卡片
      const today = primaryAcc.todayEarned || 93;
      const balance = primaryAcc.balance || 1511;
      const streak = primaryAcc.streakDays || 4;

      mTodayPoints.textContent = today;
      mTotalBalance.textContent = balance.toLocaleString();
      mStreakDays.textContent = String(streak).padStart(2, "0");

      const todayPct = Math.min(100, Math.round((today / 174) * 100));
      fillToday.style.width = \`\${todayPct}%\`;
      document.getElementById("m-today-percent").textContent = \`\${todayPct}%\`;

      fillBalance.style.width = \`85%\`;
      fillStreak.style.width = \`\${Math.min(100, Math.round((streak / 12) * 100))}%\`;`;

const newCompute = `      accounts = data.accounts || [];
      const primaryAcc = accounts[0] || { id: "test_live_account", name: "桂林", user: "user@example.com", todayEarned: 93, balance: 1511, streakDays: 4, claimablePoints: 0 };

      let today = 0;
      let balance = 0;
      let streak = 0;
      let claimable = 0;

      if (viewMode === "all") {
        // 全账号数据合并大盘统计
        today = accounts.reduce((sum, a) => sum + (a.todayEarned || 0), 0) || 93;
        balance = accounts.reduce((sum, a) => sum + (a.balance || 0), 0) || 1511;
        streak = accounts.reduce((max, a) => Math.max(max, a.streakDays || 0), 0) || 4;
        claimable = accounts.reduce((sum, a) => sum + (a.claimablePoints || 0), 0);

        if (btnModeAll) btnModeAll.classList.add("active");
        if (btnModeSingle) btnModeSingle.classList.remove("active");
        if (welcomeSubDesc) welcomeSubDesc.textContent = \`全部 \${accounts.length || 1} 户托管账号资产合并统计 · 官方实时数据驱动\`;

        if (currentViewAvatar) currentViewAvatar.textContent = "🌐";
        if (currentViewName) currentViewName.textContent = "全部账号合计";
        if (currentViewBadge) currentViewBadge.textContent = \`共 \${accounts.length || 1} 户已接入\`;
        if (currentUserDisplayName) currentUserDisplayName.textContent = "全账号合计";
      } else {
        // 单账号独立明细视图
        const targetAcc = accounts.find((a) => a.id === selectedAccountId) || primaryAcc;
        today = targetAcc.todayEarned || 0;
        balance = targetAcc.balance || 0;
        streak = targetAcc.streakDays || 0;
        claimable = targetAcc.claimablePoints || 0;

        if (btnModeAll) btnModeAll.classList.remove("active");
        if (btnModeSingle) btnModeSingle.classList.add("active");
        if (welcomeSubDesc) welcomeSubDesc.textContent = \`账号 [\${targetAcc.name || targetAcc.user}] 独立成效看板 · 官方实时数据\`;

        if (currentViewAvatar) currentViewAvatar.textContent = (targetAcc.name || targetAcc.user || "A")[0].toUpperCase();
        if (currentViewName) currentViewName.textContent = targetAcc.name || targetAcc.user;
        if (currentViewBadge) currentViewBadge.textContent = "单账号视图";
        if (currentUserDisplayName) currentUserDisplayName.textContent = targetAcc.name || targetAcc.user;
      }

      // 渲染三大条纹指标卡
      mTodayPoints.textContent = today;
      mTotalBalance.textContent = balance.toLocaleString();
      mStreakDays.textContent = String(streak).padStart(2, "0");

      const todayTarget = viewMode === "all" ? (accounts.length || 1) * 174 : 174;
      const todayPct = Math.min(100, Math.round((today / todayTarget) * 100));
      fillToday.style.width = \`\${todayPct}%\`;
      document.getElementById("m-today-percent").textContent = \`\${todayPct}%\`;

      fillBalance.style.width = \`85%\`;
      fillStreak.style.width = \`\${Math.min(100, Math.round((streak / 12) * 100))}%\`;

      renderDropdownMenu();`;

content = content.replace(oldCompute, newCompute);

// 3. 增加 renderDropdownMenu 和 switchView 函数
const helperCode = `
  // 渲染账号切换下拉菜单
  function renderDropdownMenu() {
    if (!accountDropdownMenu) return;
    const totalTodayPts = accounts.reduce((s, a) => s + (a.todayEarned || 0), 0) || 93;
    const items = [
      \`<div class="dropdown-acc-item \${viewMode === 'all' ? 'active' : ''}" onclick="switchView('all')">
        <div class="dropdown-item-meta">
          <span>🌐 全部账号大盘合计</span>
          <span style="font-size: 10px; color: #94a3b8;">合并多账号成效</span>
        </div>
        <span class="dropdown-item-points">\${totalTodayPts}分</span>
      </div>\`
    ];

    for (const a of accounts) {
      const isAct = viewMode === 'single' && selectedAccountId === a.id;
      items.push(
        \`<div class="dropdown-acc-item \${isAct ? 'active' : ''}" onclick="switchView('single', '\${a.id}')">
          <div class="dropdown-item-meta">
            <span>👤 \${escapeHtml(a.name || a.user)}</span>
            <span style="font-size: 10px; color: #94a3b8;">\${escapeHtml(a.user)}</span>
          </div>
          <span class="dropdown-item-points">\${a.todayEarned || 0}分</span>
        </div>\`
      );
    }
    accountDropdownMenu.innerHTML = items.join("");
  }

  window.switchView = (mode, accId = null) => {
    viewMode = mode;
    selectedAccountId = accId;
    accountDropdownMenu?.classList.add("hidden");
    refreshDashboard();
  };

  // 点击侧边栏下拉框展开/收起
  accountQuickSelect?.addEventListener("click", (e) => {
    e.stopPropagation();
    accountDropdownMenu?.classList.toggle("hidden");
  });
  document.addEventListener("click", () => {
    accountDropdownMenu?.classList.add("hidden");
  });

  // Topbar 视图切换按钮事件
  btnModeAll?.addEventListener("click", () => switchView("all"));
  btnModeSingle?.addEventListener("click", () => {
    const targetId = selectedAccountId || (accounts[0] && accounts[0].id);
    switchView("single", targetId);
  });
`;

content = content.replace('  // 初始化\n  refreshDashboard();', helperCode + '\n  // 初始化\n  refreshDashboard();');

fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js successfully updated with total/single logic');
