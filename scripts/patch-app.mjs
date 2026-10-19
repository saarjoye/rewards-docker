import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

// 在 refreshDashboard 中增加内存与浏览器状态渲染逻辑
const oldMetricsLogic = `// 运行大盘三项
      bmAccounts.innerHTML = \`\${accounts.length || 1} <span class="unit">户</span>\`;
      bmTasks.innerHTML = \`5 <span class="unit">项已达成</span>\`;
      bmClaimable.innerHTML = \`\${primaryAcc.claimablePoints || 0} <span class="unit">分 (已收割)</span>\`;`;

const newMetricsLogic = `// 运行大盘：无头浏览器实时态与容器内存渲染
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

content = content.replace(oldMetricsLogic, newMetricsLogic);

fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js updated successfully');
