import { createServer } from '../src/web/server.js';
import browserManager from '../src/browser/browser.js';
import http from 'http';

async function captureTotals() {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await browserManager.withBrowser({ headless: true }, async (browser, context) => {
    const page = await context.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1500));

    // 截图 1：全账号大盘合计视图
    await page.screenshot({ path: 'data/webui_view_all_totals.png' });
    console.log('Saved data/webui_view_all_totals.png');

    // 展开侧边栏下拉菜单
    const selector = await page.$('#account-quick-select');
    if (selector) await selector.click();
    await new Promise((r) => setTimeout(r, 600));

    // 截图 2：下拉菜单展开态
    await page.screenshot({ path: 'data/webui_dropdown_open.png' });
    console.log('Saved data/webui_dropdown_open.png');
  });

  server.close();
}

captureTotals().catch(console.error);
