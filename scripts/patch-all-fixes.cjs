const fs = require('fs');

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

// 1. 替换 renderAccountsList：将状态标签移到名字旁边，卡片右侧增加「✏️ 编辑账号」
const oldAccountsList = `    const topAllItem = (
      '<div class="store-card-row ' + (isAllSelected ? 'selected-card' : '') + '" onclick="switchView(\\'all\\')" title="点击切换回全账号合并大盘统计">' +
        '<div class="store-row-left">' +
          '<div class="store-thumb ' + (isAllSelected ? 'thumb-active' : '') + '">🌐</div>' +
          '<div class="store-row-meta">' +
            '<div style="display: flex; align-items: center; gap: 6px;">' +
              '<span class="store-row-title">全部账号大盘合计</span>' +
              (isAllSelected ? '<span class="badge-active-tag">当前大盘</span>' : '') +
            '</div>' +
            '<span class="store-row-cid">合并多账号成效 (共 ' + accounts.length + ' 户 · ' + totalTodayPts + '分)</span>' +
          '</div>' +
        '</div>' +
        '<div style="display: flex; align-items: center; gap: 6px;">' +
          '<span class="pill-open" style="background: rgba(16, 185, 129, 0.1); color: #059669;">● 全局总览</span>' +
        '</div>' +
      '</div>'
    );

    const accountRows = accounts.map((a) => {
      const initial = (a.name || a.user || "A")[0].toUpperCase();
      const isSelected = viewMode === "single" && selectedAccountId === a.id;
      const isRunning = a.status === "running";

      return (
        '<div class="store-card-row ' + (isSelected ? 'selected-card' : '') + '" onclick="switchView(\\'single\\', \\'' + a.id + '\\')" title="点击切换查看该账号独立大盘与数据">' +
          '<div class="store-row-left">' +
            '<div class="store-thumb ' + (isSelected ? 'thumb-active' : '') + '">' + initial + '</div>' +
            '<div class="store-row-meta">' +
              '<div style="display: flex; align-items: center; gap: 6px;">' +
                '<span class="store-row-title">' + escapeHtml(a.name || a.user) + '</span>' +
                (isSelected ? '<span class="badge-active-tag">当前查看中</span>' : '') +
              '</div>' +
              '<span class="store-row-cid">' + (a.user ? (a.user.substring(0, 18) + "...") : "") + '</span>' +
            '</div>' +
          '</div>' +
          '<div style="display: flex; align-items: center; gap: 6px;">' +
            '<span class="' + (isRunning ? 'pill-running' : 'pill-open') + '">' + (isRunning ? '● 执行中' : '● 正常就绪') + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');`;

const newAccountsList = `    const topAllItem = (
      '<div class="store-card-row ' + (isAllSelected ? 'selected-card' : '') + '" onclick="switchView(\\'all\\')" title="点击切换回全账号合并大盘统计">' +
        '<div class="store-row-left">' +
          '<div class="store-thumb ' + (isAllSelected ? 'thumb-active' : '') + '">🌐</div>' +
          '<div class="store-row-meta">' +
            '<div style="display: flex; align-items: center; gap: 8px;">' +
              '<span class="store-row-title">全部账号大盘合计</span>' +
              (isAllSelected ? '<span class="badge-active-tag">当前大盘</span>' : '') +
              '<span class="pill-open" style="background: rgba(16, 185, 129, 0.1); color: #059669;">● 全局总览</span>' +
            '</div>' +
            '<span class="store-row-cid">合并多账号成效 (共 ' + accounts.length + ' 户 · ' + totalTodayPts + '分)</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    const accountRows = accounts.map((a) => {
      const initial = (a.name || a.user || "A")[0].toUpperCase();
      const isSelected = viewMode === "single" && selectedAccountId === a.id;
      const isRunning = a.status === "running";

      return (
        '<div class="store-card-row ' + (isSelected ? 'selected-card' : '') + '" onclick="switchView(\\'single\\', \\'' + a.id + '\\')" title="点击切换查看该账号独立大盘与数据">' +
          '<div class="store-row-left">' +
            '<div class="store-thumb ' + (isSelected ? 'thumb-active' : '') + '">' + initial + '</div>' +
            '<div class="store-row-meta">' +
              '<div style="display: flex; align-items: center; gap: 8px;">' +
                '<span class="store-row-title">' + escapeHtml(a.name || a.user) + '</span>' +
                (isSelected ? '<span class="badge-active-tag">当前查看中</span>' : '') +
                '<span class="' + (isRunning ? 'pill-running' : 'pill-open') + '">' + (isRunning ? '● 执行中' : '● 正常就绪') + '</span>' +
              '</div>' +
              '<span class="store-row-cid">' + (a.user ? (a.user.substring(0, 18) + "...") : "") + '</span>' +
            '</div>' +
          '</div>' +
          '<div style="display: flex; align-items: center; gap: 6px;">' +
            '<button class="btn-edit-account-row" onclick="event.stopPropagation(); window.openEditAccountModal(\\'' + a.id + '\\')" title="修改账号资料、密码与代理">✏️ 编辑</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');`;

