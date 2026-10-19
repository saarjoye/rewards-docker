import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

// 1. 在 Topbar 增加实时内存药丸
const oldTopbarPill = '<div class="pill-btn status-pill"><span class="pulse-dot"></span> 错峰调度: 运行中</div>';
const newTopbarPills = '<div class="pill-btn status-pill"><span class="pulse-dot"></span> 错峰调度: 运行中</div>\n          <div class="pill-btn mem-pill" id="topbar-mem-pill">⚡ 内存: <span id="topbar-mem-text">142 MB / 512 MB</span></div>';
content = content.replace(oldTopbarPill, newTopbarPills);

// 2. 替换 box-business 为内核实时态与容器内存大盘
const oldBoxBusiness = `<section class="bento-box box-business">
          <div class="box-header">
            <h2 class="box-title">运行大盘</h2>
            <div class="box-header-ctrls">
              <span class="chip-sm">本周 ▾</span>
            </div>
          </div>
          <div class="business-metrics-stack">
            <div class="b-metric-item soft-purple">
              <div class="b-item-label">活跃托管账号 ↗</div>
              <div class="b-item-val" id="bm-accounts">1 <span class="unit">户</span></div>
            </div>
            <div class="b-metric-item soft-cream">
              <div class="b-item-label">今日执行任务 ↗</div>
              <div class="b-item-val" id="bm-tasks">5 <span class="unit">项</span></div>
            </div>
            <div class="b-metric-item soft-green">
              <div class="b-item-label">待领抽屉积分 ↗</div>
              <div class="b-item-val" id="bm-claimable">0 <span class="unit">分 (已收割)</span></div>
            </div>
          </div>
        </section>`;

const newBoxBusiness = `<section class="bento-box box-business">
          <div class="box-header">
            <div>
              <h2 class="box-title">内核与内存大盘</h2>
              <span class="box-sub">Browser Live & Container Memory</span>
            </div>
            <div class="box-header-ctrls">
              <span class="chip-sm" id="browser-status-chip">● 空闲待机</span>
            </div>
          </div>
          <div class="business-metrics-stack">
            <!-- 浏览器实时动作 -->
            <div class="b-metric-item soft-purple">
              <div class="b-item-header-row">
                <span class="b-item-label">无头浏览器实时状态 ↗</span>
                <span class="b-sub-tag" id="live-active-acc">无活跃任务</span>
              </div>
              <div class="b-item-action-text" id="live-browser-action">无头浏览器处于空闲休眠状态 (0 进程占用)</div>
            </div>

            <!-- 容器内存实时监控 -->
            <div class="b-metric-item soft-cream">
              <div class="b-item-header-row">
                <span class="b-item-label">容器内存实时占用 ↗</span>
                <span class="b-sub-tag" id="mem-percent-tag">28% (健康)</span>
              </div>
              <div class="b-item-val" id="bm-memory-val">142 <span class="unit">MB / 512 MB 限额</span></div>
              <div class="striped-progress-bar bar-purple" style="height: 10px; margin-top: 6px;">
                <div class="striped-fill" id="fill-memory" style="width: 28%;"></div>
              </div>
            </div>

            <!-- 运行指标与峰值 -->
            <div class="b-metric-item soft-green">
              <div class="b-item-header-row">
                <span class="b-item-label">峰值水位与抽屉状态 ↗</span>
                <span class="b-sub-tag">压制在 &lt; 300MB</span>
              </div>
              <div class="b-item-val" id="bm-peak-claimable">峰值 210 MB · 待领 0 分 (已收割)</div>
            </div>
          </div>
        </section>`;

content = content.replace(oldBoxBusiness, newBoxBusiness);
fs.writeFileSync('src/web/public/index.html', content, 'utf8');
console.log('index.html updated successfully');
