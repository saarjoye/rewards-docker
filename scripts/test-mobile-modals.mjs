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

    // 1. 测试打开任务抽屉 (Task Drawer)
    await page.evaluate(() => {
      if (typeof window.openTaskDrawer === 'function') {
        window.openTaskDrawer('1');
      }
    });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: 'data/mobile_task_drawer.png' });
    await page.click('#btn-close-task-drawer');
    await new Promise((r) => setTimeout(r, 400));

    // 2. 测试打开月度日历
    await page.click('#btn-open-month-modal');
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: 'data/mobile_calendar_modal.png' });
    await page.click('#close-month-modal-x');
    await new Promise((r) => setTimeout(r, 400));

    // 3. 测试打开全局配置
    await page.evaluate(() => {
      document.querySelector('#modal-global-config')?.classList.remove('hidden');
    });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: 'data/mobile_config_modal.png' });
  });

  server.close();
  console.log('Screenshots generated successfully.');
}

main().catch(console.error);
