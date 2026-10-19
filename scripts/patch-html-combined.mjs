import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

const combinedCard = `        <!-- 第 3 行右侧：错峰调度时钟与实时视口二合一板块 (方案 1 + 方案 2) -->
        <section class="bento-box box-timeline-screencast">
          <div class="box-header">
            <div>
              <h2 class="box-title">调度时钟与实时视口</h2>
              <span class="box-sub">Scheduler Timeline & Live Screencast</span>
            </div>
            <div class="box-header-ctrls">
              <span class="chip-sm active-slot-chip" id="current-slot-chip">● 午后批次</span>
            </div>
          </div>

          <!-- 方案 1：全天错峰时钟与时段胶囊 (上部) -->
          <div class="scheduler-strip-wrap">
            <div class="slots-pill-row">
              <div class="slot-pill" data-slot="morning">09-13<span class="slot-sub">早间</span></div>
              <div class="slot-pill active" data-slot="afternoon">13-17<span class="slot-sub">午后</span></div>
              <div class="slot-pill" data-slot="evening">17-21<span class="slot-sub">傍晚</span></div>
              <div class="slot-pill" data-slot="night">21-01<span class="slot-sub">夜间</span></div>
              <div class="slot-pill harvest-pill" data-slot="harvest">01:00<span class="slot-sub">收割</span></div>
            </div>
            <div class="slot-countdown-row">
              <span class="countdown-label">当前时段运行中</span>
              <span class="countdown-text" id="slot-countdown-text">下次随机唤醒约 25 分钟后</span>
            </div>
          </div>

          <!-- 方案 2：无头浏览器真实微缩视口截屏 (下部) -->
          <div class="screencast-wrapper" id="screencast-box">
            <div class="screencast-fake-nav">
              <span class="nav-dots"><i></i><i></i><i></i></span>
              <span class="nav-url-pill">🔒 rewards.bing.com/dashboard</span>
              <span class="live-screencast-badge">● LIVE 1440x900</span>
            </div>
            <div class="screencast-img-container">
              <img id="live-screencast-img" src="/api/browser/screenshot" alt="实时无头视口">
            </div>
          </div>
        </section>`;

if (!content.includes('box-timeline-screencast')) {
  // 插在 box-top-tasks 的闭合标签后
  const target = '</section>\n      </div>\n    </main>';
  content = content.replace(target, '</section>\n\n' + combinedCard + '\n      </div>\n    </main>');
  fs.writeFileSync('src/web/public/index.html', content, 'utf8');
  console.log('index.html combined card added successfully');
} else {
  console.log('combined card already exists');
}
