import fs from 'fs';

let content = fs.readFileSync('src/web/public/index.html', 'utf8');

// 1. 移除侧边栏按钮
content = content.replace('<button class="sidebar-run-btn" id="btn-sidebar-run">▶ 立即启动该账号流水线</button>\n\n', '');

// 2. 增加针对多账号/单账号、全任务/单任务的启动模态框
const runModalHtml = `
  <!-- 模态框 4：启动任务选择器 (多账号/单账号，全任务/单任务) -->
  <div id="modal-run-tasks" class="modal-backdrop hidden">
    <div class="modal-card">
      <div class="modal-head">
        <h3 class="modal-h3">🚀 启动自动化任务</h3>
        <button class="modal-close-x" id="close-run-modal">&times;</button>
      </div>
      <form id="form-run-tasks">
        <div class="f-group">
          <label>执行账号范围</label>
          <div style="display: flex; gap: 14px; margin-top: 4px; font-size: 13px;">
            <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
              <input type="radio" name="run-acc-scope" value="all" checked> 全部已启用账号
            </label>
            <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
              <input type="radio" name="run-acc-scope" value="single"> 指定单个账号
            </label>
          </div>
        </div>

        <div class="f-group" id="group-single-account" style="display: none;">
          <label for="select-target-account">选择指定账号</label>
          <select id="select-target-account" class="f-select" style="padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; width: 100%; outline: none;">
            <!-- 动态生成账号选项 -->
          </select>
        </div>

        <div class="f-group">
          <label for="select-task-scope">任务执行范围</label>
          <select id="select-task-scope" class="f-select" style="padding: 9px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; width: 100%; outline: none;">
            <option value="all">⭐ 全量所有任务 (标准日常全套流水线)</option>
            <option value="search">🔍 仅必应 PC 拟人搜索 (跑满 60 积分)</option>
            <option value="dailySet">📅 仅每日活动集 (Daily Set 3/3 弹窗点击)</option>
            <option value="appSign">📱 仅必应移动端连续签到 (DAPI 直连)</option>
            <option value="newsRead">📖 仅移动端新闻资讯阅读 (30 积分)</option>
            <option value="puzzle">🧩 仅每日拼图通关 (Evergreen Puzzle)</option>
            <option value="quests">🎯 仅多步任务打孔卡 (Punch Cards)</option>
            <option value="harvest">🌙 仅额外积分抽屉收割 (React Aria 虚拟指针)</option>
          </select>
        </div>

        <div class="modal-foot">
          <button type="button" class="btn-cancel" id="cancel-run-modal">取消</button>
          <button type="submit" class="btn-confirm-orange" style="background: linear-gradient(135deg, #10b981, #059669);">▶ 确认启动执行</button>
        </div>
      </form>
    </div>
  </div>
`;

if (!content.includes('modal-run-tasks')) {
  content = content.replace('  <script src="app.js"></script>', runModalHtml + '\n  <script src="app.js"></script>');
  fs.writeFileSync('src/web/public/index.html', content, 'utf8');
  console.log('index.html updated with run modal');
} else {
  console.log('run modal already exists');
}
