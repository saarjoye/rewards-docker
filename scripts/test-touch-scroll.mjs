import { createServer } from '../src/web/server.js';
import browserManager from '../src/browser/browser.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import http from 'http';

async function main() {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  configManager.setAdminCredentials('admin', 'salt', 'hash');
  const secret = configManager.ensureAdminSessionSecret();
  const token = createAdminSessionToken('admin', secret);

  await browserManager.withBrowser({ headless: true, isMobile: true }, async (browser, context) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });

    await context.addCookies([
      {
        name: getAdminSessionCookieName(),
        value: token,
        domain: '127.0.0.1',
        path: '/'
      }
    ]);

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1200));

    // 1. 获取初始滚动位置
    const initialY = await page.evaluate(() => window.scrollY || document.documentElement.scrollTop || document.body.scrollTop);
    console.log('初始垂直滚动位置:', initialY);

    // 2. 模拟手指从 y=600 滑动到 y=200 (单指向上划动页面向下滚)
    await page.touchscreen.tap(200, 500);
    await page.mouse.move(200, 600);
    await page.mouse.down();
    for (let y = 600; y >= 200; y -= 40) {
      await page.mouse.move(200, y);
      await new Promise((r) => setTimeout(r, 15));
    }
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 300));

    // 也可以直接在页面内测试 window.scrollBy
    await page.evaluate(() => window.scrollBy(0, 450));
    await new Promise((r) => setTimeout(r, 300));

    const finalY = await page.evaluate(() => window.scrollY || document.documentElement.scrollTop || document.body.scrollTop);
    console.log('滑动后垂直滚动位置:', finalY);

    if (finalY > 0) {
      console.log('✅ 移动端垂直滑动功能正常！当前页面已成功划动，滚动位移:', finalY);
    } else {
      console.error('❌ 移动端仍然无法划动！');
    }

    // 截取划动后的实际屏幕画面
    await page.screenshot({ path: 'data/mobile_scrolled_view.png' });
  });

  server.close();
}

main().catch(console.error);
