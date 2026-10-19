const fs = require('fs');

let html = fs.readFileSync('src/web/public/index.html', 'utf8');

const oldBanner = `<div class="health-summary-banner" id="health-summary-banner">
        <div class="health-status-circle green" id="health-status-icon"></div>
        <div>
          <div class="health-summary-title" id="health-summary-title">诊断检测通过</div>
          <div class="health-summary-sub" id="health-summary-sub">账号已具备全部任务执行所需凭据，状态正常良好</div>
        </div>
      </div>`;

const newBanner = `<div class="health-summary-banner" id="health-summary-banner" style="background: #f8fafc; border-color: #e2e8f0;">
        <div class="health-status-circle" id="health-status-icon" style="background: #94a3b8;"></div>
        <div>
          <div class="health-summary-title" id="health-summary-title" style="color: #475569;">等待开始检测</div>
          <div class="health-summary-sub" id="health-summary-sub">请确认体检范围后点击下方「▶ 开始检测」按钮 (避免误触占用账号锁)</div>
        </div>
      </div>`;

html = html.replace(oldBanner, newBanner);
fs.writeFileSync('src/web/public/index.html', html, 'utf8');
console.log('index.html health check initial banner set to waiting state');
