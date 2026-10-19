import { createServer } from '../src/web/server.js';
import browserManager from '../src/browser/browser.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import http from 'http';

async function captureCards() {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  configManager.setAdminCredentials('admin', 'salt', 'hash');
  const secret = configManager.ensureAdminSessionSecret();
  const token = createAdminSessionToken('admin', secret);

  await browserManager.withBrowser({ headless: true }, async (browser, context) => {
    const page = await context.newPage({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      {
        name: getAdminSessionCookieName(),
        value: token,
        domain: '127.0.0.1',
        path: '/'
      }
    ]);

    // 1. 空闲态截图
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: 'data/webui_optimized_card_idle.png' });
    console.log('Saved data/webui_optimized_card_idle.png');

    // 2. 模拟运行态截图：设置状态为 running
    await page.evaluate(() => {
      // 模拟接收到后端 running 状态
      const btn = document.getElementById("btn-run-active-task");
      if (btn) {
        btn.className = "btn-stop-tasks-red";
        btn.innerHTML = "🛑 立即停止任务";
      }
      const bChip = document.getElementById("browser-status-chip");
      if (bChip) {
        bChip.textContent = "● 运行中";
        bChip.style.color = "#3b82f6";
        bChip.style.background = "#eff6ff";
      }
      const liveAcc = document.getElementById("live-active-acc");
      if (liveAcc) liveAcc.textContent = "👤 桂林 (test_user)";
      const liveTaskTitle = document.getElementById("live-task-name");
      if (liveTaskTitle) liveTaskTitle.textContent = "必应 PC 拟人搜索 (第 4/30 轮)";
      const liveAct = document.getElementById("live-browser-action");
      if (liveAct) liveAct.textContent = "正在模拟真人键入热搜词: \"2026年最新前沿科技趋势\" (驻留中...)";
    });

    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: 'data/webui_optimized_card_running.png' });
    console.log('Saved data/webui_optimized_card_running.png');
  });

  server.close();
}

captureCards().catch(console.error);