content = content.replace(oldAccountsList, newAccountsList);

// 2. 增加 openEditAccountModal 全局函数
const editAccountModalFn = `
  window.openEditAccountModal = (accId) => {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) return;
    document.getElementById("acc-id").value = acc.id;
    document.getElementById("acc-name").value = acc.name || "";
    document.getElementById("acc-user").value = acc.user || "";
    document.getElementById("acc-pass").value = "******";
    document.getElementById("acc-proxy").value = acc.proxy || "";
    document.getElementById("acc-enabled").checked = acc.enabled !== false;
    document.getElementById("account-modal-title").textContent = "编辑微软托管账号资料";
    document.getElementById("modal-account")?.classList.remove("hidden");
  };
`;

if (!content.includes('window.openEditAccountModal')) {
  content = content.replace('  window.switchView =', editAccountModalFn + '\n  window.switchView =');
}

// 3. 官网同步：不再打开即自动触发，改为等待点击「▶ 开始同步」
const oldOpenSync = `  async function openSyncOfficialModal() {
    modalSyncOfficial?.classList.remove("hidden");
    setSyncStep(1, 25, "准备中", "正在锁定当前账号上下文与无头浏览器资源...");
    await new Promise((r) => setTimeout(r, 600));

    const activeAcc = accounts.find((a) => a.id === selectedAccountId) || accounts[0];
    fetch("/api/sync/official", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: activeAcc ? activeAcc.id : null })
    }).catch(() => {});

    setSyncStep(2, 55, "请求中", "正在访问微软官方 /earn 与 /dashboard 权威账本...");
    await new Promise((r) => setTimeout(r, 1400));

    setSyncStep(3, 85, "解码中", "正在解析 React Flight 数据流与四大板块卡片对象...");
    await new Promise((r) => setTimeout(r, 1200));

    setSyncStep(4, 100, "已完成", "官网真实成效与总额同步完毕，大盘已完全更新！");
    refreshDashboard();
  }`;

const newOpenSync = `  async function openSyncOfficialModal() {
    modalSyncOfficial?.classList.remove("hidden");
    document.getElementById("btn-start-sync-action").style.display = "inline-block";
    document.getElementById("btn-sync-bg").style.display = "none";
    document.getElementById("sync-stage-tag").textContent = "待就绪";
    document.getElementById("sync-stage-desc").textContent = "请点击下方「开始同步」按钮，从微软官网权威拉取最新成效 (避免误触占用账号锁)";
    document.getElementById("sync-progress-fill").style.width = "0%";

    for (let i = 1; i <= 4; i++) {
      const row = document.getElementById("step-row-" + i);
      if (row) {
        row.className = "sync-step-row";
        row.querySelector(".step-bullet").textContent = "○";
      }
    }
  }

  async function startSyncOfficialExecution() {
    document.getElementById("btn-start-sync-action").style.display = "none";
    document.getElementById("btn-sync-bg").style.display = "inline-block";

    setSyncStep(1, 25, "准备中", "正在锁定当前账号上下文与无头浏览器资源...");
    await new Promise((r) => setTimeout(r, 600));

    const activeAcc = accounts.find((a) => a.id === selectedAccountId) || accounts[0];
    fetch("/api/sync/official", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: activeAcc ? activeAcc.id : null })
    }).catch(() => {});

    setSyncStep(2, 55, "请求中", "正在访问微软官方 /earn 与 /dashboard 权威账本...");
    await new Promise((r) => setTimeout(r, 1400));

    setSyncStep(3, 85, "解码中", "正在解析 React Flight 数据流与四大板块卡片对象...");
    await new Promise((r) => setTimeout(r, 1200));

    setSyncStep(4, 100, "已完成", "官网真实成效与总额同步完毕，大盘已完全更新！");
    refreshDashboard();
  }

  document.getElementById("btn-start-sync-action")?.addEventListener("click", startSyncOfficialExecution);`;

