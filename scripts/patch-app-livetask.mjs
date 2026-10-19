import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

// 替换运行大盘中监控数据渲染逻辑
const oldMonitorRender = `      // 运行大盘：无头浏览器实时态与容器内存渲染
      const bState = data.browserState || {};
      const mem = bState.memory || { usedMB: 142, limitMB: 512, percent: 28, peakMB: 210, status: 'healthy' };

      // Topbar 内存胶囊
      const topMemText = document.getElementById("topbar-mem-text");
      if (topMemText) topMemText.textContent = \`\${mem.usedMB} MB / \${mem.limitMB} MB\`;

      // 浏览器状态徽章
      const bChip = document.getElementById("browser-status-chip");
      if (bChip) {
        if (bState.status === 'idle') {
          bChip.textContent = "● 空闲休眠";
          bChip.style.color = "#10b981";
        } else {
          bChip.textContent = \`● 正在执行 (\${bState.status})\`;
          bChip.style.color = "#3b82f6";
        }
      }

      // 活跃账号与动作详情
      const liveAcc = document.getElementById("live-active-acc");
      if (liveAcc) liveAcc.textContent = bState.activeAccountName || primaryAcc.name || "无活跃任务";
      const liveAct = document.getElementById("live-browser-action");
      if (liveAct) liveAct.textContent = bState.currentAction || "无头浏览器处于空闲休眠状态 (0 进程占用)";

      // 容器内存监控
      const memPercentTag = document.getElementById("mem-percent-tag");
      if (memPercentTag) memPercentTag.textContent = \`\${mem.percent}% (\${mem.status === 'healthy' ? '健康' : '预警'})\`;
      const bmMemoryVal = document.getElementById("bm-memory-val");
      if (bmMemoryVal) bmMemoryVal.innerHTML = \`\${mem.usedMB} <span class="unit">MB / \${mem.limitMB} MB 限额</span>\`;
      const fillMemory = document.getElementById("fill-memory");
      if (fillMemory) fillMemory.style.width = \`\${mem.percent}%\`;

      // 峰值与待领抽屉
      const bmPeak = document.getElementById("bm-peak-claimable");
      if (bmPeak) bmPeak.textContent = \`峰值 \${mem.peakMB || 210} MB · 待领 \${primaryAcc.claimablePoints || 0} 分 (已收割)\`;`;

const newMonitorRender = `      // 运行大盘：无头浏览器实时态与容器内存渲染 (深度排版优化)
      const bState = data.browserState || {};
      const mem = bState.memory || { usedMB: 133, limitMB: 512, percent: 26, peakMB: 133, status: 'healthy' };
      const isBusy = !!data.isBusy || !!data.runningAccountId;
      const runningAccName = data.runningAccountName || (data.runningAccountId ? "执行中账号" : "");
      const currentTaskName = data.currentTaskName || "正在执行自动化流水线...";

      // 1. 顶部按钮状态机动态切换 (运行中变红色立即停止，空闲变绿色立即执行)
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

      // 2. Topbar 内存胶囊
      const topMemText = document.getElementById("topbar-mem-text");
      if (topMemText) topMemText.textContent = \`\${mem.usedMB} MB / \${mem.limitMB} MB\`;

      // 3. 状态徽章
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

      // 4. 当前执行账号与任务明细 (Block 1)
      const liveAcc = document.getElementById("live-active-acc");
      if (liveAcc) {
        liveAcc.textContent = isBusy ? \`👤 \${runningAccName}\` : "无活跃账号";
      }
      const liveTaskTitle = document.getElementById("live-task-name");
      if (liveTaskTitle) {
        liveTaskTitle.textContent = isBusy ? currentTaskName : "暂无活跃任务";
      }
      const liveAct = document.getElementById("live-browser-action");
      if (liveAct) {
        liveAct.textContent = isBusy ? (bState.currentAction || "正在执行中...") : "所有任务已完成，无头进程休眠释放";
      }

      // 5. 容器内存指标 (Block 2)
      const memCurMB = document.getElementById("mem-cur-mb");
      if (memCurMB) memCurMB.textContent = mem.usedMB || 133;
      const memPercentTag = document.getElementById("mem-percent-tag");
      if (memPercentTag) {
        memPercentTag.textContent = \`\${mem.percent || 26}% 健康\`;
      }
      const fillMemory = document.getElementById("fill-memory");
      if (fillMemory) fillMemory.style.width = \`\${mem.percent || 26}%\`;

      // 6. 峰值与待领抽屉 (Block 3)
      const memPeakMB = document.getElementById("mem-peak-mb");
      if (memPeakMB) memPeakMB.textContent = mem.peakMB || 133;
      const memClaimTxt = document.getElementById("mem-claim-txt");
      if (memClaimTxt) {
        const claimPts = primaryAcc.claimablePoints || 0;
        memClaimTxt.textContent = claimPts > 0 ? \`待领 \${claimPts} 分 (未收割)\` : "待领 0 分 (已归零)";
        memClaimTxt.style.color = claimPts > 0 ? "#f59e0b" : "#059669";
      }`;

content = content.replace(oldMonitorRender, newMonitorRender);

// 绑定 btnRunActive 点击支持立即停止
const oldBtnRunBinding = 'const btnRunActive = document.getElementById("btn-run-active-task");\n  if (btnRunActive) btnRunActive.addEventListener("click", openRunTasksModal);';

const newBtnRunBinding = `const btnRunActive = document.getElementById("btn-run-active-task");
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
  }`;

content = content.replace(oldBtnRunBinding, newBtnRunBinding);

fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js updated with clean monitor render and stop task trigger');
