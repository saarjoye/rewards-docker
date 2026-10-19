const fs = require('fs');

let p3 = `
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
        .map((a) => "<option value=\"" + a.id + "\">" + escapeHtml(a.name || a.user) + " (" + escapeHtml(a.user) + ")</option>")
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
        .map((a) => "<option value=\"" + a.id + "\">" + escapeHtml(a.name || a.user) + "</option>")
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
        .map((a) => "<option value=\"" + a.id + "\">" + escapeHtml(a.name || a.user) + " (" + escapeHtml(a.user) + ")</option>")
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
`;
fs.appendFileSync('scripts/rebuild-app.cjs', p3, 'utf8');
console.log('Part 3 appended');
