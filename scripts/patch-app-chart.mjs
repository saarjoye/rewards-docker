import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

const oldChartFn = `  // 2. 渲染条形图 (对标图 1 Total Revenue，高亮今日橙色柱并带黑色气泡)
  function renderChartBars(todayPoints) {
    const days = [
      { label: "10/14", val: 65 },
      { label: "10/15", val: 80 },
      { label: "10/16", val: 55 },
      { label: "10/17", val: 90 },
      { label: "10/18", val: 70 },
      { label: "10/19", val: todayPoints || 93, active: true }
    ];

    const maxVal = 120;
    chartBars.innerHTML = days
      .map((d) => {
        const heightPct = Math.min(90, Math.max(15, Math.round((d.val / maxVal) * 85)));
        if (d.active) {
          return \`
            <div class="bar-col active">
              <div class="bar-pillar" style="height: \${heightPct}%;">
                <div class="chart-tooltip-capsule">
                  <span class="tooltip-dot"></span>
                  <span>+\${d.val}.00 分</span>
                </div>
              </div>
              <span class="bar-date-label">今日</span>
            </div>
          \`;
        }
        return \`
          <div class="bar-col">
            <div class="bar-pillar" style="height: \${heightPct}%;"></div>
            <span class="bar-date-label">\${d.label}</span>
          </div>
        \`;
      })
      .join("");
  }`;

const newChartFn = `  // 2. 渲染条形图 (对标图 1 Total Revenue：鼠标悬停任意柱子，显示各账号分值明细)
  function renderChartBars(todayPoints) {
    const activeAccs = accounts.length > 0 ? accounts : [{ name: "默认账号", todayEarned: todayPoints || 93 }];

    // 今日真实各账号分值明细
    const todayBreakdownRows = activeAccs.map((a) => \`
      <div class="tooltip-account-row">
        <span class="acc-name">\${escapeHtml(a.name || a.user)}</span>
        <b class="acc-pts">+\${a.todayEarned || 0}分</b>
      </div>
    \`).join("");

    const days = [
      { label: "10/14", val: 65, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(65 / activeAccs.length) })) },
      { label: "10/15", val: 80, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(80 / activeAccs.length) })) },
      { label: "10/16", val: 55, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(55 / activeAccs.length) })) },
      { label: "10/17", val: 90, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(90 / activeAccs.length) })) },
      { label: "10/18", val: 70, breakdown: activeAccs.map((a) => ({ name: a.name || a.user, pts: Math.round(70 / activeAccs.length) })) },
      { label: "10/19", val: todayPoints || 93, active: true, breakdownRows: todayBreakdownRows }
    ];

    const maxVal = Math.max(120, ...days.map((d) => d.val));
    chartBars.innerHTML = days
      .map((d) => {
        const heightPct = Math.min(90, Math.max(15, Math.round((d.val / maxVal) * 85)));
        const breakdownHtml = d.breakdownRows || (d.breakdown || []).map((b) => \`
          <div class="tooltip-account-row">
            <span class="acc-name">\${escapeHtml(b.name)}</span>
            <b class="acc-pts">+\${b.pts}分</b>
          </div>
        \`).join("");

        return \`
          <div class="bar-col \${d.active ? 'active' : ''}">
            <div class="bar-pillar" style="height: \${heightPct}%;">
              <div class="chart-tooltip-capsule">
                <div class="tooltip-title-row">
                  <span style="display: flex; align-items: center; gap: 5px;">
                    <span class="tooltip-dot"></span>
                    <span>\${d.active ? '今日合计' : d.label}</span>
                  </span>
                  <span>+\${d.val}分</span>
                </div>
                <div class="tooltip-divider"></div>
                <div class="tooltip-breakdown-list">
                  \${breakdownHtml}
                </div>
              </div>
            </div>
            <span class="bar-date-label">\${d.active ? '今日' : d.label}</span>
          </div>
        \`;
      })
      .join("");
  }`;

content = content.replace(oldChartFn, newChartFn);
fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js updated with per-account chart breakdown tooltip');
