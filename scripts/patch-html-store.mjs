import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

const oldStoreHead = `<div class="box-header">
            <h2 class="box-title">托管账号池</h2>
            <span class="arrow-btn" id="btn-stores-all">↗</span>
          </div>`;

const newStoreHead = `<div class="box-header">
            <div>
              <h2 class="box-title">托管账号池</h2>
              <span class="box-sub">点击卡片直达单账号视图</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <button class="chip-sm" id="btn-toggle-all-pool" style="cursor: pointer; border: 1px solid #cbd5e1;">🌐 全部合计</button>
              <span class="arrow-btn" id="btn-stores-all">↗</span>
            </div>
          </div>`;

content = content.replace(oldStoreHead, newStoreHead);
fs.writeFileSync('src/web/public/index.html', content, 'utf8');
console.log('index.html store header updated');
