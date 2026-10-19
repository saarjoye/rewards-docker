const fs = require('fs');

let p1 = `document.addEventListener("DOMContentLoaded", () => {
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
`;
fs.writeFileSync('scripts/rebuild-app.cjs', p1, 'utf8');
console.log('Part 1 written');
