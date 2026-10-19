const fs = require('fs');

let html = fs.readFileSync('src/web/public/index.html', 'utf8');

// 1. 官网同步模态框增加「▶ 开始同步」按钮 (对标 Fix 4)
const oldSyncFoot = `<div class="modal-foot" style="justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button type="button" class="btn-cancel" id="btn-sync-bg">后台运行</button>
        <button type="button" class="btn-primary-blue" id="btn-sync-close">关闭</button>
      </div>`;

const newSyncFoot = `<div class="modal-foot" style="justify-content: flex-end; gap: 10px; margin-top: 20px;">
        <button type="button" class="btn-primary-blue" id="btn-start-sync-action" style="background: linear-gradient(135deg, #0284c7, #0369a1); font-weight: 700;">▶ 开始同步</button>
        <button type="button" class="btn-cancel" id="btn-sync-bg" style="display: none;">后台运行</button>
        <button type="button" class="btn-cancel" id="btn-sync-close">关闭</button>
      </div>`;

html = html.replace(oldSyncFoot, newSyncFoot);

// 2. 健康体检模态框在红框位置增加「▶ 开始检测」按钮 (对标 Fix 3)
const oldHealthFoot = `<div class="modal-foot" style="justify-content: flex-end; gap: 10px; margin-top: 18px;">
        <button type="button" class="btn-cancel" id="btn-re-check">🔄 重新检测</button>
        <button type="button" class="btn-primary-blue" id="btn-health-confirm">确定</button>
      </div>`;

const newHealthFoot = `<div class="modal-foot" style="justify-content: flex-end; gap: 10px; margin-top: 18px;">
        <button type="button" class="btn-primary-blue" id="btn-start-health-check" style="background: linear-gradient(135deg, #0284c7, #0369a1); font-weight: 700;">▶ 开始检测</button>
        <button type="button" class="btn-cancel" id="btn-re-check" style="display: none;">🔄 重新检测</button>
        <button type="button" class="btn-cancel" id="btn-health-confirm">关闭</button>
      </div>`;

html = html.replace(oldHealthFoot, newHealthFoot);

// 3. 在 Tab 1 账号与凭证内增加当前账号的独立资料与代理编辑卡片
const oldAccountPane = `<div class="cfg-pane" id="pane-cfg-account">
        <div class="cfg-section-title">切换当前编辑的账号</div>
        <div style="display: flex; gap: 10px; margin-bottom: 16px;">
          <select id="cfg-select-acc" class="f-select" style="flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1;">
            <!-- 动态填充 -->
          </select>
          <button type="button" class="btn-sm-ghost" id="cfg-btn-refresh-accs">刷新列表</button>
        </div>

        <!-- 嵌入图 6「拟人化错峰时段设定」 -->
        <div class="cfg-card-box" style="margin-top: 14px;">
          <div class="cfg-box-title">⏰ 拟人化错峰时段设定 (4小时时间窗)</div>
          <div class="peak-slots-grid">
            <button type="button" class="slot-select-btn active">🌅 09:00 - 13:00 (上午)</button>
            <button type="button" class="slot-select-btn active">☀️ 13:00 - 17:00 (下午)</button>
            <button type="button" class="slot-select-btn active">☕ 17:00 - 21:00 (傍晚)</button>
            <button type="button" class="slot-select-btn active">🌙 21:00 - 次日 01:00 (夜间)</button>
            <button type="button" class="slot-select-btn">✏️ 自定义时间</button>
          </div>
          <div class="cfg-tip-txt" style="margin-top: 8px;">
            区间内 0~60 分钟随机启动，PC 搜索将在 2 小时内平缓分散执行，彻底模拟真人上网作息。
          </div>
        </div>
      </div>`;

const newAccountPane = `<div class="cfg-pane" id="pane-cfg-account">
        <div class="cfg-section-title">切换当前编辑的账号</div>
        <div style="display: flex; gap: 10px; margin-bottom: 14px;">
          <select id="cfg-select-acc" class="f-select" style="flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1;">
            <!-- 动态填充 -->
          </select>
          <button type="button" class="btn-sm-ghost" id="cfg-btn-edit-selected-acc">编辑此账号资料</button>
        </div>

        <!-- 嵌入图 6「拟人化错峰时段设定」 -->
        <div class="cfg-card-box" style="margin-bottom: 14px;">
          <div class="cfg-box-title">⏰ 拟人化错峰时段设定 (4小时时间窗)</div>
          <div class="peak-slots-grid">
            <button type="button" class="slot-select-btn active">🌅 09:00 - 13:00 (上午)</button>
            <button type="button" class="slot-select-btn active">☀️ 13:00 - 17:00 (下午)</button>
            <button type="button" class="slot-select-btn active">☕ 17:00 - 21:00 (傍晚)</button>
            <button type="button" class="slot-select-btn active">🌙 21:00 - 次日 01:00 (夜间)</button>
            <button type="button" class="slot-select-btn">✏️ 自定义时间</button>
          </div>
          <div class="cfg-tip-txt" style="margin-top: 8px;">
            区间内 0~60 分钟随机启动，PC 搜索将在 2 小时内平缓分散执行，彻底模拟真人上网作息。
          </div>
        </div>

        <!-- 当前账号专属凭据与网络快速配置 -->
        <div class="cfg-card-box">
          <div class="cfg-box-title">🌐 当前账号独立网络代理与状态</div>
          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-top: 8px;">
            <div class="f-group" style="margin-bottom: 0;">
              <label>专属代理地址</label>
              <input type="text" id="cfg-acc-inline-proxy" placeholder="如 http://127.0.0.1:7890 (留空使用全局)">
            </div>
            <div class="f-group" style="margin-bottom: 0;">
              <label>启用状态</label>
              <select id="cfg-acc-inline-enabled" class="f-select" style="padding: 9px; border-radius: 8px; border: 1px solid #cbd5e1;">
                <option value="true">✅ 已启用调度</option>
                <option value="false">⏸️ 暂停调度</option>
              </select>
            </div>
          </div>
          <div class="cfg-tip-txt" style="margin-top: 8px;">
            💡 更多全局网络锁、任务开关、搜索基础退避与消息推送，请切换上方对应标签页进行深度设置。
          </div>
        </div>
      </div>`;

html = html.replace(oldAccountPane, newAccountPane);

fs.writeFileSync('src/web/public/index.html', html, 'utf8');
console.log('index.html updated with start sync, start health, and enhanced account pane');
