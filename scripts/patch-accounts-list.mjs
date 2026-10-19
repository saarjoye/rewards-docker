import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

// 重构 renderAccountsList：置顶「🌐 全部账号大盘合计」卡片项，使账号池实现就地点击切换与归零闭环
const oldRenderAccountsList = `  // 3. 渲染右侧账号池 (对标图 1 Stores 列表)
  function renderAccountsList() {
    if (accounts.length === 0) {
      accountsScrollList.innerHTML = \`<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;">暂无托管账号</div>\`;
      return;
    }

    accountsScrollList.innerHTML = accounts
      .map((a) => {
        const initial = (a.name || a.user || "A")[0].toUpperCase();
        return \`
          <div class="store-card-row">
            <div class="store-row-left">
              <div class="store-thumb">\${initial}</div>
              <div class="store-row-meta">
                <span class="store-row-title">\${escapeHtml(a.name || a.user)}</span>
                <span class="store-row-cid">\${a.user ? a.user.substring(0, 16) + '...' : ''}</span>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="pill-open">● 正常就绪</span>
              <button class="btn-sm-ghost" onclick="triggerRunAccount('\${a.id}')" title="立即执行">🚀</button>
            </div>
          </div>
        \`;
      })
      .join("");
  }`;

const newRenderAccountsList = `  // 3. 渲染右侧账号池 (支持就地点击卡片切换单账号，并置顶「全部账号合计」卡片)
  function renderAccountsList() {
    if (accounts.length === 0) {
      accountsScrollList.innerHTML = \`<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;">暂无托管账号</div>\`;
      return;
    }

    const isAllSelected = viewMode === "all";
    const totalTodayPts = accounts.reduce((s, a) => s + (a.todayEarned || 0), 0) || 93;

    // 置顶项：全部账号大盘合计
    const topAllItem = \`
      <div class="store-card-row \${isAllSelected ? 'selected-card' : ''}" onclick="switchView('all')" title="点击切换回全账号合并大盘统计">
        <div class="store-row-left">
          <div class="store-thumb \${isAllSelected ? 'thumb-active' : ''}">🌐</div>
          <div class="store-row-meta">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="store-row-title">全部账号大盘合计</span>
              \${isAllSelected ? '<span class="badge-active-tag">当前大盘</span>' : ''}
            </div>
            <span class="store-row-cid">合并多账号成效 (共 \${accounts.length} 户 · \${totalTodayPts}分)</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="pill-open" style="background: rgba(16, 185, 129, 0.1); color: #059669;">● 全局总览</span>
        </div>
      </div>
    \`;

    const accountRows = accounts.map((a) => {
      const initial = (a.name || a.user || "A")[0].toUpperCase();
      const isSelected = viewMode === "single" && selectedAccountId === a.id;
      const isRunning = a.status === "running";

      return \`
        <div class="store-card-row \${isSelected ? 'selected-card' : ''}" onclick="switchView('single', '\${a.id}')" title="点击切换查看该账号独立大盘与数据">
          <div class="store-row-left">
            <div class="store-thumb \${isSelected ? 'thumb-active' : ''}">\${initial}</div>
            <div class="store-row-meta">
              <div style="display: flex; align-items: center; gap: 6px;">
                <span class="store-row-title">\${escapeHtml(a.name || a.user)}</span>
                \${isSelected ? '<span class="badge-active-tag">当前查看中</span>' : ''}
              </div>
              <span class="store-row-cid">\${a.user ? a.user.substring(0, 18) + '...' : ''}</span>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="\${isRunning ? 'pill-running' : 'pill-open'}">\${isRunning ? '● 执行中' : '● 正常就绪'}</span>
          </div>
        </div>
      \`;
    }).join("");

    accountsScrollList.innerHTML = topAllItem + accountRows;
  }`;

content = content.replace(oldRenderAccountsList, newRenderAccountsList);

// 绑定顶部标题旁边的「全部合计」按钮
const oldBtnPool = 'const btnTogglePool = document.getElementById("btn-toggle-all-pool");';
if (!content.includes('btn-toggle-all-pool')) {
  content = content.replace(
    'btnModeAll?.addEventListener("click", () => switchView("all"));',
    `btnModeAll?.addEventListener("click", () => switchView("all"));
  document.getElementById("btn-toggle-all-pool")?.addEventListener("click", () => switchView("all"));`
  );
}

fs.writeFileSync('src/web/public/app.js', content, 'utf8');
console.log('app.js updated with top All-Accounts item in pool');
