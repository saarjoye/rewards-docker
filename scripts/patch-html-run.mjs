import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

// 1. 在 Topbar 显眼处增加「🚀 立即执行任务」大按钮 (位于「+ 添加账号」左侧)
const oldTopActions = '<button class="btn-primary-orange" id="btn-add-account">+ 添加账号</button>';
const newTopActions = '<button class="btn-run-tasks-emerald" id="btn-run-active-task">🚀 立即执行任务</button>\n          <button class="btn-primary-orange" id="btn-add-account">+ 添加账号</button>';
content = content.replace(oldTopActions, newTopActions);

// 2. 在左侧侧边栏账号卡片下方增加「▶ 立即启动当前账号」快捷按钮
const oldStoreSelector = '</div>\n\n        <nav class="sidebar-menu">';
const newStoreSelector = `</div>
        <button class="sidebar-run-btn" id="btn-sidebar-run">▶ 立即启动该账号流水线</button>

        <nav class="sidebar-menu">`;
content = content.replace(oldStoreSelector, newStoreSelector);

// 3. 在右下角错峰调度卡片内增加「⚡ 立即触发当前时段」
const oldSlotCountdown = '<span class="countdown-text" id="slot-countdown-text">下次随机唤醒约 25 分钟后</span>\n            </div>';
const newSlotCountdown = `<span class="countdown-text" id="slot-countdown-text">下次随机唤醒约 25 分钟后</span>
              <button class="btn-trigger-slot-sm" id="btn-trigger-slot">⚡ 立即触发当前时段</button>
            </div>`;
content = content.replace(oldSlotCountdown, newSlotCountdown);

fs.writeFileSync('src/web/public/index.html', content, 'utf8');
console.log('index.html updated with prominent run buttons');
