import { createServer } from '../src/web/server.js';
import browserManager from '../src/browser/browser.js';
import http from 'http';

async function captureHover() {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await browserManager.withBrowser({ headless: true }, async (browser, context) => {
    const page = await context.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1500));

    // 悬停在今日积分柱上
    const todayPillar = await page.$('.bar-col.active .bar-pillar');
    if (todayPillar) {
      await todayPillar.hover();
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: 'data/chart_hover_today.png' });
      console.log('Saved data/chart_hover_today.png');
    }

    // 悬停在 10/17 历史柱上
    const histPillar = await page.$('.bar-col:nth-child(4) .bar-pillar');
    if (histPillar) {
      await histPillar.hover();
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: 'data/chart_hover_history.png' });
      console.log('Saved data/chart_hover_history.png');
    }
  });

  server.close();
}

captureHover().catch(console.error);
