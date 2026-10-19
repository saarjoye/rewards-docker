import { createServer } from '../src/web/server.js';
import browserManager from '../src/browser/browser.js';
import http from 'http';

async function capturePoolSwitching() {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await browserManager.withBrowser({ headless: true }, async (browser, context) => {
    const page = await context.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1500));

    // 截图 1：全账号大盘合计态，账号池首项为「全部账号大盘合计」
    await page.screenshot({ path: 'data/pool_view_all.png' });
    console.log('Saved data/pool_view_all.png');

    // 点击账号池内的单账号卡片 (模拟就地切换单账号)
    const singleCard = await page.$('.store-card-row:nth-child(2)');
    if (singleCard) {
      await singleCard.click();
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 截图 2：就地点击切换到单账号后的高亮态
    await page.screenshot({ path: 'data/pool_view_single.png' });
    console.log('Saved data/pool_view_single.png');
  });

  server.close();
}

capturePoolSwitching().catch(console.error);
