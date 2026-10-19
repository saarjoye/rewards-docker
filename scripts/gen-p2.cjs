const fs = require('fs');

let p2 = `
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
`;
fs.appendFileSync('scripts/rebuild-app.cjs', p2, 'utf8');
console.log('Part 2 appended');
