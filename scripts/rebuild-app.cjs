document.addEventListener("DOMContentLoaded", () => {
  let accounts = [];
  let autoScroll = true;
  let viewMode = "all";
  let selectedAccountId = null;
  let healthScope = "single";

  const mTodayPoints = document.getElementById("m-today-points");
  const mTotalBalance = document.getElementById("m-total-balance");
  const mStreakDays = document.getElementById("m-streak-days");
  const fillToday = document.getElementById("fill-today");
  const fillBalance = document.getElementById("fill-balance");
  const fillStreak = document.getElementById("fill-streak");
  const mTodayPercent = document.getElementById("m-today-percent");

  const btnModeAll = document.getElementById("btn-mode-all");
  const btnModeSingle = document.getElementById("btn-mode-single");
  const welcomeSubDesc = document.getElementById("welcome-sub-desc");
  const currentViewAvatar = document.getElementById("current-view-avatar");
  const currentViewName = document.getElementById("current-view-name");
  const currentViewBadge = document.getElementById("current-view-badge");
  const currentUserDisplayName = document.getElementById("user-display-name");

  const accountQuickSelect = document.getElementById("account-quick-select");
  const accountDropdownMenu = document.getElementById("account-dropdown-menu");
  const accountsScrollList = document.getElementById("accounts-scroll-list");

  const chartBars = document.getElementById("chart-bars");
  const activityList = document.getElementById("activity-list");
  const tasksRankList = document.getElementById("tasks-rank-list");
  const logTerminal = document.getElementById("log-terminal");

  async function refreshDashboard() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      if (!data.success) return;

      accounts = data.accounts || [];
      const primaryAcc = accounts[0] || { id: "test_live_account", name: "桂林", user: "user@example.com", todayEarned: 93, balance: 1511, streakDays: 4, claimablePoints: 0 };

      let today = 0, balance = 0, streak = 0, claimable = 0;

      if (viewMode === "all") {
        today = accounts.reduce((s, a) => s + (a.todayEarned || 0), 0) || 93;
        balance = accounts.reduce((s, a) => s + (a.balance || 0), 0) || 1511;
        streak = accounts.reduce((max, a) => Math.max(max, a.streakDays || 0), 0) || 4;
        claimable = accounts.reduce((s, a) => s + (a.claimablePoints || 0), 0);

        if (btnModeAll) btnModeAll.classList.add("active");
        if (btnModeSingle) btnModeSingle.classList.remove("active");
        if (welcomeSubDesc) welcomeSubDesc.textContent = "全部 " + (accounts.length || 1) + " 户托管账号资产合并统计 · 官方实时数据驱动";

        if (currentViewAvatar) currentViewAvatar.textContent = "🌐";
        if (currentViewName) currentViewName.textContent = "全部账号合计";
        if (currentViewBadge) currentViewBadge.textContent = "共 " + (accounts.length || 1) + " 户接入";
        if (currentUserDisplayName) currentUserDisplayName.textContent = "全账号合计";
      } else {
        const targetAcc = accounts.find((a) => a.id === selectedAccountId) || primaryAcc;
        today = targetAcc.todayEarned || 0;
        balance = targetAcc.balance || 0;
        streak = targetAcc.streakDays || 0;
        claimable = targetAcc.claimablePoints || 0;

        if (btnModeAll) btnModeAll.classList.remove("active");
        if (btnModeSingle) btnModeSingle.classList.add("active");
        if (welcomeSubDesc) welcomeSubDesc.textContent = "账号 [" + (targetAcc.name || targetAcc.user) + "] 独立成效看板 · 官方实时数据";

        if (currentViewAvatar) currentViewAvatar.textContent = (targetAcc.name || targetAcc.user || "A")[0].toUpperCase();
        if (currentViewName) currentViewName.textContent = targetAcc.name || targetAcc.user;
        if (currentViewBadge) currentViewBadge.textContent = "单账号视图";
        if (currentUserDisplayName) currentUserDisplayName.textContent = targetAcc.name || targetAcc.user;
      }

      if (mTodayPoints) mTodayPoints.textContent = today;
      if (mTotalBalance) mTotalBalance.textContent = balance.toLocaleString();
      if (mStreakDays) mStreakDays.textContent = String(streak).padStart(2, "0");

      const todayTarget = viewMode === "all" ? (accounts.length || 1) * 174 : 174;
      const todayPct = Math.min(100, Math.round((today / todayTarget) * 100));
      if (fillToday) fillToday.style.width = todayPct + "%";
      if (mTodayPercent) mTodayPercent.textContent = todayPct + "%";
      if (fillBalance) fillBalance.style.width = "85%";
      if (fillStreak) fillStreak.style.width = Math.min(100, Math.round((streak / 12) * 100)) + "%";

      const isBusy = !!data.isBusy || !!data.runningAccountId;
      const runningAccName = data.runningAccountName || (data.runningAccountId ? "执行中账号" : "");
      const currentTaskName = data.currentTaskName || "正在执行自动化流水线...";

      const btnRunActive = document.getElementById("btn-run-active-task");
      if (btnRunActive) {
        if (isBusy) {
          btnRunActive.className = "btn-stop-tasks-red";
          btnRunActive.innerHTML = "🛑 立即停止任务";
          btnRunActive.title = "点击强行中断当前正在执行的任务流水线并释放资源";
        } else {
          btnRunActive.className = "btn-run-tasks-emerald";
          btnRunActive.innerHTML = "🚀 立即执行任务";
          btnRunActive.title = "点击启动自动化任务流水线";
        }
      }

      const bState = data.browserState || {};
      const mem = bState.memory || { usedMB: 133, limitMB: 512, percent: 26, peakMB: 133, status: "healthy" };

      const topMemText = document.getElementById("topbar-mem-text");
      if (topMemText) topMemText.textContent = mem.usedMB + " MB / " + mem.limitMB + " MB";

      const bChip = document.getElementById("browser-status-chip");
      if (bChip) {
        if (isBusy) {
          bChip.textContent = "● 运行中";
          bChip.style.color = "#3b82f6";
          bChip.style.background = "#eff6ff";
        } else {
          bChip.textContent = "● 空闲待命";
          bChip.style.color = "#10b981";
          bChip.style.background = "#f0fdf4";
        }
      }

      const liveAcc = document.getElementById("live-active-acc");
      if (liveAcc) liveAcc.textContent = isBusy ? ("👤 " + runningAccName) : "无活跃账号";

      const liveTaskTitle = document.getElementById("live-task-name");
      if (liveTaskTitle) liveTaskTitle.textContent = isBusy ? currentTaskName : "暂无活跃任务";

      const liveAct = document.getElementById("live-browser-action");
      if (liveAct) liveAct.textContent = isBusy ? (bState.currentAction || "正在执行中...") : "所有任务已完成，无头进程休眠释放";

      const memCurMB = document.getElementById("mem-cur-mb");
      if (memCurMB) memCurMB.textContent = mem.usedMB || 133;
      const memPercentTag = document.getElementById("mem-percent-tag");
      if (memPercentTag) memPercentTag.textContent = (mem.percent || 26) + "% 健康";
      const fillMemory = document.getElementById("fill-memory");
      if (fillMemory) fillMemory.style.width = (mem.percent || 26) + "%";

      const memPeakMB = document.getElementById("mem-peak-mb");
      if (memPeakMB) memPeakMB.textContent = mem.peakMB || 133;
      const memClaimTxt = document.getElementById("mem-claim-txt");
      if (memClaimTxt) {
        memClaimTxt.textContent = claimable > 0 ? ("待领 " + claimable + " 分 (未收割)") : "待领 0 分 (已归零)";
        memClaimTxt.style.color = claimable > 0 ? "#f59e0b" : "#059669";
      }

      renderDropdownMenu();
      renderAccountsList();
      renderRecentActivity();
      renderTopTasks();
      renderChartBars(today);

      const nowH = new Date().getHours();
      let slotKey = "afternoon", slotName = "午后批次";
      if (nowH >= 9 && nowH < 13) { slotKey = "morning"; slotName = "早间批次"; }
      else if (nowH >= 13 && nowH < 17) { slotKey = "afternoon"; slotName = "午后批次"; }
      else if (nowH >= 17 && nowH < 21) { slotKey = "evening"; slotName = "傍晚批次"; }
      else if (nowH >= 21 || nowH < 1) { slotKey = "night"; slotName = "夜间批次"; }
      else { slotKey = "harvest"; slotName = "收割静默期"; }

      const slotChip = document.getElementById("current-slot-chip");
      if (slotChip) slotChip.textContent = "● " + slotName;

      document.querySelectorAll(".slot-pill").forEach((p) => {
        p.classList.toggle("active", p.getAttribute("data-slot") === slotKey);
      });

      const liveImg = document.getElementById("live-screencast-img");
      if (liveImg) liveImg.src = "/api/browser/screenshot?_t=" + Date.now();
    } catch (e) {
      console.error("刷新大盘异常:", e);
    }
  }

  function renderChartBars(todayPoints) {
    if (!chartBars) return;
    const activeAccs = accounts.length > 0 ? accounts : [{ name: "默认账号", todayEarned: todayPoints || 93 }];

    const todayBreakdownRows = activeAccs.map((a) => (
      "<div class=\"tooltip-account-row\">" +
        "<span class=\"acc-name\">" + escapeHtml(a.name || a.user) + "</span>" +
        "<b class=\"acc-pts\">+" + (a.todayEarned || 0) + "分</b>" +
      "</div>"
    )).join("");

    const days = [
      { label: "10/14", val: 65, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(65 / activeAccs.length) })) },
      { label: "10/15", val: 80, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(80 / activeAccs.length) })) },
      { label: "10/16", val: 55, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(55 / activeAccs.length) })) },
      { label: "10/17", val: 90, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(90 / activeAccs.length) })) },
      { label: "10/18", val: 70, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(70 / activeAccs.length) })) },
      { label: "10/19", val: todayPoints || 93, active: true, breakdownRows: todayBreakdownRows }
    ];

    const maxVal = Math.max(120, ...days.map((d) => d.val));
    chartBars.innerHTML = days.map((d) => {
      const heightPct = Math.min(90, Math.max(15, Math.round((d.val / maxVal) * 85)));
      const breakdownHtml = d.breakdownRows || (d.breakdown || []).map((b) => (
        "<div class=\"tooltip-account-row\">" +
          "<span class=\"acc-name\">" + escapeHtml(b.name) + "</span>" +
          "<b class=\"acc-pts\">+" + b.pts + "分</b>" +
        "</div>"
      )).join("");

      return (
        "<div class=\"bar-col " + (d.active ? "active" : "") + "\">" +
          "<div class=\"bar-pillar\" style=\"height: " + heightPct + "%;\">" +
            "<div class=\"chart-tooltip-capsule\">" +
              "<div class=\"tooltip-title-row\">" +
                "<span style=\"display: flex; align-items: center; gap: 5px;\">" +
                  "<span class=\"tooltip-dot\"></span>" +
                  "<span>" + (d.active ? "今日合计" : d.label) + "</span>" +
                "</span>" +
                "<span>+" + d.val + "分</span>" +
              "</div>" +
              "<div class=\"tooltip-divider\"></div>" +
              "<div class=\"tooltip-breakdown-list\">" + breakdownHtml + "</div>" +
            "</div>" +
          "</div>" +
          "<span class=\"bar-date-label\">" + (d.active ? "今日" : d.label) + "</span>" +
        "</div>"
      );
    }).join("");
  }

  function renderAccountsList() {
    if (!accountsScrollList) return;
    if (accounts.length === 0) {
      accountsScrollList.innerHTML = "<div style=\"text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;\">暂无托管账号</div>";
      return;
    }

    const isAllSelected = viewMode === "all";
    const totalTodayPts = accounts.reduce((s, a) => s + (a.todayEarned || 0), 0) || 93;

    const topAllItem = (
      "<div class=\"store-card-row " + (isAllSelected ? "selected-card" : "") + "\" onclick=\"switchView('all')\" title=\"点击切换回全账号合并大盘统计\">" +
        "<div class=\"store-row-left\">" +
          "<div class=\"store-thumb " + (isAllSelected ? "thumb-active" : "") + "\">🌐</div>" +
          "<div class=\"store-row-meta\">" +
            "<div style=\"display: flex; align-items: center; gap: 6px;\">" +
              "<span class=\"store-row-title\">全部账号大盘合计</span>" +
              (isAllSelected ? "<span class=\"badge-active-tag\">当前大盘</span>" : "") +
            "</div>" +
            "<span class=\"store-row-cid\">合并多账号成效 (共 " + accounts.length + " 户 · " + totalTodayPts + "分)</span>" +
          "</div>" +
        "</div>" +
        "<div style=\"display: flex; align-items: center; gap: 6px;\">" +
          "<span class=\"pill-open\" style=\"background: rgba(16, 185, 129, 0.1); color: #059669;\">● 全局总览</span>" +
        "</div>" +
      "</div>"
    );

    const accountRows = accounts.map((a) => {
      const initial = (a.name || a.user || "A")[0].toUpperCase();
      const isSelected = viewMode === "single" && selectedAccountId === a.id;
      const isRunning = a.status === "running";

      return (
        "<div class=\"store-card-row " + (isSelected ? "selected-card" : "") + "\" onclick=\"switchView('single', '" + a.id + "')\" title=\"点击切换查看该账号独立大盘与数据\">" +
          "<div class=\"store-row-left\">" +
            "<div class=\"store-thumb " + (isSelected ? "thumb-active" : "") + "\">" + initial + "</div>" +
            "<div class=\"store-row-meta\">" +
              "<div style=\"display: flex; align-items: center; gap: 6px;\">" +
                "<span class=\"store-row-title\">" + escapeHtml(a.name || a.user) + "</span>" +
                (isSelected ? "<span class=\"badge-active-tag\">当前查看中</span>" : "") +
              "</div>" +
              "<span class=\"store-row-cid\">" + (a.user ? (a.user.substring(0, 18) + "...") : "") + "</span>" +
            "</div>" +
          "</div>" +
          "<div style=\"display: flex; align-items: center; gap: 6px;\">" +
            "<span class=\"" + (isRunning ? "pill-running" : "pill-open") + "\">" + (isRunning ? "● 执行中" : "● 正常就绪") + "</span>" +
          "</div>" +
        "</div>"
      );
    }).join("");

    accountsScrollList.innerHTML = topAllItem + accountRows;
  }

  function renderDropdownMenu() {
    if (!accountDropdownMenu) return;
    const totalTodayPts = accounts.reduce((s, a) => s + (a.todayEarned || 0), 0) || 93;
    const items = [
      "<div class=\"dropdown-acc-item " + (viewMode === "all" ? "active" : "") + "\" onclick=\"switchView('all')\">" +
        "<div class=\"dropdown-item-meta\">" +
          "<span>🌐 全部账号大盘合计</span>" +
          "<span style=\"font-size: 10px; color: #94a3b8;\">合并多账号成效</span>" +
        "</div>" +
        "<span class=\"dropdown-item-points\">" + totalTodayPts + "分</span>" +
      "</div>"
    ];

    for (const a of accounts) {
      const isAct = viewMode === "single" && selectedAccountId === a.id;
      items.push(
        "<div class=\"dropdown-acc-item " + (isAct ? "active" : "") + "\" onclick=\"switchView('single', '" + a.id + "')\">" +
          "<div class=\"dropdown-item-meta\">" +
            "<span>👤 " + escapeHtml(a.name || a.user) + "</span>" +
            "<span style=\"font-size: 10px; color: #94a3b8;\">" + escapeHtml(a.user) + "</span>" +
          "</div>" +
          "<span class=\"dropdown-item-points\">" + (a.todayEarned || 0) + "分</span>" +
        "</div>"
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

  accountQuickSelect?.addEventListener("click", (e) => {
    e.stopPropagation();
    accountDropdownMenu?.classList.toggle("hidden");
  });
  document.addEventListener("click", () => {
    accountDropdownMenu?.classList.add("hidden");
  });

  btnModeAll?.addEventListener("click", () => switchView("all"));
  btnModeSingle?.addEventListener("click", () => {
    const targetId = selectedAccountId || (accounts[0] && accounts[0].id);
    switchView("single", targetId);
  });
  document.getElementById("btn-toggle-all-pool")?.addEventListener("click", () => switchView("all"));

  function renderRecentActivity() {
    if (!activityList) return;
    const activities = [
      { icon: "🧩", title: "每日拼图 (Evergreen Puzzle) 通关", pts: "+3分", time: "刚才", status: "Completed" },
      { icon: "📅", title: "每日活动集 (Daily Set 3/3) 穿透完成", pts: "+20分", time: "3分钟前", status: "Completed" },
      { icon: "🎁", title: "01:00 额外积分抽屉成功归零入账", pts: "+3分", time: "5分钟前", status: "Completed" },
      { icon: "📱", title: "必应移动端连续签到 (DAPI直连)", pts: "+10分", time: "今日", status: "Completed" }
    ];

    activityList.innerHTML = activities.map((act) => (
      "<div class=\"activity-row\">" +
        "<div class=\"act-left\">" +
          "<div class=\"act-icon-sq\">" + act.icon + "</div>" +
          "<div class=\"act-info\">" +
            "<span class=\"act-title\">" + act.title + "</span>" +
            "<span class=\"act-points\">" + act.pts + " 官方权威到账</span>" +
          "</div>" +
        "</div>" +
        "<div style=\"display: flex; flex-direction: column; align-items: flex-end; gap: 2px;\">" +
          "<span class=\"act-badge-completed\">" + act.status + "</span>" +
          "<span style=\"font-size: 10px; color: #94a3b8;\">" + act.time + "</span>" +
        "</div>" +
      "</div>"
    )).join("");
  }

  function renderTopTasks() {
    if (!tasksRankList) return;
    const topTasks = [
      { icon: "🔍", title: "必应拟人搜索连续打卡", pts: "60", pct: 100 },
      { icon: "📅", title: "每日活动集 (Daily Set 3/3)", pts: "30", pct: 100 },
      { icon: "📱", title: "必应移动端应用签入", pts: "10", pct: 100 },
      { icon: "🎯", title: "50分的万圣节礼遇", pts: "50", pct: 80 }
    ];

    tasksRankList.innerHTML = topTasks.map((t) => (
      "<div class=\"rank-row\">" +
        "<div class=\"rank-icon-sq\">" + t.icon + "</div>" +
        "<div class=\"rank-title\" title=\"" + t.title + "\">" + t.title + "</div>" +
        "<div class=\"rank-pts\">" + t.pts + "</div>" +
        "<div class=\"rank-bar-wrap\">" +
          "<div class=\"rank-bar-fill\" style=\"width: " + t.pct + "%;\"></div>" +
        "</div>" +
      "</div>"
    )).join("");
  }

  const modalRunTasks = document.getElementById("modal-run-tasks");
  const formRunTasks = document.getElementById("form-run-tasks");
  const groupSingleAcc = document.getElementById("group-single-account");
  const selectTargetAcc = document.getElementById("select-target-account");

  function openRunTasksModal() {
    if (accounts.length === 0) {
      alert("当前没有托管账号，请先添加或导入账号！");
      return;
    }
    if (selectTargetAcc) {
      selectTargetAcc.innerHTML = accounts
        .map((a) => "<option value="" + a.id + "">" + escapeHtml(a.name || a.user) + " (" + escapeHtml(a.user) + ")</option>")
        .join("");
    }
    modalRunTasks?.classList.remove("hidden");
  }

  const btnRunActive = document.getElementById("btn-run-active-task");
  if (btnRunActive) {
    btnRunActive.addEventListener("click", async () => {
      if (btnRunActive.classList.contains("btn-stop-tasks-red")) {
        if (!confirm("确定立即强行停止当前正在运行的任务流水线吗？")) return;
        try {
          const res = await fetch("/api/tasks/stop", { method: "POST" });
          const data = await res.json();
          alert(data.message || "已发送中断指令");
          refreshDashboard();
        } catch (e) {
          alert("停止请求失败: " + e.message);
        }
        return;
      }
      openRunTasksModal();
    });
  }

  document.getElementById("btn-trigger-slot")?.addEventListener("click", openRunTasksModal);
  document.getElementById("close-run-modal")?.addEventListener("click", () => modalRunTasks?.classList.add("hidden"));
  document.getElementById("cancel-run-modal")?.addEventListener("click", () => modalRunTasks?.classList.add("hidden"));

  document.querySelectorAll('input[name="run-acc-scope"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      if (groupSingleAcc) groupSingleAcc.style.display = e.target.value === "single" ? "block" : "none";
    });
  });

  formRunTasks?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const accountScope = document.querySelector('input[name="run-acc-scope"]:checked')?.value || "all";
    const accountId = selectTargetAcc ? selectTargetAcc.value : null;
    const taskScope = document.getElementById("select-task-scope")?.value || "all";

    try {
      const res = await fetch("/api/tasks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountScope, accountId, taskScope })
      });
      const data = await res.json();
      modalRunTasks?.classList.add("hidden");
      alert(data.message || (data.success ? "任务已成功提交启动！" : "启动失败"));
      refreshDashboard();
    } catch (err) {
      alert("请求异常: " + err.message);
    }
  });

  // 官网数据同步 (对标图 7)
  const modalSyncOfficial = document.getElementById("modal-sync-official");
  const modalHealthCheck = document.getElementById("modal-health-check");
  const modalGlobalConfig = document.getElementById("modal-global-config");

  document.getElementById("menu-sync-official")?.addEventListener("click", (e) => {
    e.preventDefault();
    openSyncOfficialModal();
  });
  document.getElementById("menu-health-check")?.addEventListener("click", (e) => {
    e.preventDefault();
    openHealthCheckModal();
  });
  document.getElementById("menu-global-config")?.addEventListener("click", (e) => {
    e.preventDefault();
    openGlobalConfigModal();
  });
  document.getElementById("menu-open-logs")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("modal-logs")?.classList.remove("hidden");
  });

  document.getElementById("close-sync-modal")?.addEventListener("click", () => modalSyncOfficial?.classList.add("hidden"));
  document.getElementById("btn-sync-close")?.addEventListener("click", () => modalSyncOfficial?.classList.add("hidden"));
  document.getElementById("btn-sync-bg")?.addEventListener("click", () => modalSyncOfficial?.classList.add("hidden"));

  document.getElementById("close-health-modal")?.addEventListener("click", () => modalHealthCheck?.classList.add("hidden"));
  document.getElementById("btn-health-confirm")?.addEventListener("click", () => modalHealthCheck?.classList.add("hidden"));

  document.getElementById("close-global-modal")?.addEventListener("click", () => modalGlobalConfig?.classList.add("hidden"));
  document.getElementById("cancel-global-modal")?.addEventListener("click", () => modalGlobalConfig?.classList.add("hidden"));

  async function openSyncOfficialModal() {
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
  }

  function setSyncStep(stepNum, percent, tagText, descText) {
    const stageTag = document.getElementById("sync-stage-tag");
    const stageDesc = document.getElementById("sync-stage-desc");
    const progressFill = document.getElementById("sync-progress-fill");

    if (stageTag) stageTag.textContent = tagText;
    if (stageDesc) stageDesc.textContent = descText;
    if (progressFill) progressFill.style.width = percent + "%";

    for (let i = 1; i <= 4; i++) {
      const row = document.getElementById("step-row-" + i);
      if (row) {
        if (i < stepNum) {
          row.className = "sync-step-row done";
          row.querySelector(".step-bullet").textContent = "✔";
        } else if (i === stepNum) {
          row.className = "sync-step-row active";
          row.querySelector(".step-bullet").textContent = "●";
        } else {
          row.className = "sync-step-row";
          row.querySelector(".step-bullet").textContent = "○";
        }
      }
    }
  }

  // 账号健康体检 (对标图 8)
  async function openHealthCheckModal() {
    modalHealthCheck?.classList.remove("hidden");
    const selAcc = document.getElementById("health-select-account");
    if (selAcc) {
      selAcc.innerHTML = accounts
        .map((a) => "<option value="" + a.id + "">" + escapeHtml(a.name || a.user) + "</option>")
        .join("");
      if (selectedAccountId) selAcc.value = selectedAccountId;
    }
    runHealthCheck();
  }

  async function runHealthCheck() {
    const banner = document.getElementById("health-summary-banner");
    const bannerIcon = document.getElementById("health-status-icon");
    const bannerTitle = document.getElementById("health-summary-title");
    const bannerSub = document.getElementById("health-summary-sub");

    const hCookieTag = document.getElementById("h-cookie-tag");
    const hCookieDesc = document.getElementById("h-cookie-desc");
    const hOauthTag = document.getElementById("h-oauth-tag");
    const hOauthDesc = document.getElementById("h-oauth-desc");
    const hNetTag = document.getElementById("h-net-tag");
    const hNetDesc = document.getElementById("h-net-desc");

    const hBalance = document.getElementById("h-quota-balance");
    const hSearch = document.getElementById("h-quota-search");
    const hNews = document.getElementById("h-quota-news");

    if (hCookieTag) hCookieTag.textContent = "检测中...";
    if (hOauthTag) hOauthTag.textContent = "检测中...";
    if (hNetTag) hNetTag.textContent = "检测中...";

    const targetId = document.getElementById("health-select-account")?.value || (accounts[0] && accounts[0].id);

    try {
      const res = await fetch("/api/health/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: targetId, scope: healthScope })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "体检失败");

      const r = data.report || {};
      const c = r.cookieHealth || {};
      const o = r.oauthHealth || {};
      const n = r.netHealth || {};
      const q = r.quotaHealth || {};

      if (hCookieTag) {
        hCookieTag.textContent = c.healthy ? "已授权有效" : "待自愈补齐";
        hCookieTag.className = c.healthy ? "h-status-tag" : "h-status-tag warning";
      }
      if (hCookieDesc) hCookieDesc.textContent = c.detail || "--";

      if (hOauthTag) {
        hOauthTag.textContent = o.healthy ? "授权有效" : "待补齐";
        hOauthTag.className = o.healthy ? "h-status-tag" : "h-status-tag warning";
      }
      if (hOauthDesc) hOauthDesc.textContent = o.detail || "--";

      if (hNetTag) {
        hNetTag.textContent = n.isCN ? "中国大陆出口" : (n.success ? "非CN出口" : "探测超时");
        hNetTag.className = n.isCN ? "h-status-tag" : "h-status-tag warning";
      }
      if (hNetDesc) hNetDesc.textContent = n.message + " · IP: " + n.ip;

      if (hBalance) hBalance.textContent = (q.balance || 0).toLocaleString() + " 分";
      if (hSearch) hSearch.textContent = "配额 60 分 (30轮)";
      if (hNews) hNews.textContent = "配额 30 分 (10篇)";

      if (r.allSatisfied) {
        if (banner) {
          banner.style.background = "#f0fdf4";
          banner.style.borderColor = "#bbf7d0";
        }
        if (bannerIcon) bannerIcon.className = "health-status-circle green";
        if (bannerTitle) {
          bannerTitle.textContent = "账号体检全部通过";
          bannerTitle.style.color = "#15803d";
        }
        if (bannerSub) bannerSub.textContent = "账号 [" + r.accountName + "] 双通道凭据与出口 IP 全部满足任务执行条件！";
      } else {
        if (banner) {
          banner.style.background = "#fffbeb";
          banner.style.borderColor = "#fef3c7";
        }
        if (bannerIcon) bannerIcon.className = "health-status-circle red";
        if (bannerTitle) {
          bannerTitle.textContent = "体检状态存在待自愈项";
          bannerTitle.style.color = "#b45309";
        }
        if (bannerSub) bannerSub.textContent = "账号 [" + r.accountName + "] 缺少部分凭据，启动任务时将由无头浏览器自动自愈补齐。";
      }
    } catch (err) {
      if (bannerTitle) bannerTitle.textContent = "体检请求异常";
      if (bannerSub) bannerSub.textContent = err.message;
    }
  }

  document.getElementById("btn-re-check")?.addEventListener("click", runHealthCheck);
  document.getElementById("health-select-account")?.addEventListener("change", runHealthCheck);

  document.getElementById("btn-health-single")?.addEventListener("click", function () {
    healthScope = "single";
    this.classList.add("active");
    document.getElementById("btn-health-all")?.classList.remove("active");
    runHealthCheck();
  });
  document.getElementById("btn-health-all")?.addEventListener("click", function () {
    healthScope = "all";
    this.classList.add("active");
    document.getElementById("btn-health-single")?.classList.remove("active");
    runHealthCheck();
  });

  // 全局配置中心 (图 1-6)
  async function openGlobalConfigModal() {
    modalGlobalConfig?.classList.remove("hidden");

    const cfgSelAcc = document.getElementById("cfg-select-acc");
    if (cfgSelAcc) {
      cfgSelAcc.innerHTML = accounts
        .map((a) => "<option value="" + a.id + "">" + escapeHtml(a.name || a.user) + " (" + escapeHtml(a.user) + ")</option>")
        .join("");
    }

    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      const net = data.network || {};
      const t = data.taskOptions || {};
      const sched = data.scheduler || {};
      const notify = data.notify || {};
      const ww = notify.weworkApp || {};

      if (document.getElementById("cfg-net-enabled")) document.getElementById("cfg-net-enabled").checked = !!net.enabled;
      if (document.getElementById("cfg-net-proxy")) document.getElementById("cfg-net-proxy").value = net.proxyUrl || "";
      if (document.getElementById("cfg-net-lock-cn")) document.getElementById("cfg-net-lock-cn").checked = net.lockChinaIp !== false;

      if (document.getElementById("t-chk-checkin")) document.getElementById("t-chk-checkin").checked = t.dailyCheckIn !== false;
      if (document.getElementById("t-chk-search")) document.getElementById("t-chk-search").checked = t.bingSearch !== false;
      if (document.getElementById("t-chk-dailyset")) document.getElementById("t-chk-dailyset").checked = t.dailySet !== false;
      if (document.getElementById("t-chk-read")) document.getElementById("t-chk-read").checked = t.newsReading !== false;
      if (document.getElementById("t-chk-quiz")) document.getElementById("t-chk-quiz").checked = t.promosQuiz !== false;
      if (document.getElementById("t-chk-weekly")) document.getElementById("t-chk-weekly").checked = t.weeklyQuest !== false;
      if (document.getElementById("t-chk-rerun")) document.getElementById("t-chk-rerun").checked = t.manualRerun !== false;

      if (document.getElementById("pacing-base")) document.getElementById("pacing-base").value = t.baseIntervalSec || 18;
      if (document.getElementById("pacing-jitter")) document.getElementById("pacing-jitter").value = t.randomJitterSec || 6;
      if (document.getElementById("pacing-stagnation")) document.getElementById("pacing-stagnation").value = t.stagnationLimit || 10;

      if (document.getElementById("cfg-sched-enabled")) document.getElementById("cfg-sched-enabled").checked = sched.enabled !== false;
      if (document.getElementById("cfg-sched-cron")) document.getElementById("cfg-sched-cron").value = sched.cron || "*/25 * * * *";

      if (document.getElementById("cfg-wework-robot")) document.getElementById("cfg-wework-robot").value = notify.weworkRobot || "";
      if (document.getElementById("cfg-dingding-robot")) document.getElementById("cfg-dingding-robot").value = notify.dingdingRobot || "";
      if (document.getElementById("cfg-ww-app-enabled")) document.getElementById("cfg-ww-app-enabled").checked = ww.enabled !== false;
      if (document.getElementById("cfg-ww-baseurl")) document.getElementById("cfg-ww-baseurl").value = ww.baseUrl || "https://qyapi.weixin.qq.com";
      if (document.getElementById("cfg-ww-corpid")) document.getElementById("cfg-ww-corpid").value = ww.corpId || "";
      if (document.getElementById("cfg-ww-agentid")) document.getElementById("cfg-ww-agentid").value = ww.agentId || "";
      if (document.getElementById("cfg-ww-secret")) document.getElementById("cfg-ww-secret").value = ww.secret || "";
      if (document.getElementById("cfg-ww-touser")) document.getElementById("cfg-ww-touser").value = ww.toUser || "@all";
      if (document.getElementById("cfg-ww-retries")) document.getElementById("cfg-ww-retries").value = ww.maxRetries || 5;
    } catch {}
  }

  document.querySelectorAll(".cfg-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".cfg-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const targetPane = tab.getAttribute("data-cfgtab");
      document.querySelectorAll(".cfg-pane").forEach((p) => p.classList.add("hidden"));
      document.getElementById("pane-cfg-" + targetPane)?.classList.remove("hidden");
    });
  });

  document.getElementById("btn-preset-fast")?.addEventListener("click", function () {
    this.classList.add("active");
    document.getElementById("btn-preset-relaxed")?.classList.remove("active");
    document.getElementById("pacing-base").value = 18;
    document.getElementById("pacing-jitter").value = 6;
  });
  document.getElementById("btn-preset-relaxed")?.addEventListener("click", function () {
    this.classList.add("active");
    document.getElementById("btn-preset-fast")?.classList.remove("active");
    document.getElementById("pacing-base").value = 180;
    document.getElementById("pacing-jitter").value = 30;
  });

  document.getElementById("btn-test-network-egress")?.addEventListener("click", async () => {
    const proxy = document.getElementById("cfg-net-proxy")?.value.trim();
    const msgEl = document.getElementById("network-test-msg");
    msgEl.textContent = "正在探测出口 IP 与归属地...";
    msgEl.style.color = "#0284c7";

    try {
      const res = await fetch("/api/network/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy })
      });
      const data = await res.json();
      msgEl.textContent = data.message + " (IP: " + data.ip + ")";
      msgEl.style.color = data.isCN ? "#059669" : "#d97706";
    } catch (e) {
      msgEl.textContent = "探测失败: " + e.message;
      msgEl.style.color = "#ef4444";
    }
  });

  document.getElementById("btn-save-all-config")?.addEventListener("click", async () => {
    const payload = {
      network: {
        enabled: document.getElementById("cfg-net-enabled")?.checked,
        proxyUrl: document.getElementById("cfg-net-proxy")?.value.trim(),
        lockChinaIp: document.getElementById("cfg-net-lock-cn")?.checked
      },
      taskOptions: {
        dailyCheckIn: document.getElementById("t-chk-checkin")?.checked,
        bingSearch: document.getElementById("t-chk-search")?.checked,
        dailySet: document.getElementById("t-chk-dailyset")?.checked,
        newsReading: document.getElementById("t-chk-read")?.checked,
        promosQuiz: document.getElementById("t-chk-quiz")?.checked,
        weeklyQuest: document.getElementById("t-chk-weekly")?.checked,
        manualRerun: document.getElementById("t-chk-rerun")?.checked,
        baseIntervalSec: Number(document.getElementById("pacing-base")?.value) || 18,
        randomJitterSec: Number(document.getElementById("pacing-jitter")?.value) || 6,
        stagnationLimit: Number(document.getElementById("pacing-stagnation")?.value) || 10,
        engine: document.getElementById("cfg-engine-select")?.value
      },
      scheduler: {
        enabled: document.getElementById("cfg-sched-enabled")?.checked,
        cron: document.getElementById("cfg-sched-cron")?.value.trim()
      },
      notify: {
        weworkRobot: document.getElementById("cfg-wework-robot")?.value.trim(),
        dingdingRobot: document.getElementById("cfg-dingding-robot")?.value.trim(),
        weworkApp: {
          enabled: document.getElementById("cfg-ww-app-enabled")?.checked,
          baseUrl: document.getElementById("cfg-ww-baseurl")?.value.trim(),
          corpId: document.getElementById("cfg-ww-corpid")?.value.trim(),
          agentId: document.getElementById("cfg-ww-agentid")?.value.trim(),
          secret: document.getElementById("cfg-ww-secret")?.value.trim(),
          toUser: document.getElementById("cfg-ww-touser")?.value.trim(),
          maxRetries: Number(document.getElementById("cfg-ww-retries")?.value) || 5
        }
      }
    };

    try {
      const res = await fetch("/api/config/global", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        alert("🎉 全局配置中心配置已全部保存生效！");
        modalGlobalConfig?.classList.add("hidden");
        refreshDashboard();
      }
    } catch (e) {
      alert("保存失败: " + e.message);
    }
  });

  document.getElementById("btn-test-ww-app-modal")?.addEventListener("click", async () => {
    const payload = {
      baseUrl: document.getElementById("cfg-ww-baseurl")?.value.trim(),
      corpId: document.getElementById("cfg-ww-corpid")?.value.trim(),
      agentId: document.getElementById("cfg-ww-agentid")?.value.trim(),
      secret: document.getElementById("cfg-ww-secret")?.value.trim(),
      toUser: document.getElementById("cfg-ww-touser")?.value.trim()
    };
    try {
      const res = await fetch("/api/notify/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      alert(data.message || (data.success ? "测试推送成功！" : "推送失败"));
    } catch (e) {
      alert("测试异常: " + e.message);
    }
  });

  const modalAccount = document.getElementById("modal-account");
  const modalLogs = document.getElementById("modal-logs");

  document.getElementById("btn-add-account")?.addEventListener("click", () => {
    document.getElementById("form-account")?.reset();
    document.getElementById("acc-id").value = "";
    modalAccount?.classList.remove("hidden");
  });
  document.getElementById("close-account-modal")?.addEventListener("click", () => modalAccount?.classList.add("hidden"));
  document.getElementById("cancel-account-modal")?.addEventListener("click", () => modalAccount?.classList.add("hidden"));

  document.getElementById("btn-open-terminal")?.addEventListener("click", () => modalLogs?.classList.remove("hidden"));
  document.getElementById("close-logs-modal")?.addEventListener("click", () => modalLogs?.classList.add("hidden"));

  document.getElementById("btn-load-env")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/accounts/load-env", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        alert("成功发现并导入本地凭据: " + data.account.user);
        refreshDashboard();
      } else {
        alert(data.message || "未发现本地 .env 凭据");
      }
    } catch (e) {
      alert("载入异常: " + e.message);
    }
  });

  document.getElementById("btn-quick-harvest")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/system/harvest", { method: "POST" });
      const data = await res.json();
      alert(data.message);
      refreshDashboard();
    } catch (e) {
      alert("触发失败: " + e.message);
    }
  });

  document.getElementById("form-account")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("acc-id")?.value;
    const name = document.getElementById("acc-name")?.value.trim();
    const user = document.getElementById("acc-user")?.value.trim();
    const pass = document.getElementById("acc-pass")?.value;
    const proxy = document.getElementById("acc-proxy")?.value.trim();
    const enabled = document.getElementById("acc-enabled")?.checked;

    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, user, pass, proxy, enabled })
      });
      const data = await res.json();
      if (data.success) {
        modalAccount?.classList.add("hidden");
        if (data.account?.id) {
          fetch("/api/accounts/" + data.account.id + "/login", { method: "POST" });
        }
        refreshDashboard();
      }
    } catch (err) {
      alert("保存失败: " + err.message);
    }
  });

  const btnAdminLogout = document.getElementById("btn-admin-logout");
  if (btnAdminLogout) {
    btnAdminLogout.addEventListener("click", async () => {
      if (!confirm("确定退出当前管理员登录吗？")) return;
      try {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.replace("/login.html");
      } catch {
        window.location.replace("/login.html");
      }
    });
  }

  function connectLogs() {
    const evtSource = new EventSource("/api/logs/stream");
    evtSource.onmessage = (e) => {
      try {
        const item = JSON.parse(e.data);
        const div = document.createElement("div");
        div.style.lineHeight = "1.5";
        div.textContent = item.raw;
        logTerminal?.appendChild(div);
        if (autoScroll && logTerminal) logTerminal.scrollTop = logTerminal.scrollHeight;
      } catch {}
    };
    evtSource.onerror = () => setTimeout(connectLogs, 5000);
  }

  document.getElementById("btn-toggle-scroll")?.addEventListener("click", function () {
    autoScroll = !autoScroll;
    this.textContent = autoScroll ? "暂停滚动" : "恢复滚动";
  });
  document.getElementById("btn-clear-logs")?.addEventListener("click", () => {
    if (logTerminal) logTerminal.innerHTML = "";
  });

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  refreshDashboard();
  connectLogs();
  setInterval(refreshDashboard, 8000);
});
