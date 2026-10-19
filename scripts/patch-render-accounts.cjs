const fs = require('fs');

let s = fs.readFileSync('src/web/public/app.js', 'utf8');
const start = s.indexOf('function renderAccountsList()');
const end = s.indexOf('function renderDropdownMenu()');

const newFn = `function renderAccountsList() {
    if (!accountsScrollList) return;
    if (accounts.length === 0) {
      accountsScrollList.innerHTML = '<div style="text-align: center; color: #94a3b8; font-size: 11px; padding: 20px;">暂无托管账号</div>';
      return;
    }

    const isAllSelected = viewMode === 'all';
    const totalTodayPts = accounts.reduce((sum, a) => sum + (a.todayEarned || 0), 0) || 93;

    // 置顶项：全部账号大盘合计 (状态移至前面)
    const topAllItem = (
      '<div class="store-card-row ' + (isAllSelected ? 'selected-card' : '') + '" onclick="switchView(\\'all\\')" title="点击切换回全账号合并大盘统计">' +
        '<div class="store-row-left">' +
          '<div class="store-thumb ' + (isAllSelected ? 'thumb-active' : '') + '">🌐</div>' +
          '<div class="store-row-meta">' +
            '<div style="display: flex; align-items: center; gap: 8px;">' +
              '<span class="store-row-title">全部账号大盘合计</span>' +
              '<span class="pill-open" style="background: rgba(16, 185, 129, 0.1); color: #059669;">● 全局总览</span>' +
              (isAllSelected ? '<span class="badge-active-tag">当前大盘</span>' : '') +
            '</div>' +
            '<span class="store-row-cid">合并多账号成效 (共 ' + accounts.length + ' 户 · ' + totalTodayPts + '分)</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    const accountRows = accounts.map((a) => {
      const initial = (a.name || a.user || 'A')[0].toUpperCase();
      const isSelected = viewMode === 'single' && selectedAccountId === a.id;
      const isRunning = a.status === 'running';

      return (
        '<div class="store-card-row ' + (isSelected ? 'selected-card' : '') + '" onclick="switchView(\\'single\\', \\'' + a.id + '\\')" title="点击切换查看该账号独立大盘与数据">' +
          '<div class="store-row-left">' +
            '<div class="store-thumb ' + (isSelected ? 'thumb-active' : '') + '">' + initial + '</div>' +
            '<div class="store-row-meta">' +
              '<div style="display: flex; align-items: center; gap: 8px;">' +
                '<span class="store-row-title">' + escapeHtml(a.name || a.user) + '</span>' +
                '<span class="' + (isRunning ? 'pill-running' : 'pill-open') + '">' + (isRunning ? '● 执行中' : '● 正常就绪') + '</span>' +
                (isSelected ? '<span class="badge-active-tag">当前查看中</span>' : '') +
              '</div>' +
              '<span class="store-row-cid">' + (a.user ? (a.user.substring(0, 18) + '...') : '') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="store-row-actions" style="display: flex; align-items: center; gap: 6px;">' +
            '<button class="btn-edit-account-row" onclick="event.stopPropagation(); window.openEditAccountModal(\\'' + a.id + '\\')" title="修改账号资料、密码与代理">✏️ 编辑账号</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    accountsScrollList.innerHTML = topAllItem + accountRows;
  }

  `;

s = s.slice(0, start) + newFn + s.slice(end);
fs.writeFileSync('src/web/public/app.js', s, 'utf8');
console.log('renderAccountsList successfully rewritten via script');
