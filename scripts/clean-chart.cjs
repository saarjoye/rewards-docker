const fs = require('fs');

let s = fs.readFileSync('src/web/public/app.js', 'utf8');

const oldChart = s.slice(s.indexOf('  function renderChartBars'), s.indexOf('  function renderAccountsList'));

const cleanChart = `  function renderChartBars(todayPoints) {
    if (!chartBars) return;
    const activeAccs = accounts.length > 0 ? accounts : [{ name: "默认账号", todayEarned: todayPoints || 93 }];

    const todayBreakdownRows = activeAccs.map((a) => (
      \`<div class="tooltip-account-row">
        <span class="acc-name">\${escapeHtml(a.name || a.user)}</span>
        <b class="acc-pts">+\${a.todayEarned || 0}分</b>
      </div>\`
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
        \`<div class="tooltip-account-row">
          <span class="acc-name">\${escapeHtml(b.name)}</span>
          <b class="acc-pts">+\${b.pts}分</b>
        </div>\`
      )).join("");

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
              <div class="tooltip-breakdown-list">\${breakdownHtml}</div>
            </div>
          </div>
          <span class="bar-date-label">\${d.active ? '今日' : d.label}</span>
        </div>
      \`;
    }).join("");
  }

`;

s = s.replace(oldChart, cleanChart);
fs.writeFileSync('src/web/public/app.js', s, 'utf8');
console.log('Chart function replaced with template literals');
