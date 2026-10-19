import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

// 替换整个 box-business 结构
const oldBox = `<section class="bento-box box-business">
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

const newBox = `<section class="bento-box box-business">
          <div class="box-header">
            <div>
              <h2 class="box-title">内核与内存大盘</h2>
              <span class="box-sub">实时运行监控与资源开销</span>
            </div>
            <div class="box-header-ctrls">
              <span class="chip-sm chip-status-pill" id="browser-status-chip">● 空闲待命</span>
            </div>
          </div>
          <div class="business-metrics-stack">
            <!-- 1. 当前执行账号与任务 -->
            <div class="b-metric-item soft-purple">
              <div class="b-item-header-row">
                <span class="b-item-label">正在执行任务 ↗</span>
                <span class="b-sub-tag" id="live-active-acc">无活跃账号</span>
              </div>
              <div class="b-item-clean-title" id="live-task-name">空闲待机中</div>
              <div class="b-item-clean-sub" id="live-browser-action">所有任务已完成，无头进程休眠释放</div>
            </div>

            <!-- 2. 容器内存实时监控 (杜绝折行) -->
            <div class="b-metric-item soft-cream">
              <div class="b-item-header-row">
                <span class="b-item-label">容器内存 (512MB限额) ↗</span>
                <span class="b-sub-tag tag-healthy" id="mem-percent-tag">26% 健康</span>
              </div>
              <div class="b-item-clean-val">
                <span class="big-num" id="mem-cur-mb">133</span>
                <span class="unit-txt">MB</span>
                <span class="dim-txt">/ 512 MB 限额</span>
              </div>
              <div class="striped-progress-bar bar-purple" style="height: 8px; margin-top: 6px;">
                <div class="striped-fill" id="fill-memory" style="width: 26%;"></div>
              </div>
            </div>

            <!-- 3. 峰值与待领抽屉 (单行工整) -->
            <div class="b-metric-item soft-green">
              <div class="b-item-header-row">
                <span class="b-item-label">历史峰值与待领积分 ↗</span>
                <span class="b-sub-tag">上限 &lt; 300MB</span>
              </div>
              <div class="b-item-clean-val">
                <span class="big-num" id="mem-peak-mb">133</span>
                <span class="unit-txt">MB 峰值</span>
                <span class="sep-dot">·</span>
                <span class="claim-tag-green" id="mem-claim-txt">待领 0 分 (已归零)</span>
              </div>
            </div>
          </div>
        </section>`;

content = content.replace(oldBox, newBox);
fs.writeFileSync('src/web/public/index.html', content, 'utf8');
console.log('index.html box-business updated with clean non-wrapping structure');
