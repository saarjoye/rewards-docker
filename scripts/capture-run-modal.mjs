import { createServer } from '../src/web/server.js';
import browserManager from '../src/browser/browser.js';
import http from 'http';

async function captureModal() {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await browserManager.withBrowser({ headless: true }, async (browser, context) => {
    const page = await context.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1500));

    // 点击右上角 立即执行任务 唤起任务选择弹窗
    const btn = await page.$('#btn-run-active-task');
    if (btn) await btn.click();
    await new Promise((r) => setTimeout(r, 800));

    await page.screenshot({ path: 'data/webui_run_tasks_modal.png' });
    console.log('Saved data/webui_run_tasks_modal.png');
  });

  server.close();
}

captureModal().catch(console.error);
