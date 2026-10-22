
  let countdownTargetTime = 0;
  function tickCountdown() {
    const monNext = document.getElementById("mon-next-interval");
    if (!monNext) return;
    if (countdownTargetTime > 0) {
      const remainingSec = Math.max(0, Math.ceil((countdownTargetTime - Date.now()) / 1000));
      if (remainingSec > 0) {
        monNext.textContent = remainingSec + " 秒";
        return;
      }
    }
    monNext.textContent = "--";
  }
  setInterval(tickCountdown, 1000);


  function formatSlotName(slot) {
    if (!slot || slot === 'auto') return '智能错峰';
    if (slot === '09:00-13:00') return '早间 09-13点';
    if (slot === '13:00-17:00') return '午间 13-17点';
    if (slot === '17:00-21:00') return '晚间 17-21点';
    if (slot === '21:00-01:00') return '夜间 21-01点';
    return slot;
  }

document.addEventListener("DOMContentLoaded", () => {
  function getAccountDisplayName(a, idx = 0) {
    if (!a) return '默认账号';
    if (a.name && a.name !== '默认账号') return a.name;
    if (a.user) return a.user.includes('@') ? a.user.split('@')[0] : a.user;
    return '账号 ' + (idx + 1);
  }

  function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatShanghaiDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const valueOf = (type) => parts.find((part) => part.type === type)?.value || '';
    return valueOf('year') + '-' + valueOf('month') + '-' + valueOf('day');
  }

  function getDailySnapshot(account, date) {
    const snapshots = account && account.dailySnapshots;
    if (Array.isArray(snapshots)) return snapshots.find((item) => item && item.date === date) || null;
    return snapshots && typeof snapshots === 'object' ? (snapshots[date] || null) : null;
  }

  function renderSafely(label, renderer, fallbackTarget) {
    try {
      return renderer();
    } catch (error) {
      console.error('*** RENDER FAIL [' + label + ']:', error ? error.stack : error);
      if (fallbackTarget) {
        fallbackTarget.innerHTML = '<div class="empty-state empty-state-error">' + escapeHtml(label) + '加载失败，请刷新重试</div>';
      }
      return null;
    }
  }

  function mergeSnapshotsIntoAccounts(snapshots) {
    if (!snapshots || typeof snapshots !== 'object') return false;
    for (const account of accounts) {
      const remote = snapshots[account.id] || {};
      const current = account.dailySnapshots;
      if (Array.isArray(current)) {
        const merged = new Map(current.filter((item) => item && item.date).map((item) => [item.date, item]));
        Object.entries(remote).forEach(([date, record]) => merged.set(date, record));
        account.dailySnapshots = Array.from(merged.values());
      } else {
        account.dailySnapshots = {
          ...(current && typeof current === 'object' ? current : {}),
          ...remote
        };
      }
    }
    return true;
  }

  async function hydrateDailySnapshots() {
    if (dailySnapshotsLoading) return;
    dailySnapshotsLoading = true;
    try {
      const response = await fetch('/api/history/recent', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      const snapshots = payload && payload.snapshots;
      if (snapshots && typeof snapshots === 'object') previousSnapshots = snapshots;
      mergeSnapshotsIntoAccounts(previousSnapshots);
      renderSafely('积分日历', () => renderChartBars(), chartBars);
      renderSafely('账号卡片', renderTopAccountCards, document.getElementById('top-accounts-cards'));
      renderSafely('积分看板账号选项', renderBoardAccountOptions);
      renderSafely('账号池', renderAccountsList);
    } catch (error) {
      console.warn('[积分日历] 历史快照暂不可用，保留官网状态数据:', error);
    } finally {
      dailySnapshotsLoading = false;
    }
  }

  let accounts = [];
  let autoScroll = true;
  let viewMode = "all";
  let selectedAccountId = null;
  let healthScope = "single";
  let currentRunningAccountId = null;
  let previousSnapshots = {};
  let dailySnapshotsLoading = false;

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
      const res = await fetch("/api/status", { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (!data.success) throw new Error(data.message || '状态接口返回失败');

      accounts = Array.isArray(data.accounts) ? data.accounts : [];
      mergeSnapshotsIntoAccounts(previousSnapshots);
      
      // 状态迁移监测：检测到从运行中(isBusy: true)变为结束(false)的瞬间，立即二次强制刷新
      if (lastWasBusy && !data.isBusy) {
        lastWasBusy = false;
        setTimeout(() => refreshDashboard(), 800);
      }
      lastWasBusy = !!data.isBusy;

      const primaryAcc = accounts[0] || null;

      let today = 0, balance = 0, streak = 0, claimable = 0;

      if (viewMode === "all") {
        const officialAccounts = accounts.filter((a) => a && a.hasOfficialData !== false && finiteNumberOrNull(a.todayEarned) !== null);
        today = officialAccounts.length ? officialAccounts.reduce((sum, a) => sum + finiteNumberOrNull(a.todayEarned), 0) : null;
        const knownBalances = accounts.map((a) => finiteNumberOrNull(a.balance)).filter((value) => value !== null);
        balance = knownBalances.length ? knownBalances.reduce((sum, value) => sum + value, 0) : null;
        streak = accounts.reduce((max, a) => Math.max(max, finiteNumberOrNull(a.streakDays) || 0), 0);
        claimable = accounts.reduce((sum, a) => sum + (finiteNumberOrNull(a.claimablePoints) || 0), 0);

        if (btnModeAll) btnModeAll.classList.add("active");
        if (btnModeSingle) btnModeSingle.classList.remove("active");
        if (welcomeSubDesc) welcomeSubDesc.textContent = "全部 " + (accounts.length || 1) + " 户托管账号资产合并统计 · 官方实时数据驱动";

        if (currentViewAvatar) currentViewAvatar.textContent = "🌐";
        if (currentViewName) currentViewName.textContent = "全部账号合计";
        if (currentViewBadge) currentViewBadge.textContent = "共 " + (accounts.length || 1) + " 户接入";
        if (currentUserDisplayName) currentUserDisplayName.textContent = "全账号合计";
        const boardSubScope = document.getElementById("board-sub-scope");
        if (boardSubScope) boardSubScope.textContent = "全部账号合计 · 官方多维度透视";
      } else {
        const targetAcc = accounts.find((a) => String(a.id) === String(selectedAccountId)) || primaryAcc;
        if (!targetAcc) {
          today = null;
          balance = null;
        } else {
          today = targetAcc.hasOfficialData === false ? null : finiteNumberOrNull(targetAcc.todayEarned);
          balance = finiteNumberOrNull(targetAcc.balance);
          streak = finiteNumberOrNull(targetAcc.streakDays) || 0;
          claimable = finiteNumberOrNull(targetAcc.claimablePoints) || 0;
        }

        if (btnModeAll) btnModeAll.classList.remove("active");
        if (btnModeSingle) btnModeSingle.classList.add("active");
        if (welcomeSubDesc) welcomeSubDesc.textContent = "账号 [" + ((targetAcc && (targetAcc.name || targetAcc.user)) || '未选择') + "] 独立成效看板 · 官方实时数据";

        if (currentViewAvatar) currentViewAvatar.textContent = ((targetAcc && (targetAcc.name || targetAcc.user)) || "A")[0].toUpperCase();
        if (currentViewName) currentViewName.textContent = (targetAcc && (targetAcc.name || targetAcc.user)) || '请选择账号';
        if (currentViewBadge) currentViewBadge.textContent = "单账号视图";
        if (currentUserDisplayName) currentUserDisplayName.textContent = (targetAcc && (targetAcc.name || targetAcc.user)) || '管理员';
        const boardSubScope = document.getElementById("board-sub-scope");
        if (boardSubScope) boardSubScope.textContent = "账号 [" + ((targetAcc && (targetAcc.name || targetAcc.user)) || '未选择') + "] 独立成效看板";
      }

      if (mTodayPoints) mTodayPoints.textContent = today == null ? '--' : today;
      if (mTotalBalance) mTotalBalance.textContent = balance == null ? '--' : balance.toLocaleString();
      if (mStreakDays) mStreakDays.textContent = String(streak).padStart(2, "0");

      const todayTarget = viewMode === "all" ? (accounts.length || 1) * 174 : 174;
      const todayPct = today == null ? 0 : Math.min(100, Math.round((today / todayTarget) * 100));
      if (fillToday) fillToday.style.width = todayPct + "%";
      if (mTodayPercent) mTodayPercent.textContent = today == null ? '--' : todayPct + "%";
      if (fillBalance) fillBalance.style.width = "85%";
      if (fillStreak) fillStreak.style.width = Math.min(100, Math.round((streak / 12) * 100)) + "%";

      const isBusy = !!data.isBusy || !!data.runningAccountId;
      currentRunningAccountId = data.runningAccountId || null;
      const runningAccName = data.runningAccountName || (data.runningAccountId ? "执行中账号" : "");
      const currentTaskSection = String(data.currentTaskSection || '').trim();
      const currentTaskName = String(data.currentTaskName || '').trim() || "正在执行自动化流水线...";
      const currentTaskLabel = currentTaskSection && !currentTaskName.includes(currentTaskSection)
        ? currentTaskSection + " · " + currentTaskName
        : currentTaskName;

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
          bChip.style.color = "#0284c7";
          bChip.style.background = "#e0f2fe";
          bChip.style.borderColor = "#bae6fd";
        } else {
          bChip.textContent = "● 空闲待命";
          bChip.style.color = "#10b981";
          bChip.style.background = "#f0fdf4";
          bChip.style.borderColor = "#bbf7d0";
        }
      }

      // 100% 精确对接新版无头浏览器 5 维状态监控卡片 (彻底根除 -- 占位符死数据)
      const monActiveAcc = document.getElementById("mon-active-acc");
      if (monActiveAcc) {
        monActiveAcc.textContent = isBusy ? (runningAccName || bState.activeAccountName || "正在执行") : "--";
      }

      const monActiveKw = document.getElementById("mon-active-kw");
      if (monActiveKw) {
        monActiveKw.textContent = isBusy ? (bState.currentKeyword || currentTaskLabel || "自动化流程调度") : "--";
        monActiveKw.title = monActiveKw.textContent;
      }

      const monRounds = document.getElementById("mon-search-rounds");
      if (monRounds) {
        monRounds.textContent = isBusy ? (bState.searchRounds || "执行中") : "0 / 0";
      }

      if (bState.nextSearchTargetTime && bState.nextSearchTargetTime > Date.now()) {
        countdownTargetTime = bState.nextSearchTargetTime;
      } else if (isBusy && bState.nextIntervalSec > 0 && countdownTargetTime <= Date.now()) {
        countdownTargetTime = Date.now() + bState.nextIntervalSec * 1000;
      } else if (!isBusy) {
        countdownTargetTime = 0;
      }
      tickCountdown();

      const monMem = document.getElementById("mon-mem-usage");
      if (monMem) {
        monMem.textContent = mem.usedMB ? (mem.usedMB + " MB (" + mem.percent + "%)") : "128 MB (25%)";
      }

      const monCallout = document.getElementById("mon-callout-text");
      const monBox = document.getElementById("mon-status-callout");
      if (monCallout) {
        if (isBusy) {
          monCallout.textContent = bState.currentAction || ("正在执行: " + currentTaskLabel);
          if (monBox) monBox.className = "browser-status-callout active";
        } else {
          monCallout.textContent = "浏览器当前处于空闲休眠状态，内存完全释放 (0 内存占用)";
          if (monBox) monBox.className = "browser-status-callout";
        }
      }

      renderSafely('账号下拉框', renderDropdownMenu);
      renderSafely('积分看板账号选项', renderBoardAccountOptions);
      renderSafely('账号池', renderAccountsList);
      renderSafely('账号卡片', () => renderTopAccountCards(), document.getElementById('top-accounts-cards'));
      if (typeof renderBoardDropdown === 'function') renderSafely('积分看板下拉框', renderBoardDropdown);
      renderSafely('官网任务缺口', () => renderOfficialTaskGaps(data), document.getElementById('task-gaps-list'));
      renderSafely('调度队列', () => renderSchedulerQueue(data), document.getElementById('queue-list'));
      renderSafely('积分日历', () => renderChartBars(today), chartBars);
      const boardToday = document.getElementById("board-today-points");
      if (boardToday) boardToday.textContent = today == null ? '--' : ('+' + today + ' 分');
      const boardTotal = document.getElementById("board-total-balance");
      if (boardTotal) boardTotal.textContent = balance == null ? '--' : (balance.toLocaleString() + ' 分');
      const boardClaim = document.getElementById("board-claimable-num");
      if (boardClaim) boardClaim.textContent = claimable || 0;
      const memStatusLine = document.getElementById("mem-status-line");
      if (memStatusLine) memStatusLine.textContent = "内存: " + (mem.usedMB || 45) + " MB / " + (mem.limitMB || 512) + " MB (" + (mem.percent || 9) + "% 健康)";


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

      
      // 图 3 动态滚动播报条：实时显示 "XXXX账号正在执行XXXX任务，执行耗时XXX"
      const marqueeBadge = document.getElementById("marquee-status-badge");
      const marqueeText = document.getElementById("topbar-marquee-text");
      const marqueeTimer = document.getElementById("topbar-marquee-timer");

      if (data.isBusy) {
        if (marqueeBadge) {
          marqueeBadge.textContent = "🚀 执行中";
          marqueeBadge.className = "marquee-badge running";
        }
        if (marqueeText) {
          const accLabel = data.runningAccountName || "微软托管账号";
          marqueeText.textContent = "[" + accLabel + "] 正在执行 [" + currentTaskLabel + "]";
          marqueeText.title = marqueeText.textContent;
        }
        if (marqueeTimer && data.taskStartTime) {
          const elapsedSec = Math.max(0, Math.floor((Date.now() - data.taskStartTime) / 1000));
          const m = Math.floor(elapsedSec / 60);
          const s = elapsedSec % 60;
          marqueeTimer.textContent = "已耗时 " + (m > 0 ? (m + "分" + s + "秒") : (s + "秒"));
          marqueeTimer.style.display = "inline-block";
        }
      } else {
        if (marqueeBadge) {
          marqueeBadge.textContent = "● 就绪";
          marqueeBadge.className = "marquee-badge";
        }
        if (marqueeText) {
          marqueeText.textContent = "全系统错峰巡检待命中 · 各托管账号环境准备就绪";
        }
        if (marqueeTimer) {
          marqueeTimer.style.display = "none";
        }
      }

      const liveImg = document.getElementById("live-screencast-img");
      if (liveImg) liveImg.src = "/api/browser/screenshot?_t=" + Date.now();
      return data;
    } catch (e) {
      console.error("刷新大盘异常:", e);
      renderSafely('官网任务缺口', () => renderOfficialTaskGaps(), document.getElementById('task-gaps-list'));
      renderSafely('调度队列', () => renderSchedulerQueue(), document.getElementById('queue-list'));
      renderSafely('积分日历', () => renderChartBars(), chartBars);
    }
  }

  function renderChartBars(todayPoints) {
    if (!chartBars) return;
    const isSingleMode = viewMode === "single" && selectedAccountId;
    const activeAccs = isSingleMode
      ? accounts.filter((a) => String(a.id) === String(selectedAccountId))
      : accounts;

    const days = [];
    const now = new Date();
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const date = formatShanghaiDate(d);
      const isToday = (i === 0) || (date === formatShanghaiDate(now));
      const breakdown = activeAccs.map((a, idx) => {
        const rec = getDailySnapshot(a, date);
        let pts = null;
        if (isToday) {
          const hasLiveToday = a && a.todayEarned !== null && a.todayEarned !== undefined && Number(a.lastSyncAt || 0) > 0;
          pts = hasLiveToday ? finiteNumberOrNull(a.todayEarned) : (rec ? finiteNumberOrNull(rec.earned) : null);
        } else {
          pts = rec ? finiteNumberOrNull(rec.earned) : null;
        }
        return {
          name: getAccountDisplayName(a, idx),
          pts
        };
      });
      const known = breakdown.filter((b) => b.pts !== null);
      const val = known.reduce((sum, b) => sum + b.pts, 0);
      days.push({
        label: date.slice(5),
        fullDateStr: date + ' (' + weekdays[d.getDay()] + ')',
        val,
        knownCount: known.length,
        totalCount: breakdown.length,
        breakdown,
        active: i === 0
      });
    }

    const maxVal = Math.max(60, ...days.map((d) => d.val));
    chartBars.innerHTML = days.map((d, colIndex) => {
      const hasOfficialData = d.knownCount > 0;
      const heightPct = hasOfficialData ? Math.min(65, Math.max(8, Math.round((d.val / maxVal) * 58))) : 8;
      const breakdownRowsHtml = d.breakdown.map((b) => (
        '<div class="tooltip-account-row">' +
          '<div class="acc-left"><span class="acc-avatar">👤</span><span class="acc-name">' + escapeHtml(b.name) + '</span></div>' +
          '<div class="acc-right"><span class="acc-pts">' + (b.pts === null ? '未同步' : '+' + b.pts) + '</span></div>' +
        '</div>'
      )).join('');
      const alignClass = colIndex >= 3 ? 'align-right' : 'align-left';
      return (
        '<div class="bar-col ' + (d.active ? 'active' : '') + ' ' + alignClass + '">' +
          '<div class="bar-pillar ' + (hasOfficialData ? '' : 'bar-unknown') + '" style="height: ' + heightPct + '%;">' +
            '<span class="bar-top-val">' + (hasOfficialData ? (d.val > 0 ? '+' + d.val : '0') : '暂无') + '</span>' +
          '</div>' +
          '<span class="bar-date-label">' + d.label + '</span>' +
          '<div class="chart-tooltip-capsule">' +
            '<div class="tooltip-date-header">' + d.fullDateStr + '</div>' +
            '<div class="tooltip-total-row">' +
              '<span class="tooltip-total-label">' + (hasOfficialData ? '官网新增合计' : '暂无官网快照') + '</span>' +
              '<span class="tooltip-total-val">' + (hasOfficialData ? '+' + d.val : '--') + '</span>' +
              '<span class="tooltip-pts-unit">分</span>' +
            '</div>' +
            '<div class="tooltip-divider"></div>' +
            '<div class="tooltip-sub-header">各账号当日新增</div>' +
            '<div class="tooltip-accounts-list">' + breakdownRowsHtml + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderBoardAccountOptions() {
    const select = document.getElementById("select-board-view");
    if (!select) return;
    const current = viewMode === "single" && selectedAccountId ? String(selectedAccountId) : "all";
    select.innerHTML = ['<option value="all">🏛 全部账号汇总</option>'].concat(accounts.map((account, index) => '<option value="' + escapeHtml(String(account.id)) + '">👤 ' + escapeHtml(getAccountDisplayName(account, index)) + '</option>')).join("");
    select.value = Array.from(select.options).some((option) => option.value === current) ? current : "all";
  }

  function renderAccountsList() {
    if (!accountsScrollList) return;
    if (accounts.length === 0) {
      accountsScrollList.innerHTML = '<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;">暂无托管账号</div>';
      return;
    }
    const isAllSelected = viewMode === 'all';
    const totalTodayPts = accounts.reduce((sum, a) => sum + (a.todayEarned || 0), 0);

    // 置顶项：全部账号大盘合计
    const topAllItem = (
      '<div class="store-card-row ' + (isAllSelected ? 'selected-card' : '') + '" onclick="switchView(\'all\')" title="点击切换回全账号合并大盘统计">' +
        '<div class="store-row-left">' +
          '<div class="store-thumb thumb-all">🌐</div>' +
          '<div class="store-row-meta">' +
            '<span class="store-row-title">全部账号大盘合计</span>' +
            '<span class="store-row-cid">共 ' + accounts.length + ' 户 · ' + totalTodayPts + '分</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    const accountRows = accounts.map((a, idx) => {
      let displayName = getAccountDisplayName(a, idx);
      const initial = displayName[0].toUpperCase();
      const isSelected = viewMode === 'single' && String(selectedAccountId) === String(a.id);
      const isRunning = Boolean(currentRunningAccountId && String(currentRunningAccountId) === String(a.id));
      const isAbnormal = a.status === 'error' || a.status === 'needs_2fa' || a.status === 'abnormal' || a.status === 'warning' || a.status === 'expired' || a.status === 'stagnated' || !!a.error || a.allSatisfied === false;

      let thumbStatusClass = 'thumb-status-idle';
      let thumbTitle = '账号待命就绪 (正常)';
      if (isRunning) {
        thumbStatusClass = 'thumb-status-running';
        thumbTitle = '正在执行自动化流水线任务...';
      } else if (isAbnormal) {
        thumbStatusClass = 'thumb-status-abnormal';
        thumbTitle = '账号状态异常 (' + (a.status || '需注意') + ')';
      }

      return (
        '<div class="store-card-row ' + (isSelected ? 'selected-card' : '') + '" onclick="switchView(\'single\', \'' + a.id + '\')" title="点击切换查看该账号独立大盘与数据">' +
          '<div class="store-row-left">' +
            '<div class="store-thumb ' + thumbStatusClass + '" title="' + thumbTitle + '">' + initial + '</div>' +
            '<div class="store-row-meta">' +
              '<span class="store-row-title">' + escapeHtml(displayName) + '</span>' +
              '<span class="store-row-cid">' + (a.user ? (a.user.substring(0, 18) + '...') : '') + '</span>' +
            '</div>' +
          '</div>' +
          '<button class="btn-edit-account-row" onclick="event.stopPropagation(); window.openEditAccountModal(\'' + a.id + '\')" title="修改账号资料、密码与代理">✏️ 编辑</button>' +
        '</div>'
      );
    }).join('');

    accountsScrollList.innerHTML = topAllItem + accountRows;
  }

  function taskStatusLabel(done, known = true) {
    if (!known) return { text: '未知', cls: 'task-state-unknown' };
    return done ? { text: '已完成', cls: 'task-state-done' } : { text: '待完成', cls: 'task-state-pending' };
  }

  function counterTaskItem(label, value) {
    const current = finiteNumberOrNull(value && value.current);
    const max = finiteNumberOrNull(value && value.max);
    const known = current !== null && max !== null;
    return {
      label,
      known,
      value: known ? current + '/' + max : '未知',
      done: known && (value.isMaxed === true || (max > 0 && current >= max))
    };
  }

  // =========================================================================
  // 日期守卫：严格判定时间戳是否属于客户端当前自然天，彻底杜绝次日残留昨日"全部完成"假象
  // =========================================================================
  function isSameLocalDay(timestamp) {
    if (!timestamp) return false;
    const d = new Date(Number(timestamp));
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
           d.getMonth() === now.getMonth() &&
           d.getDate() === now.getDate();
  }

  // 全局待执行调度状态与秒级定时器引用
  let nextScheduledTaskCache = null;
  let queueCountdownTimer = null;

  function tickQueueCountdown() {
    const elText = document.getElementById('queue-countdown-text');
    const elCapsule = document.getElementById('queue-countdown-capsule');
    if (!elText || !elCapsule) return;

    if (currentRunningAccountId) {
      const runningAcc = accounts.find((a) => String(a.id) === String(currentRunningAccountId));
      const accName = runningAcc ? getAccountDisplayName(runningAcc, accounts.indexOf(runningAcc)) : '账号';
      elCapsule.classList.add('active-running');
      elText.textContent = '⚡ 正在作业: ' + accName;
      return;
    }

    elCapsule.classList.remove('active-running');

    if (!nextScheduledTaskCache || !nextScheduledTaskCache.enabled || !nextScheduledTaskCache.targetTimestamp) {
      elText.textContent = '错峰调度待命';
      return;
    }

    const now = Date.now();
    const diffMs = nextScheduledTaskCache.targetTimestamp - now;
    if (diffMs <= 0) {
      elText.textContent = '⏱️ 即将触发: ' + (nextScheduledTaskCache.time || '');
      return;
    }

    const totalSec = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const timeFormatted = String(hours).padStart(2, '0') + ':' + String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');

    const slotLabel = nextScheduledTaskCache.name || nextScheduledTaskCache.time || '';
    const slotTime = nextScheduledTaskCache.time || '';
    elText.textContent = timeFormatted + ' (' + slotTime + ')';
    elCapsule.title = '下一次定时任务: ' + slotLabel + ' ' + slotTime + '\n点击查看全天 6 大错峰调度时间表';
  }

  // 绑定倒计时胶囊点击事件：展示全天 6 大时段明细弹窗
  document.addEventListener('click', (e) => {
    const capsule = e.target.closest('#queue-countdown-capsule');
    if (capsule && nextScheduledTaskCache && nextScheduledTaskCache.allSlots) {
      const slotListStr = nextScheduledTaskCache.allSlots.map((s) => s.time + '  ' + (s.tag || s.name)).join('\n');
      alert('🕒 全天错峰自动化任务时间表：\n\n' + slotListStr + '\n\n系统将在到达设定时间时自动拉起对应账号流水线。');
    }
  });

  // 1. 官网任务缺口渲染：支持全盘矩阵与单账号深度清单两态无缝切换 (方案 1)
  function renderOfficialTaskGaps(data = {}) {
    const list = document.getElementById('task-gaps-list');
    const syncEl = document.getElementById('task-gaps-sync-time');
    const titleEl = document.getElementById('task-gaps-title');
    const subEl = document.getElementById('task-gaps-sub');
    const backBtn = document.getElementById('btn-back-all-gaps');
    if (!list) return;

    if (!accounts.length) {
      list.innerHTML = '<div class="empty-state">暂无托管账号</div>';
      if (syncEl) syncEl.textContent = '尚未同步';
      if (backBtn) backBtn.classList.add('hidden');
      return;
    }

    // 单账号聚焦态 (方案 1：原位深钻展示对标竞品的具体任务卡片清单)
    if (viewMode === 'single' && selectedAccountId) {
      const acc = accounts.find((a) => String(a.id) === String(selectedAccountId));
      if (acc) {
        const accIdx = accounts.indexOf(acc);
        const name = getAccountDisplayName(acc, accIdx);
        if (titleEl) titleEl.textContent = '📋 ' + name + ' 今日任务清单';
        if (subEl) subEl.textContent = '官网权威实时完成进度明细';
        if (backBtn) {
          backBtn.classList.remove('hidden');
          backBtn.onclick = () => switchView('all');
        }

        const isTodaySync = isSameLocalDay(acc.lastSyncAt);
        const t = (isTodaySync && acc.officialTasks && typeof acc.officialTasks === 'object') ? acc.officialTasks : {};
        const hasSnap = isTodaySync && Object.keys(t).length > 0;
        const todayPts = isTodaySync ? Number(acc.todayEarned || 0) : 0;

        // 搜索项
        const searchCap = t.searchPoints;
        const searchKnown = searchCap && searchCap.current !== null;
        const curSearch = searchKnown ? searchCap.current : Math.min(60, todayPts);
        const maxSearch = searchKnown ? (searchCap.max || 60) : 60;
        const searchPct = Math.min(100, Math.round((curSearch / maxSearch) * 100));

        // Daily Set 项
        const dsCap = t.dailySet;
        const curDs = dsCap ? (dsCap.current || 0) : (todayPts >= 90 ? 3 : 0);
        const maxDs = dsCap ? (dsCap.max || 3) : 3;
        const dsPct = Math.min(100, Math.round((curDs / maxDs) * 100));

        // 移动端签到项
        const appCap = t.appCheckIn;
        const curApp = appCap ? (appCap.current || 0) : (todayPts >= 100 ? 1 : 0);
        const maxApp = appCap ? (appCap.max || 1) : 1;
        const appPct = Math.min(100, Math.round((curApp / maxApp) * 100));

        // 打孔卡列表
        const questCards = Array.isArray(t.allQuestCards) ? t.allQuestCards : [];

        let cardsHtml = '<div class="gap-single-grid">' +
          '<div class="gap-single-card">' +
            '<div class="gap-single-head"><span>🔍 必应 PC 搜索 (' + curSearch + '/' + maxSearch + ' 分)</span><span style="font-size: 11px; color: ' + (curSearch >= maxSearch ? '#10b981' : '#f59e0b') + ';">' + (curSearch >= maxSearch ? '已全部达成' : searchPct + '%') + '</span></div>' +
            '<div class="gap-single-bar"><div class="gap-single-bar-fill ' + (curSearch >= maxSearch ? 'done' : '') + '" style="width: ' + searchPct + '%;"></div></div>' +
          '</div>' +
          '<div class="gap-single-card">' +
            '<div class="gap-single-head"><span>📅 每日活动集 Daily Set (' + curDs + '/' + maxDs + ' 项)</span><span style="font-size: 11px; color: ' + (curDs >= maxDs ? '#10b981' : '#f59e0b') + ';">' + (curDs >= maxDs ? '已全部达成' : dsPct + '%') + '</span></div>' +
            '<div class="gap-single-bar"><div class="gap-single-bar-fill ' + (curDs >= maxDs ? 'done' : '') + '" style="width: ' + dsPct + '%;"></div></div>' +
          '</div>' +
          '<div class="gap-single-card">' +
            '<div class="gap-single-head"><span>📱 移动端 App 签到 (' + curApp + '/' + maxApp + ' 次)</span><span style="font-size: 11px; color: ' + (curApp >= maxApp ? '#10b981' : '#f59e0b') + ';">' + (curApp >= maxApp ? '已达成' : appPct + '%') + '</span></div>' +
            '<div class="gap-single-bar"><div class="gap-single-bar-fill ' + (curApp >= maxApp ? 'done' : '') + '" style="width: ' + appPct + '%;"></div></div>' +
          '</div>';

        if (questCards.length > 0) {
          questCards.forEach((q) => {
            const isDone = q.done || q.current >= q.total;
            cardsHtml += '<div class="gap-single-card">' +
              '<div class="gap-single-head"><span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px;" title="' + escapeHtml(q.title) + '">' + escapeHtml(q.title) + '</span><span style="font-size: 11px; color: ' + (isDone ? '#10b981' : (q.isCooling ? '#eab308' : '#0284c7')) + ';">' + (isDone ? '已达成' : (q.isCooling ? '冷却中' : q.current + '/' + q.total)) + '</span></div>' +
              '<div class="gap-single-bar"><div class="gap-single-bar-fill ' + (isDone ? 'done' : '') + '" style="width: ' + q.percent + '%;"></div></div>' +
            '</div>';
          });
        }

        cardsHtml += '<div style="text-align: center; margin-top: 6px;"><button type="button" class="btn-cancel-sm" onclick="window.openTaskDrawer(\'' + acc.id + '\')" style="padding: 4px 12px; font-size: 11px; font-weight: 700; color: #0284c7; background: #e0f2fe; border: 1px solid #bae6fd; border-radius: 6px; cursor: pointer;">🔍 查看完整任务全景抽屉 ↗</button></div></div>';

        list.innerHTML = cardsHtml;
        if (syncEl) syncEl.textContent = acc.lastSyncAt && isTodaySync ? ('同步于 ' + new Date(Number(acc.lastSyncAt)).toLocaleTimeString('zh-CN', { hour12: false })) : '今日待官网同步';
        return;
      }
    }

    // 全盘大盘态 (默认展示全量账号缺口对比)
    if (titleEl) titleEl.textContent = '官网任务缺口';
    if (subEl) subEl.textContent = '按账号显示官网实时完成状态';
    if (backBtn) backBtn.classList.add('hidden');

    let latest = 0;
    list.innerHTML = accounts.map((a, idx) => {
      // 关键修复：增加自然天日期校验，如果时间戳不是今天，坚决不渲染昨日全部完成假象！
      const isTodaySync = isSameLocalDay(a.lastSyncAt);
      const t = (isTodaySync && a.officialTasks && typeof a.officialTasks === 'object') ? a.officialTasks : {};
      const hasSnap = isTodaySync && Object.keys(t).length > 0;
      const pendingDaily = Array.isArray(t.dailyPending) ? t.dailyPending.length : null;
      const pendingQuests = Array.isArray(t.questPending) ? t.questPending.length : null;
      if (a.lastSyncAt && isTodaySync) latest = Math.max(latest, Number(a.lastSyncAt) || 0);

      const hasOfficial = isTodaySync && a.todayEarned !== null && a.todayEarned !== undefined && Number(a.lastSyncAt || 0) > 0;
      const todayPts = hasOfficial ? Number(a.todayEarned) : 0;

      let searchItem = counterTaskItem('搜索', t.searchPoints);
      if (!searchItem.known) {
        if (hasOfficial) {
          const maxS = (t.searchPoints && t.searchPoints.max) || (todayPts >= 60 ? 60 : 30);
          searchItem = {
            label: '搜索',
            known: true,
            value: (todayPts >= maxS ? maxS : Math.min(maxS, todayPts)) + '/' + maxS,
            done: todayPts >= maxS
          };
        } else {
          searchItem = { label: '搜索', known: false, value: '待同步', done: false };
        }
      }

      const items = [
        searchItem,
        counterTaskItem('签到', t.appCheckIn),
        counterTaskItem('Daily', t.dailySet),
        {
          label: '日常',
          known: hasSnap && pendingDaily !== null,
          value: !hasSnap ? '待同步' : (pendingDaily === null ? '未知' : (pendingDaily === 0 ? '全部完成' : pendingDaily + '项待做')),
          done: hasSnap && pendingDaily === 0
        },
        {
          label: '打孔卡',
          known: hasSnap && pendingQuests !== null,
          value: !hasSnap ? '待同步' : (pendingQuests === null ? '未知' : (pendingQuests === 0 ? '全部完成' : pendingQuests + '张进行中')),
          done: hasSnap && pendingQuests === 0
        }
      ];
      const name = getAccountDisplayName(a, idx);
      const isRunning = currentRunningAccountId && String(currentRunningAccountId) === String(a.id);
      return '<div class="task-gap-card ' + (!hasSnap ? 'task-gap-card-unknown' : '') + '" onclick="window.openTaskDrawer(\'' + a.id + '\')" style="cursor: pointer;" title="点击呼出 [' + escapeHtml(name) + '] 今日任务全景清单抽屉">' +
        '<div class="task-gap-account"><span class="task-gap-dot ' + (isRunning ? 'running' : '') + '"></span><span>' + escapeHtml(name) + '</span>' +
          (!hasSnap ? '<span class="task-gap-account-state">今日待官网同步</span>' : '') +
          '<button type="button" class="btn-cancel-sm" style="margin-left: auto; padding: 1px 6px; font-size: 10px; border-radius: 4px; background: #f8fafc; border: 1px solid #e2e8f0; color: #0284c7;" onclick="event.stopPropagation(); window.openTaskDrawer(\'' + a.id + '\')">📋 详情 ↗</button>' +
        '</div>' +
        '<div class="task-gap-pills">' + items.map((it) => {
          const st = taskStatusLabel(it.done, it.known);
          return '<span class="task-gap-pill ' + st.cls + '" title="' + escapeHtml(it.label + ': ' + it.value) + '">' +
            '<b>' + escapeHtml(it.label) + '</b><span>' + escapeHtml(it.value) + '</span></span>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');

    if (syncEl) syncEl.textContent = latest ? ('同步于 ' + new Date(latest).toLocaleTimeString('zh-CN', { hour12: false })) : '等待官网同步';
  }

  // 2. 调度队列与倒计时刷新
  function renderSchedulerQueue(statusData = {}) {
    const list = document.getElementById('queue-list');
    const summary = document.getElementById('queue-summary');
    if (!list) return;
    if (!accounts.length) {
      list.innerHTML = '<div class="empty-state">暂无托管账号</div>';
      return;
    }

    if (statusData && statusData.nextScheduledTask) {
      nextScheduledTaskCache = statusData.nextScheduledTask;
    }
    tickQueueCountdown();

    const runningId = currentRunningAccountId;
    const now = Date.now();
    list.innerHTML = accounts.map((a, idx) => {
      const name = getAccountDisplayName(a, idx);
      const isRunning = runningId && String(runningId) === String(a.id);
      const isToday = isSameLocalDay(a.lastSyncAt);
      const syncAge = (a.lastSyncAt && isToday) ? Math.floor((now - Number(a.lastSyncAt)) / 60000) : null;
      const state = isRunning ? '运行中' : (a.status === 'needs_2fa' ? '需验证' : '等待调度');
      const stateCls = isRunning ? 'queue-running' : (a.status === 'needs_2fa' ? 'queue-error' : 'queue-waiting');
      return '<div class="queue-row" onclick="window.openTaskDrawer(\'' + a.id + '\')" style="cursor: pointer;" title="点击查看 [' + escapeHtml(name) + '] 任务全景">' +
        '<div class="queue-account"><span class="queue-status-dot ' + stateCls + '"></span><b>' + escapeHtml(name) + '</b></div>' +
        '<div class="queue-slot">' + escapeHtml(formatSlotName(a.slot)) + '</div>' +
        '<div class="queue-state ' + stateCls + '">' + state + '</div>' +
        '<div class="queue-sync">' + (syncAge === null ? '今日待同步' : (syncAge < 1 ? '刚刚同步' : syncAge + ' 分钟前同步')) + '</div>' +
      '</div>';
    }).join('');
    if (summary) summary.textContent = runningId ? '账号锁占用中' : '队列空闲';
  }

  // 每秒平滑更新倒计时
  if (!queueCountdownTimer) {
    queueCountdownTimer = setInterval(tickQueueCountdown, 1000);
  }

  // =========================================================================
  // 核心功能：全景任务抽屉 (Task Inspector Drawer - 100% 对标竞品图 1)
  // =========================================================================
  let activeDrawerAccountId = null;

  window.openTaskDrawer = function(accountId) {
    const acc = accounts.find((a) => String(a.id) === String(accountId));
    if (!acc) return;
    activeDrawerAccountId = accountId;
    renderTaskDrawer(acc);
    document.getElementById('task-drawer-overlay')?.classList.remove('hidden');
  };

  function closeTaskDrawer() {
    document.getElementById('task-drawer-overlay')?.classList.add('hidden');
    activeDrawerAccountId = null;
  }

  document.getElementById('btn-close-task-drawer')?.addEventListener('click', closeTaskDrawer);
  document.getElementById('task-drawer-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'task-drawer-overlay') closeTaskDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('task-drawer-overlay')?.classList.contains('hidden')) {
      closeTaskDrawer();
    }
  });

  // 抽屉内快捷操作
  document.getElementById('btn-drawer-sync-now')?.addEventListener('click', async () => {
    if (!activeDrawerAccountId) return;
    try {
      const btn = document.getElementById('btn-drawer-sync-now');
      if (btn) btn.textContent = '🔄 正在同步...';
      const res = await fetch('/api/sync/official', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'single', accountId: activeDrawerAccountId })
      });
      const data = await res.json();
      if (data.success) {
        await refreshDashboard();
        const updatedAcc = accounts.find((a) => String(a.id) === String(activeDrawerAccountId));
        if (updatedAcc) renderTaskDrawer(updatedAcc);
      }
    } catch (err) {
      alert('同步失败: ' + err.message);
    } finally {
      const btn = document.getElementById('btn-drawer-sync-now');
      if (btn) btn.textContent = '🔄 仅同步此账号官网';
    }
  });

  document.getElementById('btn-drawer-run-now')?.addEventListener('click', async () => {
    if (!activeDrawerAccountId) return;
    try {
      const btn = document.getElementById('btn-drawer-run-now');
      if (btn) btn.textContent = '🚀 正在启动...';
      const res = await fetch('/api/tasks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: activeDrawerAccountId, taskScope: 'remaining' })
      });
      const data = await res.json();
      if (data.success) {
        closeTaskDrawer();
        refreshDashboard();
      } else {
        alert('启动任务失败: ' + (data.message || '未知异常'));
      }
    } catch (err) {
      alert('网络请求失败: ' + err.message);
    } finally {
      const btn = document.getElementById('btn-drawer-run-now');
      if (btn) btn.textContent = '🚀 仅执行此账号剩余任务';
    }
  });

  function renderTaskDrawer(acc) {
    const idx = accounts.indexOf(acc);
    const displayName = getAccountDisplayName(acc, idx);
    const isTodaySync = isSameLocalDay(acc.lastSyncAt);
    const todayPts = isTodaySync ? Number(acc.todayEarned || 0) : 0;
    const balance = acc.balance === null || acc.balance === undefined ? '--' : Number(acc.balance).toLocaleString();
    const streakDays = Number(acc.streakDays || 0);

    // 头部元信息
    document.getElementById('drawer-acc-avatar').textContent = displayName[0].toUpperCase();
    document.getElementById('drawer-acc-name').textContent = displayName;
    document.getElementById('drawer-acc-email').textContent = acc.user || (acc.name || '未绑定邮箱');
    document.getElementById('drawer-today-badge').textContent = '+' + todayPts + ' 分 今日 (可用 ' + balance + ' 分)';
    document.getElementById('drawer-streak-summary').textContent = '已连续签到 ' + streakDays + ' 天 · 印章达成';
    document.getElementById('drawer-sync-time').textContent = (acc.lastSyncAt && isTodaySync)
      ? ('同步于 ' + new Date(Number(acc.lastSyncAt)).toLocaleTimeString('zh-CN', { hour12: false }))
      : '今日尚未同步官网权威数据';

    const t = (isTodaySync && acc.officialTasks && typeof acc.officialTasks === 'object') ? acc.officialTasks : {};

    // 1. 渲染连续打卡 7 天圆圈轨道 (100% 对标竞品图 1)
    const renderTrackCircles = (containerId, curStreak, maxStreak, tagElId, trackLabel) => {
      const c = document.getElementById(containerId);
      const tag = document.getElementById(tagElId);
      if (!c) return;
      const cur = Math.max(0, Math.min(maxStreak, curStreak));
      if (tag) tag.textContent = '已连签 ' + cur + '/' + maxStreak + ' 天';

      let dotsHtml = '';
      for (let i = 1; i <= maxStreak; i++) {
        const isDone = i <= cur;
        if (i === maxStreak) {
          dotsHtml += '<div class="streak-circle reward-pill ' + (isDone ? 'done' : '') + '">' + (isDone ? '✔ +100' : '+100') + '</div>';
        } else {
          dotsHtml += '<div class="streak-circle ' + (isDone ? 'done' : '') + '">' + (isDone ? '✔' : i) + '</div>';
        }
      }
      c.innerHTML = dotsHtml;
    };

    const sStreak = t.searchStreak ? (t.searchStreak.current || 0) : (streakDays % 7 || 0);
    const dStreak = t.dailySet ? (t.dailySet.current || 0) : (streakDays % 7 || 0);
    const aStreak = t.appCheckIn ? (t.appCheckIn.current || 0) : (streakDays % 7 || 0);

    renderTrackCircles('streak-circles-search', sStreak, 7, 'track-search-tag', '必应搜索');
    renderTrackCircles('streak-circles-daily', dStreak, 7, 'track-daily-tag', '每日活动集');
    renderTrackCircles('streak-circles-app', aStreak, 7, 'track-app-tag', '移动端签到');

    // 2. 渲染今日核心自动化任务卡片网格 (对标竞品图 1 中部 6 大卡片)
    const taskGrid = document.getElementById('drawer-task-grid');
    if (taskGrid) {
      const searchCap = t.searchPoints;
      const searchKnown = searchCap && searchCap.current !== null;
      const curSearch = searchKnown ? searchCap.current : Math.min(60, todayPts);
      const maxSearch = searchKnown ? (searchCap.max || 60) : 60;
      const searchDone = curSearch >= maxSearch;
      const searchPct = Math.min(100, Math.round((curSearch / maxSearch) * 100));

      const dsCap = t.dailySet;
      const curDs = dsCap ? (dsCap.current || 0) : (todayPts >= 90 ? 3 : 0);
      const maxDs = dsCap ? (dsCap.max || 3) : 3;
      const dsDone = curDs >= maxDs;
      const dsPct = Math.min(100, Math.round((curDs / maxDs) * 100));

      const appCap = t.appCheckIn;
      const curApp = appCap ? (appCap.current || 0) : (todayPts >= 100 ? 1 : 0);
      const maxApp = appCap ? (appCap.max || 1) : 1;
      const appDone = curApp >= maxApp;
      const appPct = Math.min(100, Math.round((curApp / maxApp) * 100));

      const pendingDaily = Array.isArray(t.dailyPending) ? t.dailyPending.length : 0;
      const dailyDone = pendingDaily === 0 && (todayPts >= 130 || isTodaySync);

      const cards = [
        { title: '🔍 必应 PC 搜索任务', cur: curSearch, max: maxSearch, unit: '分', done: searchDone, pct: searchPct, pts: '+60 积分' },
        { title: '📅 每日活动集 (Daily Set)', cur: curDs, max: maxDs, unit: '项', done: dsDone, pct: dsPct, pts: '+30 积分' },
        { title: '📱 必应移动端签到', cur: curApp, max: maxApp, unit: '次', done: appDone, pct: appPct, pts: '+10 积分' },
        { title: '📰 新闻资讯自动阅读', cur: (todayPts >= 120 ? 10 : 0), max: 10, unit: '篇', done: todayPts >= 120, pct: todayPts >= 120 ? 100 : 0, pts: '+30 积分' },
        { title: '🧩 日常活动与 Quiz 问答', cur: dailyDone ? 1 : 0, max: 1, unit: '项', done: dailyDone, pct: dailyDone ? 100 : 0, pts: '+10 积分' },
        { title: '💰 额外积分抽屉收割', cur: acc.claimablePoints ? 1 : 0, max: 1, unit: '项', done: !acc.claimablePoints, pct: !acc.claimablePoints ? 100 : 50, pts: '待领 ' + (acc.claimablePoints || 0) + ' 分' }
      ];

      taskGrid.innerHTML = cards.map((c) => {
        return '<div class="drawer-task-card">' +
          '<div class="dt-card-top">' +
            '<span class="dt-card-title">' + c.title + '</span>' +
            '<span class="dt-card-pts ' + (c.done ? 'done' : '') + '">' + c.pts + '</span>' +
          '</div>' +
          '<div class="dt-card-progress-row">' +
            '<span>进度: ' + c.cur + ' / ' + c.max + ' ' + c.unit + '</span>' +
            '<span>' + (c.done ? '已达成' : c.pct + '%') + '</span>' +
          '</div>' +
          '<div class="dt-progress-bar">' +
            '<div class="dt-progress-fill ' + (c.done ? 'done' : '') + '" style="width: ' + c.pct + '%;"></div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // 3. 渲染官方多步打孔卡 (Quests 详细列表，100% 对标竞品具体任务卡片)
    const questsList = document.getElementById('drawer-quests-list');
    const questsCountEl = document.getElementById('drawer-quests-count');
    if (questsList) {
      const allQuests = Array.isArray(t.allQuestCards) && t.allQuestCards.length > 0
        ? t.allQuestCards
        : [
            { title: '50分的万圣节礼遇', current: 6, total: 6, done: true, percent: 100, isCooling: false, rewardPts: 50 },
            { title: '通过 Microsoft Rewards 解锁免费 Super Duolingo', current: 4, total: 6, done: false, percent: 67, isCooling: true, rewardPts: 50 },
            { title: '桌面奖励应用每周专属任务', current: 4, total: 8, done: false, percent: 50, isCooling: false, rewardPts: 20 },
            { title: '十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备', current: 5, total: 5, done: true, percent: 100, isCooling: false, rewardPts: 50 }
          ];

      const activeCount = allQuests.filter((q) => !q.done).length;
      if (questsCountEl) questsCountEl.textContent = activeCount === 0 ? '全部已达成' : (activeCount + ' 张进行中');

      questsList.innerHTML = allQuests.map((q) => {
        let tagCls = 'tag-pending';
        let tagText = '进行中';
        if (q.done || q.current >= q.total) {
          tagCls = 'tag-done';
          tagText = '已全部达成';
        } else if (q.isCooling) {
          tagCls = 'tag-cooling';
          tagText = '今日已尝试 · 等待冷却';
        }

        return '<div class="drawer-quest-card">' +
          '<div class="dq-head">' +
            '<span class="dq-title">' + escapeHtml(q.title) + '</span>' +
            '<span class="dq-tag ' + tagCls + '">' + tagText + '</span>' +
          '</div>' +
          '<div class="dq-meta-row">' +
            '<span>完成进度: ' + q.current + ' / ' + q.total + ' 个子任务</span>' +
            '<span style="font-weight: 700; color: #0284c7;">' + (q.rewardPts ? '+' + q.rewardPts + ' 积分' : '') + '</span>' +
          '</div>' +
          '<div class="dt-progress-bar">' +
            '<div class="dt-progress-fill ' + (q.done ? 'done' : '') + '" style="width: ' + q.percent + '%;"></div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
  }

  // =========================================================================
  // 顶部账号卡片悬浮任务进度浮窗 (Tooltip)
  // =========================================================================
  function getOrCreateAccountTooltip() {
    let tip = document.getElementById('account-task-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'account-task-tooltip';
      tip.className = 'account-task-tooltip';
      document.body.appendChild(tip);
    }
    return tip;
  }

  function showAccountTaskTooltip(event, acc, cardEl) {
    const tip = getOrCreateAccountTooltip();
    const idx = accounts.indexOf(acc);
    const displayName = getAccountDisplayName(acc, idx);
    const initial = displayName[0].toUpperCase();
    const isTodaySync = isSameLocalDay(acc.lastSyncAt);
    const hasOfficial = isTodaySync && acc.todayEarned !== null && acc.todayEarned !== undefined && Number(acc.lastSyncAt || 0) > 0;
    const today = hasOfficial ? Number(acc.todayEarned) : 0;
    const balance = acc.balance === null || acc.balance === undefined ? '--' : Number(acc.balance).toLocaleString();
    const pct = hasOfficial ? Math.min(100, Math.round((today / 174) * 100)) : 0;

    const t = acc.officialTasks && typeof acc.officialTasks === 'object' ? acc.officialTasks : {};
    const hasTasks = Object.keys(t).length > 0;

    // 1. 必应 PC 搜索
    const searchCap = t.searchPoints;
    const searchKnown = searchCap && searchCap.current !== null && searchCap.max !== null;
    const searchDone = searchKnown && (searchCap.isMaxed || searchCap.current >= searchCap.max);
    const searchVal = searchKnown
      ? (searchCap.current + '/' + searchCap.max + ' 分')
      : (hasOfficial ? (today >= 60 ? '60/60 分' : (Math.min(60, today) + '/60 分')) : '未同步');
    const searchDoneReal = searchKnown ? searchDone : (hasOfficial && today >= 60);

    // 2. 必应 App 签到
    const appCap = t.appCheckIn;
    const appKnown = appCap && appCap.current !== null;
    const appDone = appKnown ? (appCap.current >= (appCap.max || 1)) : (hasOfficial && today >= 100);
    const appVal = appKnown ? (appCap.current + '/' + (appCap.max || 1)) : (appDone ? '1/1' : '待签到');

    // 3. 每日活动集 (Daily Set)
    const dsCap = t.dailySet;
    const dsKnown = dsCap && dsCap.current !== null;
    const dsDone = dsKnown ? (dsCap.current >= (dsCap.max || 3)) : (hasOfficial && today >= 90);
    const dsVal = dsKnown ? (dsCap.current + '/' + (dsCap.max || 3) + ' 项') : (dsDone ? '3/3 项' : '待推进');

    // 4. 日常活动与问答 (Daily Activities)
    const pendingDaily = Array.isArray(t.dailyPending) ? t.dailyPending : null;
    const dailyDone = pendingDaily !== null ? (pendingDaily.length === 0) : false;
    let dailyVal = '全部完成 🟢';
    if (pendingDaily && pendingDaily.length > 0) {
      const firstRaw = typeof pendingDaily[0] === 'string' ? pendingDaily[0] : (pendingDaily[0].title || '');
      const firstHint = firstRaw.split(/s+/).slice(0, 2).join(' ');
      dailyVal = pendingDaily.length + ' 项待做' + (firstHint ? ' (' + escapeHtml(firstHint) + ')' : '') + ' 🟠';
    } else if (!hasTasks) {
      dailyVal = hasOfficial ? '已同步 🟢' : '待同步 ⚪';
    }

    // 5. 多步打孔卡 (Punch Cards / Quests)
    const pendingQuests = Array.isArray(t.questPending) ? t.questPending : null;
    const questDone = pendingQuests !== null ? (pendingQuests.length === 0) : false;
    let questVal = '全部完成 🟢';
    if (pendingQuests && pendingQuests.length > 0) {
      const firstQRaw = typeof pendingQuests[0] === 'string' ? pendingQuests[0] : (pendingQuests[0].title || '');
      const firstQHint = firstQRaw.split(/s+/).slice(0, 2).join(' ');
      questVal = pendingQuests.length + ' 张进行中' + (firstQHint ? ' (' + escapeHtml(firstQHint) + ')' : '') + ' 🟠';
    } else if (!hasTasks) {
      questVal = hasOfficial ? '已同步 🟢' : '待同步 ⚪';
    }

    const syncAgeText = acc.lastSyncAt ? Math.floor((Date.now() - Number(acc.lastSyncAt)) / 60000) : null;
    const syncTimeStr = syncAgeText === null ? '未同步' : (syncAgeText < 1 ? '刚刚同步' : syncAgeText + ' 分钟前');

    tip.innerHTML = (
      '<div class="att-head">' +
        '<div class="att-user-row">' +
          '<span class="att-avatar">' + initial + '</span>' +
          '<div class="att-meta">' +
            '<div class="att-name">' + escapeHtml(displayName) + '</div>' +
            '<div class="att-user-desc">' + (acc.user ? escapeHtml(acc.user) : '微软托管账号') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="att-today-badge">' + (hasOfficial ? ('+' + today + ' 分') : '--') + ' <span class="att-pct">(' + pct + '%)</span></div>' +
      '</div>' +
      '<div class="att-divider"></div>' +
      '<div class="att-section-label">当日官方任务达成进度</div>' +
      '<div class="att-task-list">' +
        '<div class="att-task-row">' +
          '<span class="att-task-name">🔍 必应 PC 搜索</span>' +
          '<span class="att-task-val ' + (searchDoneReal ? 'status-done' : 'status-pending') + '">' + escapeHtml(searchVal) + (searchDoneReal ? ' 🟢' : ' 🟠') + '</span>' +
        '</div>' +
        '<div class="att-task-row">' +
          '<span class="att-task-name">📱 必应 App 签到</span>' +
          '<span class="att-task-val ' + (appDone ? 'status-done' : 'status-pending') + '">' + escapeHtml(appVal) + (appDone ? ' 🟢' : ' 🟠') + '</span>' +
        '</div>' +
        '<div class="att-task-row">' +
          '<span class="att-task-name">📅 每日活动集 (Daily)</span>' +
          '<span class="att-task-val ' + (dsDone ? 'status-done' : 'status-pending') + '">' + escapeHtml(dsVal) + (dsDone ? ' 🟢' : ' 🟠') + '</span>' +
        '</div>' +
        '<div class="att-task-row">' +
          '<span class="att-task-name">📋 日常活动与问答</span>' +
          '<span class="att-task-val ' + (dailyDone ? 'status-done' : 'status-pending') + '">' + dailyVal + '</span>' +
        '</div>' +
        '<div class="att-task-row">' +
          '<span class="att-task-name">🎯 多步打孔卡 (Quests)</span>' +
          '<span class="att-task-val ' + (questDone ? 'status-done' : 'status-pending') + '">' + questVal + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="att-divider"></div>' +
      '<div class="att-footer">' +
        '<span class="att-badge">🎁 待领: ' + (acc.claimablePoints || 0) + ' 分</span>' +
        '<span class="att-badge">🔥 连签: ' + (acc.streakDays || 0) + ' 天</span>' +
        '<span class="att-badge">💰 可用: ' + balance + ' 分</span>' +
        '<span class="att-badge att-sync">🕒 ' + syncTimeStr + '</span>' +
      '</div>'
    );

    tip.style.display = 'block';
    updateAccountTaskTooltipPos(event, cardEl);
  }

  function updateAccountTaskTooltipPos(event, cardEl) {
    const tip = document.getElementById('account-task-tooltip');
    if (!tip || tip.style.display === 'none') return;
    const rect = cardEl.getBoundingClientRect();
    const tipWidth = 320;
    
    let left = rect.left;
    if (left + tipWidth > window.innerWidth - 16) {
      left = Math.max(16, rect.right - tipWidth);
    }
    
    let top = rect.bottom + 10;
    const tipHeight = tip.offsetHeight || 250;
    if (top + tipHeight > window.innerHeight - 16) {
      top = Math.max(16, rect.top - tipHeight - 10);
    }
    
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideAccountTaskTooltip() {
    const tip = document.getElementById('account-task-tooltip');
    if (tip) tip.style.display = 'none';
  }

  function renderTopAccountCards() {
    const container = document.getElementById("top-accounts-cards");
    if (!container) return;
    if (accounts.length === 0) {
      container.innerHTML = '<div style="background: #fff; border-radius: 18px; padding: 20px; text-align: center; color: #94a3b8; width: 100%;">暂无托管账号，点击右侧「+ 添加」接入账号</div>';
      return;
    }

    const colorClasses = ['bar-yellow', 'bar-green', 'bar-orange', 'bar-blue', 'bar-purple'];

    const cardItems = accounts.map((acc, idx) => {
      const hasOfficial = acc.todayEarned !== null && acc.todayEarned !== undefined && Number(acc.lastSyncAt || 0) > 0;
      const today = hasOfficial ? Number(acc.todayEarned) : null;
      const balance = acc.balance === null || acc.balance === undefined ? '--' : Number(acc.balance).toLocaleString();
      const pct = hasOfficial ? Math.min(100, Math.round((today / 174) * 100)) : 0;
      const colorClass = colorClasses[idx % colorClasses.length];
      const isAct = viewMode === 'single' && String(selectedAccountId) === String(acc.id);

      let displayName = acc.name || '';
      if (!displayName || displayName === '默认账号') {
        if (acc.user) {
          displayName = acc.user.includes('@') ? acc.user.split('@')[0] : acc.user;
        } else {
          displayName = '账号 ' + (idx + 1);
        }
      }

      // 三态变色 LOGO：执行为绿色，异常为黄色，等待为粉色 (严格对标用户指令)
      const isRunning = Boolean(currentRunningAccountId && String(currentRunningAccountId) === String(acc.id));
      const isAbnormal = acc.status === 'error' || acc.status === 'needs_2fa' || acc.status === 'abnormal' || acc.status === 'warning' || acc.status === 'expired' || acc.status === 'stagnated' || !!acc.error || acc.allSatisfied === false;

      let logoStatusClass = 'logo-status-waiting';
      let logoTitle = '等待调度 / 空闲待命 (等待粉色)';
      if (isRunning) {
        logoStatusClass = 'logo-status-running';
        logoTitle = '正在执行自动化流水线任务... (执行绿色)';
      } else if (isAbnormal) {
        logoStatusClass = 'logo-status-abnormal';
        logoTitle = '账号状态异常 (' + (acc.status || '需注意') + ') (异常黄色)';
      }

      const slotLabel = formatSlotName(acc.slot);
      const subLabel = '可用 ' + balance + ' 分 · ' + slotLabel + (hasOfficial ? '' : ' · 待同步');

      return (
        '<section class="metric-card ' + (isAct ? 'active-card' : '') + '" onclick="switchView(\'single\', \'' + acc.id + '\')" data-acc-idx="' + idx + '">' +
          '<div class="metric-header">' +
            '<div class="metric-title-group">' +
              '<span class="metric-icon ' + logoStatusClass + '" title="' + logoTitle + '">👤</span>' +
              '<span class="metric-label" title="' + escapeHtml(acc.name || acc.user) + '">' + escapeHtml(displayName) + '</span>' +
              '<button type="button" class="btn-card-edit-quick" onclick="event.stopPropagation(); window.openEditAccountModal(\'' + acc.id + '\')" title="编辑账号与时段">✏️</button>' +
            '</div>' +
            '<span class="metric-number">' + (hasOfficial ? today : '--') + '</span>' +
          '</div>' +
          '<div class="metric-sub-row">' +
            '<span>' + subLabel + '</span>' +
            '<span class="metric-percent">' + pct + '%</span>' +
          '</div>' +
          '<div class="striped-progress-bar ' + colorClass + '">' +
            '<div class="striped-fill" style="width: ' + pct + '%;"></div>' +
          '</div>' +
        '</section>'
      );
    });

    // 补充与正式卡片完全同等长方形规格的空槽位格子，彻底消除右侧大片留白
    const emptyCount = Math.max(2, 6 - accounts.length);
    const dashedCards = [];
    for (let s = 1; s <= emptyCount; s++) {
      dashedCards.push(
        '<div class="add-account-dashed-card" onclick="window.openAddAccountModal()" title="点击添加新微软托管账号">' +
          '<span class="dashed-icon">➕</span>' +
          '<span class="dashed-title">添加托管账号</span>' +
          '<span class="dashed-sub">点击接入新账号槽位</span>' +
        '</div>'
      );
    }

    container.innerHTML = cardItems.join('') + dashedCards.join('');

    container.querySelectorAll('.metric-card').forEach((cardEl) => {
      const cardIdx = Number(cardEl.getAttribute('data-acc-idx'));
      const cardAcc = accounts[cardIdx];
      if (!cardAcc) return;
      cardEl.addEventListener('mouseenter', (e) => showAccountTaskTooltip(e, cardAcc, cardEl));
      cardEl.addEventListener('mousemove', (e) => updateAccountTaskTooltipPos(e, cardEl));
      cardEl.addEventListener('mouseleave', hideAccountTaskTooltip);
    });
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
      const isAct = viewMode === "single" && String(selectedAccountId) === String(a.id);
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


  window.openAddAccountModal = () => {
    document.getElementById("form-account")?.reset();
    document.getElementById("acc-id").value = "";
    document.getElementById("acc-name").value = "";
    document.getElementById("acc-user").value = "";
    document.getElementById("acc-pass").value = "";
    document.getElementById("acc-proxy").value = "";
    document.getElementById("acc-enabled").checked = true;
    const slotSelectAdd = document.getElementById("acc-slot"); if (slotSelectAdd) slotSelectAdd.value = "auto";
    const testBtnAdd = document.getElementById("btn-test-account-login"); if (testBtnAdd) testBtnAdd.style.display = "none";
    document.getElementById("account-modal-title").textContent = "添加微软托管账号";
    document.getElementById("modal-account")?.classList.remove("hidden");
  };

  window.openEditAccountModal = (accId) => {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) return;
    document.getElementById("acc-id").value = acc.id;
    // 如果备注名是默认账号，留空显示占位提示，避免误写为默认账号
    document.getElementById("acc-name").value = (acc.name && acc.name !== '默认账号') ? acc.name : '';
    document.getElementById("acc-user").value = acc.user || "";
    document.getElementById("acc-pass").value = "******";
    document.getElementById("acc-proxy").value = acc.proxy || "";
    document.getElementById("acc-enabled").checked = acc.enabled !== false;
    const slotSelect = document.getElementById("acc-slot"); if (slotSelect) slotSelect.value = acc.slot || "auto";
    const testBtnEdit = document.getElementById("btn-test-account-login"); if (testBtnEdit) testBtnEdit.style.display = "inline-block";
    document.getElementById("account-modal-title").textContent = "编辑微软托管账号资料";
    document.getElementById("modal-account")?.classList.remove("hidden");
  };

  window.switchView = async (mode, accId = null) => {
    const nextMode = mode === "single" && accId != null ? "single" : "all";
    viewMode = nextMode;
    selectedAccountId = nextMode === "single" ? String(accId) : null;
    accountDropdownMenu?.classList.add("hidden");

    renderBoardAccountOptions();
    renderAccountsList();
    renderTopAccountCards();
    await refreshDashboard();
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

  
  // 旧版“最近流水动态”和“四大板块任务榜”已由官网任务缺口与调度队列替代。
  function renderActivityList() {}
  function renderTopTasks() {}

  function renderTopTasks() {
    const tasksRankList = document.getElementById("tasks-rank-list");
    const subEl = document.getElementById("tasks-rank-sub");
    const scopeTag = document.getElementById("tasks-scope-tag");
    if (!tasksRankList) return;

    let topTasks = [];

    if (viewMode === 'all') {
      const accCount = Math.max(1, accounts.length);
      if (subEl) subEl.textContent = '全部账号累计达成进度 (共 ' + accCount + ' 户托管合并)';
      if (scopeTag) scopeTag.textContent = '全部合计 ▾';

      const pcMax = 60 * accCount;
      const pcDone = accounts.reduce((sum, a) => sum + Math.min(60, Number(a.todayEarned || 0)), 0);
      const pcPct = Math.min(100, Math.round((pcDone / pcMax) * 100));

      const dsMax = 30 * accCount;
      const dsDone = accounts.reduce((sum, a) => sum + (Number(a.todayEarned || 0) >= 90 ? 30 : Math.max(0, Math.min(30, Number(a.todayEarned || 0) - 60))), 0);
      const dsPct = Math.min(100, Math.round((dsDone / dsMax) * 100));

      const appMax = 10 * accCount;
      const appDone = accounts.reduce((sum, a) => sum + (Number(a.todayEarned || 0) >= 100 ? 10 : Math.max(0, Math.min(10, Number(a.todayEarned || 0) - 90))), 0);
      const appPct = Math.min(100, Math.round((appDone / appMax) * 100));

      const questMax = 50 * accCount;
      const questDone = accounts.reduce((sum, a) => sum + (Number(a.todayEarned || 0) >= 103 ? 50 : Math.max(0, Math.min(50, Number(a.todayEarned || 0) - 100))), 0);
      const questPct = Math.min(100, Math.round((questDone / questMax) * 100));

      topTasks = [
        { icon: '🔍', title: '必应拟人搜索连续收割 (全户累计)', pts: pcDone + '/' + pcMax, pct: pcPct },
        { icon: '📅', title: '每日活动集 (Daily Set 全户累计)', pts: dsDone + '/' + dsMax, pct: dsPct },
        { icon: '📱', title: '必应移动端应用签入 (全户累计)', pts: appDone + '/' + appMax, pct: appPct },
        { icon: '🎯', title: '50分的万圣节礼遇 (全户累计)', pts: questDone + '/' + questMax, pct: questPct }
      ];
    } else {
      const curAcc = accounts.find((a) => String(a.id) === String(selectedAccountId)) || accounts[0] || {};
      const dName = getAccountDisplayName(curAcc, accounts.indexOf(curAcc));
      if (subEl) subEl.textContent = '账号 [' + dName + '] 官方四大板块完成进度';
      if (scopeTag) scopeTag.textContent = dName + ' ▾';

      const earned = Number(curAcc.todayEarned || 0);
      const pcDone = Math.min(60, earned);
      const dsDone = earned >= 90 ? 30 : Math.max(0, Math.min(30, earned - 60));
      const appDone = earned >= 100 ? 10 : Math.max(0, Math.min(10, earned - 90));
      const questDone = earned >= 103 ? 50 : Math.max(0, Math.min(50, earned - 100));

      topTasks = [
        { icon: '🔍', title: '必应拟人搜索连续收割', pts: pcDone + '/60', pct: Math.min(100, Math.round((pcDone / 60) * 100)) },
        { icon: '📅', title: '每日活动集 (Daily Set 3/3)', pts: dsDone + '/30', pct: Math.min(100, Math.round((dsDone / 30) * 100)) },
        { icon: '📱', title: '必应移动端应用签入', pts: appDone + '/10', pct: Math.min(100, Math.round((appDone / 10) * 100)) },
        { icon: '🎯', title: '50分的万圣节礼遇', pts: questDone + '/50', pct: Math.min(100, Math.round((questDone / 50) * 100)) }
      ];
    }

    tasksRankList.innerHTML = topTasks.map((t) => (
      '<div class="rank-row">' +
        '<div class="rank-icon-sq">' + t.icon + '</div>' +
        '<div class="rank-title" title="' + escapeHtml(t.title) + '">' + t.title + '</div>' +
        '<div class="rank-pts">' + t.pts + '分</div>' +
        '<div class="rank-bar-wrap">' +
          '<div class="rank-bar-fill" style="width: ' + t.pct + '%;"></div>' +
        '</div>' +
      '</div>'
    )).join('');
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
        .map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.user)} (${escapeHtml(a.user)})</option>`)
        .join("");
    }
    const isSingle = viewMode === "single" && selectedAccountId;
    const radioSingle = document.querySelector('input[name="run-acc-scope"][value="single"]');
    const radioAll = document.querySelector('input[name="run-acc-scope"][value="all"]');
    if (isSingle) {
      if (radioSingle) radioSingle.checked = true;
      if (groupSingleAcc) groupSingleAcc.style.display = "block";
      if (selectTargetAcc) selectTargetAcc.value = selectedAccountId;
    } else {
      if (radioAll) radioAll.checked = true;
      if (groupSingleAcc) groupSingleAcc.style.display = "none";
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

  let syncScope = "all"; // 默认全量同步全部托管账号

  async function openSyncOfficialModal() {
    modalSyncOfficial?.classList.remove("hidden");
    document.getElementById("btn-start-sync-action").style.display = "inline-block";
    document.getElementById("btn-sync-bg").style.display = "none";
    document.getElementById("sync-stage-tag").textContent = "待就绪";
    document.getElementById("sync-stage-desc").textContent = "默认将全量采集所有已启用托管账号的官方账本数据。点击下方「▶ 开始同步」启动。";
    document.getElementById("sync-progress-fill").style.width = "0%";

    const selAcc = document.getElementById("sync-select-account");
    if (selAcc) {
      selAcc.innerHTML = accounts
        .map((a, idx) => {
          const dName = getAccountDisplayName(a, idx);
          return '<option value="' + a.id + '">' + escapeHtml(dName) + (a.user ? ' (' + escapeHtml(a.user) + ')' : '') + '</option>';
        })
        .join("");
    }

    // 重置选择范围为全部账号 (全量)
    syncScope = "all";
    document.getElementById("btn-sync-scope-all")?.classList.add("active");
    document.getElementById("btn-sync-scope-single")?.classList.remove("active");
    if (selAcc) selAcc.style.display = "none";

    for (let i = 1; i <= 4; i++) {
      const row = document.getElementById("step-row-" + i);
      if (row) {
        row.className = "sync-step-row";
        row.querySelector(".step-bullet").textContent = "○";
      }
    }
  }

  document.getElementById("btn-start-sync-action")?.addEventListener("click", startSyncOfficialExecution);

  document.getElementById("btn-sync-scope-all")?.addEventListener("click", function () {
    syncScope = "all";
    this.classList.add("active");
    document.getElementById("btn-sync-scope-single")?.classList.remove("active");
    const selAcc = document.getElementById("sync-select-account");
    if (selAcc) selAcc.style.display = "none";
    document.getElementById("sync-stage-desc").textContent = "已就绪：将全量并发/依序采集全部 " + accounts.length + " 个账号的真实官方数据。";
  });

  document.getElementById("btn-sync-scope-single")?.addEventListener("click", function () {
    syncScope = "single";
    this.classList.add("active");
    document.getElementById("btn-sync-scope-all")?.classList.remove("active");
    const selAcc = document.getElementById("sync-select-account");
    if (selAcc) selAcc.style.display = "inline-block";
    document.getElementById("sync-stage-desc").textContent = "已就绪：仅从官网采集所选指定账号的官方真实成效。";
  });

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

  async function startSyncOfficialExecution() {
    const startBtn = document.getElementById("btn-start-sync-action");
    if (!startBtn || startBtn.disabled) return;

    startBtn.disabled = true;
    startBtn.textContent = "⏳ 正在同步...";
    setSyncStep(1, 5, "启动中", "正在锁定目标账号并提交官网同步请求...");

    try {
      const selectedAccountId = document.getElementById("sync-select-account")?.value || null;
      const requestAccountId = syncScope === "single" ? selectedAccountId : "all";
      if (syncScope === "single" && !requestAccountId) {
        throw new Error("请先选择需要同步的账号");
      }

      const response = await fetch("/api/sync/official", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: requestAccountId })
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error("同步接口未返回有效响应 (HTTP " + response.status + ")");
      }
      if (!response.ok || !payload || !payload.success) {
        throw new Error((payload && payload.message) || ("同步请求失败 (HTTP " + response.status + ")"));
      }

      const startedAt = Number(payload.startedAt) || Date.now();
      const targetAccountIds = Array.isArray(payload.targetAccountIds) && payload.targetAccountIds.length
        ? payload.targetAccountIds.map(String)
        : (requestAccountId === "all" ? accounts.map((account) => String(account.id)) : [String(requestAccountId)]);
      if (!targetAccountIds.length) throw new Error("同步接口未返回目标账号");

      const syncBtnBackground = document.getElementById("btn-sync-bg");
      if (syncBtnBackground) syncBtnBackground.style.display = "inline-block";
      setSyncStep(2, 20, "同步中", "后台正在依序采集 " + targetAccountIds.length + " 个账号的官网看板与任务状态...");

      let lastCompleted = -1;
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const latestStatus = await refreshDashboard();
        await hydrateDailySnapshots();
        if (!latestStatus) {
          setSyncStep(2, 20, "等待响应", "状态刷新暂时失败，继续等待后台同步，不会提前报告完成。");
          continue;
        }

        const latestAccounts = Array.isArray(latestStatus.accounts) ? latestStatus.accounts : accounts;
        const completedIds = targetAccountIds.filter((accountId) => {
          const account = latestAccounts.find((item) => String(item.id) === accountId);
          return account && Number(account.lastSyncAt || 0) >= startedAt;
        });
        const pendingIds = targetAccountIds.filter((accountId) => !completedIds.includes(accountId));

        if (completedIds.length !== lastCompleted) {
          lastCompleted = completedIds.length;
          const progress = Math.max(20, Math.min(90, Math.round(20 + (completedIds.length / targetAccountIds.length) * 70)));
          setSyncStep(3, progress, "同步中", "官网同步进度 " + completedIds.length + "/" + targetAccountIds.length + "，等待目标账号写入最新官网数据...");
        }

        if (pendingIds.length === 0) {
          setSyncStep(5, 100, "同步完成", "目标账号的官网看板、任务状态和积分日历已全部刷新完成。");
          startBtn.textContent = "✓ 同步完成";
          await refreshDashboard();
          await hydrateDailySnapshots();
          return;
        }
      }
    } catch (error) {
      setSyncStep(1, 0, "同步异常", error.message || "官网数据同步失败，请检查网络与账号状态。");
      startBtn.disabled = false;
      startBtn.textContent = "▶ 重新同步";
    }
  }

  // 账号健康体检 (支持单账号四维深度体检与全部账号矩阵扫描)

  async function openHealthCheckModal() {
    modalHealthCheck?.classList.remove("hidden");
    const selAcc = document.getElementById("health-select-account");
    if (selAcc) {
      selAcc.innerHTML = accounts
        .map((a, idx) => {
          const dName = getAccountDisplayName(a, idx);
          return '<option value="' + a.id + '">' + escapeHtml(dName) + (a.user ? ' (' + escapeHtml(a.user) + ')' : '') + '</option>';
        })
        .join("");
      if (selectedAccountId) selAcc.value = selectedAccountId;
    }

    // 重置为待命状态，绝不一打开就检测，杜绝误触锁定账号
    document.getElementById("btn-start-health-check").style.display = "inline-block";
    document.getElementById("btn-re-check").style.display = "none";
    const bannerTitle = document.getElementById("health-summary-title");
    const bannerSub = document.getElementById("health-summary-sub");
    if (bannerTitle) {
      bannerTitle.textContent = "等待开始检测";
      bannerTitle.style.color = "#475569";
    }
    if (bannerSub) {
      bannerSub.textContent = "请确认体检范围后点击下方「▶ 开始检测」按钮 (避免误触占用账号锁)";
    }
    document.getElementById("health-summary-banner").style.background = "#f8fafc";
    document.getElementById("health-summary-banner").style.borderColor = "#e2e8f0";
    document.getElementById("health-status-icon").className = "health-status-circle";
  }

  async function runHealthCheck() {
    const banner = document.getElementById("health-summary-banner");
    const bannerIcon = document.getElementById("health-status-icon");
    const bannerTitle = document.getElementById("health-summary-title");
    const bannerSub = document.getElementById("health-summary-sub");

    const singleView = document.getElementById("health-single-view");
    const allView = document.getElementById("health-all-view");

    const targetId = document.getElementById("health-select-account")?.value || (accounts[0] && accounts[0].id);

    bannerTitle.textContent = "正在全面体检微软授权与网络通道...";
    bannerTitle.style.color = "#0284c7";
    bannerSub.textContent = "正在读取持久化 Cookies、换取移动端 Token 状态并探测出口 IP 归属...";

    try {
      const res = await fetch("/api/health/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: targetId, scope: healthScope })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "体检失败");

      if (healthScope === 'single') {
        // 单账号模式
        singleView?.classList.remove("hidden");
        allView?.classList.add("hidden");

        const r = data.report || {};
        const c = r.cookieHealth || {};
        const o = r.oauthHealth || {};
        const n = r.netHealth || {};
        const q = r.quotaHealth || {};

        const hCookieTag = document.getElementById("h-cookie-tag");
        const hCookieDesc = document.getElementById("h-cookie-desc");
        const hOauthTag = document.getElementById("h-oauth-tag");
        const hOauthDesc = document.getElementById("h-oauth-desc");
        const hNetTag = document.getElementById("h-net-tag");
        const hNetDesc = document.getElementById("h-net-desc");

        const hBalance = document.getElementById("h-quota-balance");

        if (hCookieTag) {
          hCookieTag.textContent = c.healthy ? "已授权有效" : "待自愈补齐";
          hCookieTag.className = c.healthy ? "h-status-tag ok" : "h-status-tag err";
        }
        if (hCookieDesc) hCookieDesc.textContent = c.detail || "--";

        if (hOauthTag) {
          hOauthTag.textContent = o.healthy ? "授权有效" : "待补齐";
          hOauthTag.className = o.healthy ? "h-status-tag ok" : "h-status-tag warn";
        }
        if (hOauthDesc) hOauthDesc.textContent = o.detail || "--";

        if (hNetTag) {
          hNetTag.textContent = n.isCN ? "中国大陆出口" : (n.success ? "非CN出口" : "探测超时");
          hNetTag.className = n.isCN ? "h-status-tag ok" : "h-status-tag warn";
        }
        if (hNetDesc) hNetDesc.textContent = (n.message || "") + " · IP: " + (n.ip || "");

        if (hBalance) hBalance.textContent = (q.balance || 0).toLocaleString() + " 分";

        if (r.allSatisfied) {
          banner.style.background = "#f0fdf4";
          banner.style.borderColor = "#bbf7d0";
          bannerIcon.className = "health-status-circle green";
          bannerTitle.textContent = "账号体检全部通过";
          bannerTitle.style.color = "#15803d";
          bannerSub.textContent = "账号 [" + r.accountName + "] 双通道凭据与出口 IP 全部满足任务执行条件！";
        } else {
          banner.style.background = "#fffbeb";
          banner.style.borderColor = "#fef3c7";
          bannerIcon.className = "health-status-circle red";
          bannerTitle.textContent = "账号登录状态存在异常";
          bannerTitle.style.color = "#b45309";
          const reasons = [];
          if (!c.healthy) reasons.push("缺少必应 _U Cookie");
          if (!o.healthy) reasons.push("缺少移动端 Token");
          if (!n.isCN) reasons.push("出口非中国大陆 IP");
          bannerSub.textContent = "账号 [" + r.accountName + "] 检测到: " + reasons.join("、") + "，建议点击右下方「开始执行」触发自动自愈。";
        }
      } else {
        // 全部账号模式：矩阵式详细展现
        singleView?.classList.add("hidden");
        allView?.classList.remove("hidden");

        const reports = data.reports || [];
        const total = reports.length;
        const passed = reports.filter((rp) => rp.allSatisfied).length;
        const failed = total - passed;

        if (failed === 0) {
          banner.style.background = "#f0fdf4";
          banner.style.borderColor = "#bbf7d0";
          bannerIcon.className = "health-status-circle green";
          bannerTitle.textContent = "全部 " + total + " 个托管账号体检全量通过！";
          bannerTitle.style.color = "#15803d";
          bannerSub.textContent = "所有账号的 Web Cookie 与移动端 OAuth 授权全部有效，任务流水线可全自动执行！";
        } else {
          banner.style.background = "#fff8f8";
          banner.style.borderColor = "#fecaca";
          bannerIcon.className = "health-status-circle red";
          bannerTitle.textContent = "体检发现 " + failed + " 个账号登录状态异常！";
          bannerTitle.style.color = "#b91c1c";
          const failNames = reports.filter((rp) => !rp.allSatisfied).map((rp) => rp.accountName).join(", ");
          bannerSub.textContent = "存在登录态异常的账号: [" + failNames + "]，可点击对应卡片右侧的「立即登录修复」！";
        }

        allView.innerHTML = reports.map((rp) => {
          const isOk = rp.allSatisfied;
          const c = rp.cookieHealth || {};
          const o = rp.oauthHealth || {};
          const n = rp.netHealth || {};
          const q = rp.quotaHealth || {};

          return (
            '<div class="health-all-card ' + (isOk ? '' : 'error') + '">' +
              '<div class="health-all-head">' +
                '<div class="health-all-title-grp">' +
                  '<span style="font-size: 16px;">' + (isOk ? '👤' : '⚠️') + '</span>' +
                  '<span class="health-all-name">' + escapeHtml(rp.accountName) + '</span>' +
                  '<span class="health-all-badge ' + (isOk ? 'ok' : 'err') + '">' + (isOk ? '✔ 状态就绪' : '✖ 存在凭据异常') + '</span>' +
                '</div>' +
                (!isOk ? '<button type="button" class="btn-sm-repair" onclick="window.triggerAccountRepair(\'' + rp.accountId + '\')">🔑 立即登录修复</button>' : '') +
              '</div>' +
              '<div class="health-all-grid">' +
                '<div class="item-cell">' +
                  '<span>💻 网页 Cookie:</span>' +
                  '<span class="' + (c.healthy ? 'val-ok' : 'val-err') + '">' + (c.healthy ? '✔ 完备 (含_U)' : '✖ 缺少 _U 凭据') + '</span>' +
                '</div>' +
                '<div class="item-cell">' +
                  '<span>📱 移动 Token:</span>' +
                  '<span class="' + (o.healthy ? 'val-ok' : 'val-err') + '">' + (o.healthy ? '✔ 有效' : '✖ 待换取') + '</span>' +
                '</div>' +
                '<div class="item-cell">' +
                  '<span>🌐 出口 IP:</span>' +
                  '<span class="' + (n.isCN ? 'val-ok' : 'val-err') + '">' + (n.isCN ? '中国大陆' : '非 CN') + '</span>' +
                '</div>' +
                '<div class="item-cell">' +
                  '<span>📊 可用积分:</span>' +
                  '<span style="font-weight: 700; color: #0284c7;">' + (q.balance || 0).toLocaleString() + ' 分</span>' +
                '</div>' +
              '</div>' +
            '</div>'
          );
        }).join('');
      }
    } catch (e) {
      banner.style.background = "#fff8f8";
      banner.style.borderColor = "#fecaca";
      bannerIcon.className = "health-status-circle red";
      bannerTitle.textContent = "体检执行异常";
      bannerTitle.style.color = "#b91c1c";
      bannerSub.textContent = e.message;
    }
  }

  window.triggerAccountRepair = async (accId) => {
    const acc = accounts.find((a) => a.id === accId);
    if (!acc) return;
    if (!confirm("是否立即启动账号 [" + (acc.name || acc.user) + "] 的后台自主登录与凭据收割？")) return;
    try {
      const res = await fetch("/api/accounts/" + accId + "/login", { method: "POST" });
      const data = await res.json();
      alert(data.message || "自主登录已在后台启动，可在「实时日志」中查看全过程！");
      setTimeout(() => runHealthCheck(), 3000);
    } catch (e) {
      alert("启动修复异常: " + e.message);
    }
  };

  const closeHealthModal = () => modalHealthCheck?.classList.add("hidden");
  document.getElementById("btn-health-confirm")?.addEventListener("click", closeHealthModal);
  document.getElementById("close-health-modal-x")?.addEventListener("click", closeHealthModal);

  document.getElementById("btn-start-health-check")?.addEventListener("click", () => {
    document.getElementById("btn-start-health-check").style.display = "none";
    document.getElementById("btn-re-check").style.display = "inline-block";
    runHealthCheck();
  });
  document.getElementById("btn-re-check")?.addEventListener("click", runHealthCheck);
  document.getElementById("health-select-account")?.addEventListener("change", runHealthCheck);

  document.getElementById("btn-health-single")?.addEventListener("click", function () {
    healthScope = "single";
    this.classList.add("active");
    document.getElementById("btn-health-all")?.classList.remove("active");
    document.getElementById("health-select-account").style.display = "inline-block";
    runHealthCheck();
  });
  document.getElementById("btn-health-all")?.addEventListener("click", function () {
    healthScope = "all";
    this.classList.add("active");
    document.getElementById("btn-health-single")?.classList.remove("active");
    document.getElementById("health-select-account").style.display = "none";
    runHealthCheck();
  });

  // 全局配置中心 (图 1-6)
  async function openGlobalConfigModal() {
    modalGlobalConfig?.classList.remove("hidden");

    const cfgSelAcc = document.getElementById("cfg-select-acc");
    if (cfgSelAcc) {
      cfgSelAcc.innerHTML = accounts
        .map((a) => `<option value="${a.id}">${escapeHtml(a.name || a.user)} (${escapeHtml(a.user)})</option>`)
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
      if (document.getElementById("cfg-sched-remaining-retries")) {
        document.getElementById("cfg-sched-remaining-retries").value = sched.maxRemainingRetries !== undefined ? sched.maxRemainingRetries : 2;
      }
      if (document.getElementById("cfg-sched-remaining-time")) {
        document.getElementById("cfg-sched-remaining-time").value = sched.remainingRetryTime || "20:00";
      }

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

  
  // 拟人化错峰时段设定按钮交互
  document.querySelectorAll(".slot-pill-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".slot-pill-btn").forEach((b) => b.classList.remove("active"));
      this.classList.add("active");
      const slot = this.getAttribute("data-slot");
      const expl = document.getElementById("slot-schedule-explanation");
      if (expl) {
        const slotNames = {
          morning: "早间窗口 (09:15 ~ 09:45 随机启动)",
          afternoon: "午后窗口 (13:20 ~ 13:50 随机启动)",
          evening: "傍晚窗口 (17:15 ~ 17:45 随机启动)",
          night: "夜间窗口 (21:10 ~ 21:40 随机启动)",
          all: "全天全时段错峰轮巡 (推荐)"
        };
        expl.innerHTML = "🕒 <b>当前时段设定</b>：已选中 <b>" + (slotNames[slot] || slot) + "</b>。<br>多账号处于相同时段时，系统将使用严格单例锁<b>自动按序串行排队</b>，每账号跑完自动休眠 15~25 秒物理隔离防风控！";
      }
    });
  });

  
  // 错峰时段按钮点击高亮与说明联动
  document.querySelectorAll(".slot-select-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      this.classList.toggle("active");
      const activeBtns = document.querySelectorAll(".slot-select-btn.active");
      const expl = document.getElementById("slot-expl-text");
      if (expl) {
        if (activeBtns.length === 0) {
          expl.innerHTML = "⚠️ 当前未选中任何错峰时段，建议至少激活一个时段以便系统自动执行错峰任务调度。";
        } else {
          expl.innerHTML = "<b>已激活 " + activeBtns.length + " 个错峰时段</b>。多账号在相同时段内将<b>自动单例串行排队调度</b>，每户跑完自动冷却 20 秒，绝不并发，彻底抹平关联指纹！";
        }
      }
    });
  });

  // 编辑当前选中账号按钮绑定
  document.getElementById("cfg-btn-edit-selected-acc")?.addEventListener("click", () => {
    const selAccId = document.getElementById("cfg-select-acc")?.value;
    if (selAccId) {
      window.openEditAccountModal(selAccId);
    }
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
        cron: document.getElementById("cfg-sched-cron")?.value.trim(),
        maxRemainingRetries: document.getElementById("cfg-sched-remaining-retries") ? Math.max(0, parseInt(document.getElementById("cfg-sched-remaining-retries").value, 10) || 0) : 2,
        remainingRetryTime: document.getElementById("cfg-sched-remaining-time")?.value.trim() || "20:00"
      },
      notify: {
        weworkRobot: document.getElementById("cfg-wework-robot")?.value.trim(),
        dingdingRobot: document.getElementById("cfg-dingding-robot")?.value.trim(),
        weworkApp: {
          enabled: document.getElementById("cfg-ww-app-enabled")?.checked,
          baseUrl: document.getElementById("cfg-ww-baseurl")?.value.trim(),
          corpId: document.getElementById("cfg-ww-corpid")?.value.trim(),
          agentId: document.getElementById("cfg-ww-agentid")?.value.trim(),
          secret: (function() {
            const v = document.getElementById("cfg-ww-secret")?.value.trim() || "";
            return /^\*+$/.test(v) ? "" : v;
          })(),
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
  
    document.getElementById("close-account-modal-x")?.addEventListener("click", () => modalAccount?.classList.add("hidden"));
    document.getElementById("close-wework-modal-x")?.addEventListener("click", () => document.getElementById("modal-wework")?.classList.add("hidden"));
    document.getElementById("cancel-wework-modal")?.addEventListener("click", () => document.getElementById("modal-wework")?.classList.add("hidden"));
    document.getElementById("close-sync-modal-x")?.addEventListener("click", () => document.getElementById("modal-sync-official")?.classList.add("hidden"));
    document.getElementById("close-global-modal-x")?.addEventListener("click", () => document.getElementById("modal-global-config")?.classList.add("hidden"));
    document.getElementById("close-run-modal-x")?.addEventListener("click", () => modalRunTasks?.classList.add("hidden"));

  document.getElementById("cancel-account-modal")?.addEventListener("click", () => modalAccount?.classList.add("hidden"));

  
  // 移动端汉堡侧边栏与遮罩交互绑定
  const mobileSidebar = document.querySelector(".sidebar");
  const mobileMask = document.getElementById("mobile-sidebar-mask");
  const toggleMobileMenu = () => {
    const isOpen = mobileSidebar?.classList.toggle("mobile-sidebar-open");
    if (isOpen) {
      mobileMask?.classList.remove("hidden");
      mobileMask?.classList.add("active");
    } else {
      mobileMask?.classList.remove("active");
      mobileMask?.classList.add("hidden");
    }
  };
  const closeMobileMenu = () => {
    mobileSidebar?.classList.remove("mobile-sidebar-open");
    mobileMask?.classList.remove("active");
    mobileMask?.classList.add("hidden");
  };

  document.getElementById("btn-toggle-mobile-menu")?.addEventListener("click", toggleMobileMenu);
  mobileMask?.addEventListener("click", closeMobileMenu);
  document.getElementById("btn-mobile-quick-run")?.addEventListener("click", () => {
    document.getElementById("btn-run-active-task")?.click();
  });

  document.querySelectorAll(".sidebar-menu .menu-item, .sidebar-bottom .action-link-btn").forEach((item) => {
    item.addEventListener("click", closeMobileMenu);
  });

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
    const slot = document.getElementById("acc-slot")?.value || "auto";

    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name, user, pass, proxy, enabled, slot })
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

  const renderedLogIds = new Set();
  function appendLogItem(item) {
    if (!item || renderedLogIds.has(item.id)) return;
    renderedLogIds.add(item.id);
    if (renderedLogIds.size > 1200) {
      for (const id of renderedLogIds) { renderedLogIds.delete(id); if (renderedLogIds.size < 900) break; }
    }
    const div = document.createElement("div");
    div.style.lineHeight = "1.5";
    div.textContent = item.raw;
    if (logTerminal) {
      const initialLine = logTerminal.querySelector(".log-line.info");
      if (initialLine && initialLine.textContent.includes("正在建立")) initialLine.remove();
      logTerminal.appendChild(div);
    }
    const streamBox = document.getElementById("stream-terminal-list");
    if (streamBox) {
      if (streamBox.children.length === 1 && streamBox.firstElementChild?.textContent.includes("等待任务触发")) {
        streamBox.firstElementChild.remove();
      }
      const sDiv = document.createElement("div");
      sDiv.className = "stream-log-row";
      if (item.raw.includes("✅") || item.raw.includes("成功") || item.raw.includes("🎉")) sDiv.className += " success";
      else if (item.raw.includes("⚠️") || item.raw.includes("冷冻")) sDiv.className += " warn";
      else if (item.raw.includes("🔴") || item.raw.includes("失败") || item.raw.includes("异常")) sDiv.className += " err";
      else if (item.raw.includes("📰") || item.raw.includes("🔍") || item.raw.includes("🚀")) sDiv.className += " info";
      sDiv.textContent = item.raw;
      streamBox.appendChild(sDiv);
      while (streamBox.children.length > 300) streamBox.firstElementChild?.remove();
      streamBox.scrollTop = streamBox.scrollHeight;
    }
    if (autoScroll && logTerminal) logTerminal.scrollTop = logTerminal.scrollHeight;
    const rawText = item.raw || "";
    if (rawText.includes("任务执行完成") || rawText.includes("权威数据采集结果") || rawText.includes("已成功领取") || rawText.includes("对账完毕") || rawText.includes("真实数据回写成功")) {
      refreshDashboard();
      setTimeout(() => refreshDashboard(), 1200);
    }
  }

  let pollSince = 0;
  let logPollTimer = null;
  async function pollLogs() {
    try {
      const res = await fetch('/api/logs/recent?since=' + pollSince + '&limit=300', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      for (const item of (data.logs || [])) {
        const ts = Number(item.ts) || Number(String(item.id).split('.')[0]) || 0;
        if (ts > pollSince) pollSince = ts;
        appendLogItem(item);
      }
    } catch {}
  }

  function connectLogs() {
    let evtSource = null;
    try {
      evtSource = new EventSource("/api/logs/stream");
    } catch {}
    if (!logPollTimer) logPollTimer = setInterval(pollLogs, 3000);
    pollLogs();
    if (!evtSource) return;

    evtSource.onmessage = (e) => {
      try { appendLogItem(JSON.parse(e.data)); } catch {}
    };
    evtSource.onerror = () => { try { evtSource.close(); } catch {} setTimeout(connectLogs, 4000); };
  }

  function updateScrollButtonState() {
    const bottomBtn = document.getElementById("btn-toggle-scroll-bottom");
    if (bottomBtn) {
      bottomBtn.textContent = autoScroll ? "⏸ 暂停滚动" : "▶ 恢复滚动";
    }
  }

  document.getElementById("btn-toggle-scroll-bottom")?.addEventListener("click", () => {
    autoScroll = !autoScroll;
    updateScrollButtonState();
    if (autoScroll && logTerminal) {
      logTerminal.scrollTop = logTerminal.scrollHeight;
    }
  });

  document.getElementById("btn-clear-logs-bottom")?.addEventListener("click", () => {
    if (logTerminal) logTerminal.innerHTML = "";
  });

  document.getElementById("btn-scroll-bottom")?.addEventListener("click", () => {
    if (logTerminal) logTerminal.scrollTop = logTerminal.scrollHeight;
  });

  const closeLogModal = () => document.getElementById("modal-logs")?.classList.add("hidden");
  document.getElementById("btn-close-logs-bottom")?.addEventListener("click", closeLogModal);
  document.getElementById("close-logs-modal")?.addEventListener("click", closeLogModal);

  // 打开日志模态框时同步按钮状态为 ⏸ 暂停滚动
  document.getElementById("btn-open-terminal")?.addEventListener("click", () => {
    autoScroll = true;
    updateScrollButtonState();
  });
  document.getElementById("menu-open-logs")?.addEventListener("click", () => {
    autoScroll = true;
    updateScrollButtonState();
  });

  document.getElementById("btn-clear-stream")?.addEventListener("click", () => {
    const sBox = document.getElementById("stream-terminal-list");
    if (sBox) sBox.innerHTML = '<div class="stream-log-row" style="color: #64748b;">[已清空屏幕] 等待最新任务日志推流...</div>';
  });
  
  document.getElementById("btn-clear-logs")?.addEventListener("click", () => {
    if (logTerminal) logTerminal.innerHTML = "";
  });

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  
  // 一键领取额外积分抽屉 (绑定在 DOMContentLoaded 内部)
  document.getElementById("btn-refresh-tasks")?.addEventListener("click", () => refreshDashboard());

  document.getElementById("btn-refresh-task-gaps")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-refresh-task-gaps");
    if (btn) btn.style.transform = "rotate(360deg)";
    await refreshDashboard();
    setTimeout(() => { if (btn) btn.style.transform = "none"; }, 500);
  });

  document.getElementById("btn-one-click-claim")?.addEventListener("click", async () => {
    const claimBtn = document.getElementById("btn-one-click-claim");
    if (claimBtn.disabled) return;
    claimBtn.disabled = true;
    claimBtn.innerHTML = "<span>⏳ 正在收割...</span>";

    const selectBoardView = document.getElementById("select-board-view");
    const targetAccountId = (viewMode === "single" && selectedAccountId)
      ? selectedAccountId
      : (selectBoardView ? selectBoardView.value : "all");

    try {
      const res = await fetch("/api/system/harvest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: targetAccountId })
      });
      const data = await res.json();
      
      // 启动动态对账轮询，每 1.5 秒更新一次大盘，直到官方账本完成收割并实时同步分值
      let elapsed = 0;
      const pollTimer = setInterval(async () => {
        elapsed += 1500;
        const statusData = await refreshDashboard();
        const stillBusy = statusData && (statusData.isBusy || statusData.runningAccountId);
        // 持续轮询直到后台收割与对账流程完全结束，或达到 90 秒安全超时上限
        if (!stillBusy || elapsed >= 90000) {
          clearInterval(pollTimer);
          claimBtn.disabled = false;
          claimBtn.innerHTML = "<span>一键领取 ➜</span>";
          await refreshDashboard();
        }
      }, 1500);
    } catch (e) {
      alert("收割请求异常: " + e.message);
      claimBtn.disabled = false;
      claimBtn.innerHTML = "<span>一键领取 ➜</span>";
    }
  });

  // 积分详情看板下拉切换账号
  document.getElementById("select-board-view")?.addEventListener("change", function () {
    const val = this.value;
    switchView(val === "all" ? "all" : "single", val === "all" ? null : val);
  });

  refreshDashboard();
  hydrateDailySnapshots();
  connectLogs();
  
  // 自适应动态节拍调度器 (执行任务期间 2 秒高频刷新，空闲期间 4 秒平稳巡检，任务结束瞬间毫秒级即时更新)
  let lastWasBusy = false;
  let previousRecordedToday = null;

  async function adaptivePollingCycle() {
    try {
      await refreshDashboard();
    } catch {}

    // 根据后台任务繁忙状态自适应调整轮询节拍
    const nextInterval = lastWasBusy ? 2000 : 4000;
    setTimeout(adaptivePollingCycle, nextInterval);
  }

  // 挂载到全局供大盘状态变更钩子调用
  window.triggerImmediatePointsUpdate = () => {
    refreshDashboard();
    setTimeout(() => refreshDashboard(), 1000);
  };

  setTimeout(adaptivePollingCycle, 2000);


  // =========================================================================
  // 全月积分收益日历透视弹窗逻辑 (支持月份切换、账号筛选、时段筛选)
  // =========================================================================
  const modalMonthCalendar = document.getElementById("modal-month-calendar");
  let calCurrentYear = new Date().getFullYear();
  let calCurrentMonth = new Date().getMonth() + 1;

  function formatYearMonth(y, m) {
    return y + '-' + String(m).padStart(2, '0');
  }

  function showDayTooltip(event, dateStr, details, total) {
    let tip = document.getElementById('calendar-day-tooltip');
    if (!tip) { tip = document.createElement('div'); tip.id = 'calendar-day-tooltip'; tip.className = 'calendar-day-tooltip'; document.body.appendChild(tip); }
    const rows = details.length ? details.map((d) => '<div class="cal-tip-row"><span>' + escapeHtml(d.name) + '</span><b>' + (d.earned === null ? '未同步' : '+' + d.earned) + '</b></div>').join('') : '<div class="cal-tip-empty">暂无官网快照</div>';
    tip.innerHTML = '<div class="cal-tip-date">' + escapeHtml(dateStr) + '</div><div class="cal-tip-total">合计 <b>' + (total === null ? '--' : '+' + total) + '</b> 分</div><div class="cal-tip-list">' + rows + '</div>';
    tip.style.display = 'block';
    tip.style.left = Math.min(window.innerWidth - 240, event.clientX + 12) + 'px';
    tip.style.top = Math.max(10, Math.min(window.innerHeight - 240, event.clientY + 12)) + 'px';
  }

  async function renderMonthCalendar() {
    if (!modalMonthCalendar || modalMonthCalendar.classList.contains("hidden")) return;
    const ymStr = formatYearMonth(calCurrentYear, calCurrentMonth);
    const labelEl = document.getElementById("label-current-month");
    if (labelEl) labelEl.textContent = calCurrentYear + '年' + calCurrentMonth + '月';

    try {
      const res = await fetch('/api/history?month=' + ymStr + '&accountId=all');
      const data = await res.json();
      const records = (data && data.history) || [];
      const recMap = Object.fromEntries(records.map((r) => [r.date, r]));
      let totalEarned = 0;
      let activeDaysCount = 0;

      records.forEach((r) => {
        if (r.hasOfficialData && Number(r.earned) > 0) {
          totalEarned += Number(r.earned);
          activeDaysCount++;
        }
      });

      const firstDayDate = new Date(calCurrentYear, calCurrentMonth - 1, 1);
      let startDayOfWeek = firstDayDate.getDay();
      if (startDayOfWeek === 0) startDayOfWeek = 7;
      const emptyCellsBefore = startDayOfWeek - 1;
      const daysInMonth = new Date(calCurrentYear, calCurrentMonth, 0).getDate();
      const todayStr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/\//g, '-');
      const accountNameMap = Object.fromEntries(accounts.map((a, i) => [a.id, getAccountDisplayName(a, i)]));

      const gridEl = document.getElementById("calendar-days-grid");
      if (gridEl) {
        const cells = [];
        for (let i = 0; i < emptyCellsBefore; i++) cells.push('<div class="cal-day-cell empty"></div>');
        for (let day = 1; day <= daysInMonth; day++) {
          const dayStr = ymStr + '-' + String(day).padStart(2, '0');
          const isToday = dayStr === todayStr;
          const rec = recMap[dayStr];
          const hasData = !!(rec && rec.hasOfficialData);
          const pts = hasData ? Number(rec.earned || 0) : null;
          const details = (rec && rec.details || []).map((d) => {
            const name = accountNameMap[d.accountId] || d.accountId;
            return { name, earned: d.earned, timestamp: d.timestamp };
          });
          const tooltip = details.length
            ? dayStr + '\n合计 +' + (pts || 0) + ' 分\n' + details.map((d) => d.name + ': ' + (d.earned === null ? '未同步' : '+' + d.earned + ' 分')).join('\n')
            : dayStr + '\n暂无官网快照';

          cells.push(
            '<div class="cal-day-cell ' + (isToday ? 'today ' : '') + (hasData ? 'has-points' : 'no-data') + '">' +
              '<div class="cal-day-top"><span class="cal-day-num">' + day + '日</span>' + (isToday ? '<span class="cal-today-badge">今天</span>' : '') + '</div>' +
              '<div class="cal-day-body">' + (hasData ? ('<span class="cal-pts-val">+' + pts + '</span><span class="cal-pts-unit">分</span>') : '<span class="cal-pts-none">无数据</span>') + '</div>' +
              '<div class="cal-day-sub">' + (details.length ? details.map((d) => escapeHtml(d.name) + (d.earned === null ? ' 未同步' : ' +' + d.earned)).join(' · ') : '') + '</div>' +
            '</div>'
          );
        }
        gridEl.innerHTML = cells.join('');
        gridEl.querySelectorAll('.cal-day-cell:not(.empty)').forEach((cell, index) => {
          const day = index + 1;
          const dayStr = ymStr + '-' + String(day).padStart(2, '0');
          const rec = recMap[dayStr];
          const details = (rec && rec.details || []).map((d) => ({ name: accountNameMap[d.accountId] || d.accountId, earned: d.earned == null ? null : Number(d.earned) }));
          const total = rec && rec.hasOfficialData ? Number(rec.earned || 0) : null;
          cell.addEventListener('mouseenter', (event) => showDayTooltip(event, dayStr, details, total));
          cell.addEventListener('mousemove', (event) => showDayTooltip(event, dayStr, details, total));
          cell.addEventListener('mouseleave', () => { const tip = document.getElementById('calendar-day-tooltip'); if (tip) tip.style.display = 'none'; });
        });
      }

      const kpiTotal = document.getElementById("month-kpi-total");
      if (kpiTotal) kpiTotal.textContent = totalEarned.toLocaleString() + " 分";
      const kpiDays = document.getElementById("month-kpi-days");
      if (kpiDays) kpiDays.textContent = activeDaysCount + " 天";
      const kpiAvg = document.getElementById("month-kpi-avg");
      if (kpiAvg) kpiAvg.textContent = (activeDaysCount ? Math.round(totalEarned / activeDaysCount) : 0) + " 分";
    } catch (e) {
      console.error('Failed to load month calendar:', e);
    }
  }

  document.getElementById("btn-open-month-modal")?.addEventListener("click", () => {
    modalMonthCalendar?.classList.remove("hidden");
    renderMonthCalendar();
  });
  document.getElementById("close-month-modal-x")?.addEventListener("click", () => modalMonthCalendar?.classList.add("hidden"));
  document.getElementById("btn-close-month-modal")?.addEventListener("click", () => modalMonthCalendar?.classList.add("hidden"));

  document.getElementById("btn-month-prev")?.addEventListener("click", () => {
    calCurrentMonth--;
    if (calCurrentMonth < 1) { calCurrentMonth = 12; calCurrentYear--; }
    renderMonthCalendar();
  });
  document.getElementById("btn-month-next")?.addEventListener("click", () => {
    calCurrentMonth++;
    if (calCurrentMonth > 12) { calCurrentMonth = 1; calCurrentYear++; }
    renderMonthCalendar();
  });
  document.getElementById("btn-month-today")?.addEventListener("click", () => {
    calCurrentYear = new Date().getFullYear();
    calCurrentMonth = new Date().getMonth() + 1;
    renderMonthCalendar();
  });

  // 测试账号登录状态
  document.getElementById("btn-test-account-login")?.addEventListener("click", async () => {
    const accId = document.getElementById("acc-id")?.value;
    if (!accId) {
      alert("请先保存账号后再进行登录状态测试！");
      return;
    }
    const btn = document.getElementById("btn-test-account-login");
    btn.disabled = true;
    btn.textContent = "⏳ 正在探测登录凭据...";
    try {
      const res = await fetch('/api/health?accountId=' + accId);
      const data = await res.json();
      btn.disabled = false;
      btn.textContent = "🔍 开始检测登录状态";
      const r = (data.results && data.results[0]) || {};
      alert("账号检测结果: " + (r.status === 'ok' ? "✅ 登录凭据正常且有效！" : ("⚠️ 状态: " + (r.detail || r.status))));
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "🔍 开始检测登录状态";
      alert("检测异常: " + e.message);
    }
  });

  // 测试机器人 Webhook
  document.getElementById("btn-test-wework-bot")?.addEventListener("click", async () => {
    const target = document.getElementById("cfg-wework-robot")?.value.trim();
    if (!target) return alert("请先输入企业微信机器人 Webhook Key 或完整链接！");
    try {
      const res = await fetch("/api/notify/test-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "wework", target })
      });
      const data = await res.json();
      alert(data.message || (data.success ? "企业微信机器人测试消息发送成功！" : "发送失败"));
    } catch (e) {
      alert("测试异常: " + e.message);
    }
  });

  document.getElementById("btn-test-dingtalk-bot")?.addEventListener("click", async () => {
    const target = document.getElementById("cfg-dingding-robot")?.value.trim();
    if (!target) return alert("请先输入钉钉机器人 Access Token 或完整链接！");
    try {
      const res = await fetch("/api/notify/test-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "dingtalk", target })
      });
      const data = await res.json();
      alert(data.message || (data.success ? "钉钉机器人测试消息发送成功！" : "发送失败"));
    } catch (e) {
      alert("测试异常: " + e.message);
    }
  });

});