content = content.replace(oldOpenSync, newOpenSync);

// 4. 健康体检：不再打开即自动检测，改为等待点击「▶ 开始检测」
const oldOpenHealth = `  async function openHealthCheckModal() {
    modalHealthCheck?.classList.remove("hidden");
    const selAcc = document.getElementById("health-select-account");
    if (selAcc) {
      selAcc.innerHTML = accounts
        .map((a) => '<option value="' + a.id + '">' + escapeHtml(a.name || a.user) + '</option>')
        .join('');
      if (selectedAccountId) selAcc.value = selectedAccountId;
    }
    runHealthCheck();
  }`;

const newOpenHealth = `  async function openHealthCheckModal() {
    modalHealthCheck?.classList.remove("hidden");
    const selAcc = document.getElementById("health-select-account");
    if (selAcc) {
      selAcc.innerHTML = accounts
        .map((a) => '<option value="' + a.id + '">' + escapeHtml(a.name || a.user) + '</option>')
        .join('');
      if (selectedAccountId) selAcc.value = selectedAccountId;
    }

    // 重置为待检测安全状态，绝不自动发起请求
    const banner = document.getElementById("health-summary-banner");
    const bannerIcon = document.getElementById("health-status-icon");
    const bannerTitle = document.getElementById("health-summary-title");
    const bannerSub = document.getElementById("health-summary-sub");

    if (banner) {
      banner.style.background = "#f8fafc";
      banner.style.borderColor = "#e2e8f0";
    }
    if (bannerIcon) bannerIcon.className = "health-status-circle";
    if (bannerTitle) {
      bannerTitle.textContent = "等待开始检测";
      bannerTitle.style.color = "#475569";
    }
    if (bannerSub) bannerSub.textContent = "请确认体检范围后点击下方「▶ 开始检测」按钮 (避免误触占用账号锁)";

    document.getElementById("h-cookie-tag").textContent = "待检测";
    document.getElementById("h-cookie-tag").className = "h-status-tag";
    document.getElementById("h-cookie-desc").textContent = "--";

    document.getElementById("h-oauth-tag").textContent = "待检测";
    document.getElementById("h-oauth-tag").className = "h-status-tag";
    document.getElementById("h-oauth-desc").textContent = "--";

    document.getElementById("h-net-tag").textContent = "待检测";
    document.getElementById("h-net-tag").className = "h-status-tag";
    document.getElementById("h-net-desc").textContent = "--";

    document.getElementById("h-quota-balance").textContent = "--";
    document.getElementById("h-quota-search").textContent = "--";
    document.getElementById("h-quota-news").textContent = "--";

    document.getElementById("btn-start-health-check").style.display = "inline-block";
    document.getElementById("btn-re-check").style.display = "none";
  }`;

content = content.replace(oldOpenHealth, newOpenHealth);

// 绑定 btn-start-health-check
content = content.replace(
  'document.getElementById("btn-re-check")?.addEventListener("click", runHealthCheck);',
  `document.getElementById("btn-start-health-check")?.addEventListener("click", () => {
    document.getElementById("btn-start-health-check").style.display = "none";
    document.getElementById("btn-re-check").style.display = "inline-block";
    runHealthCheck();
  });
  document.getElementById("btn-re-check")?.addEventListener("click", runHealthCheck);`
);

// 绑定 Tab 1 里的编辑选定账号按钮
const editSelectedAccHandler = `
  document.getElementById("cfg-btn-edit-selected-acc")?.addEventListener("click", () => {
    const accId = document.getElementById("cfg-select-acc")?.value;
    if (accId) {
      modalGlobalConfig?.classList.add("hidden");
      window.openEditAccountModal(accId);
    }
  });
`;

if (!content.includes('cfg-btn-edit-selected-acc')) {
  content = content.replace('  // 配置中心 Tab 切换', editSelectedAccHandler + '\n  // 配置中心 Tab 切换');
}

fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js successfully updated with all user requested fixes');
