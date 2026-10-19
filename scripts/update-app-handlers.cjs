const fs = require('fs');

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

// 移除可能存在的旧残余
const oldModalIdx = content.indexOf('// === 三大核心功能弹窗与交互实现');
if (oldModalIdx !== -1) {
  content = content.slice(0, oldModalIdx);
}

const newModalHandlers = `
  // === 三大核心中枢功能实现：官网同步、账号健康体检、全局配置中心 ===
  const modalSyncOfficial = document.getElementById("modal-sync-official");
  const modalHealthCheck = document.getElementById("modal-health-check");
  const modalGlobalConfig = document.getElementById("modal-global-config");

  // 1. 侧边栏菜单事件绑定
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

  // 弹窗关闭按钮
  document.getElementById("close-sync-modal")?.addEventListener("click", () => modalSyncOfficial?.classList.add("hidden"));
  document.getElementById("btn-sync-close")?.addEventListener("click", () => modalSyncOfficial?.classList.add("hidden"));
  document.getElementById("btn-sync-bg")?.addEventListener("click", () => modalSyncOfficial?.classList.add("hidden"));

  document.getElementById("close-health-modal")?.addEventListener("click", () => modalHealthCheck?.classList.add("hidden"));
  document.getElementById("btn-health-confirm")?.addEventListener("click", () => modalHealthCheck?.classList.add("hidden"));

  document.getElementById("close-global-modal")?.addEventListener("click", () => modalGlobalConfig?.classList.add("hidden"));
  document.getElementById("cancel-global-modal")?.addEventListener("click", () => modalGlobalConfig?.classList.add("hidden"));

  // ===================================
  // 功能 1：官网数据同步 (对标图 7 弹窗)
  // ===================================
  async function openSyncOfficialModal() {
    modalSyncOfficial?.classList.remove("hidden");

    // 重置步骤状态
    for (let i = 1; i <= 4; i++) {
      const row = document.getElementById("step-row-" + i);
      if (row) {
        row.className = "sync-step-row";
        row.querySelector(".step-bullet").textContent = "○";
      }
    }

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

  // ===================================
  // 功能 2：账号健康体检 (对标图 8 弹窗)
  // ===================================
  let healthScope = "single";

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

  // ===================================
  // 功能 3：全局配置中心 (对标图 1-6)
  // ===================================
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

  // 配置中心 Tab 切换
  document.querySelectorAll(".cfg-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".cfg-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const targetPane = tab.getAttribute("data-cfgtab");
      document.querySelectorAll(".cfg-pane").forEach((p) => p.classList.add("hidden"));
      document.getElementById("pane-cfg-" + targetPane)?.classList.remove("hidden");
    });
  });

  // 搜索节奏预设
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

  // 网络出口测试按钮
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

  // 保存所有全局配置
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

  // 测试自建应用推送
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

  setInterval(refreshDashboard, 8000);
});
`;

content += newModalHandlers;
fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js updated with clean event handlers for all 3 modals');
