import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

const oldEnd = `      renderTopTasks();
      renderChartBars(today);`;

const newEnd = `      renderTopTasks();
      renderChartBars(today);

      // 更新错峰时段高亮
      const nowH = new Date().getHours();
      let slotName = '午后批次';
      let slotKey = 'afternoon';
      if (nowH >= 9 && nowH < 13) { slotName = '早间批次'; slotKey = 'morning'; }
      else if (nowH >= 13 && nowH < 17) { slotName = '午后批次'; slotKey = 'afternoon'; }
      else if (nowH >= 17 && nowH < 21) { slotName = '傍晚批次'; slotKey = 'evening'; }
      else if (nowH >= 21 || nowH < 1) { slotName = '夜间批次'; slotKey = 'night'; }
      else { slotName = '收割静默期'; slotKey = 'harvest'; }

      const slotChip = document.getElementById("current-slot-chip");
      if (slotChip) slotChip.textContent = \`● \${slotName}\`;

      document.querySelectorAll(".slot-pill").forEach((p) => {
        p.classList.toggle("active", p.getAttribute("data-slot") === slotKey);
      });

      // 实时视口微缩画面刷新
      const liveImg = document.getElementById("live-screencast-img");
      if (liveImg) {
        liveImg.src = \`/api/browser/screenshot?_t=\${Date.now()}\`;
      }`;

content = content.replace(oldEnd, newEnd);
fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js updated with slot & screencast logic');
