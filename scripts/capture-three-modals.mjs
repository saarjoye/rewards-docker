import { createServer } from '../src/web/server.js';
import browserManager from '../src/browser/browser.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import http from 'http';

async function captureThreeModals() {
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

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1000));

    // 1. 截图：官网数据同步弹窗 (对标图 7)
    await page.click('#menu-sync-official');
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: 'data/preview_sync_modal.png' });
    console.log('Saved data/preview_sync_modal.png');
    await page.click('#close-sync-modal');
    await new Promise((r) => setTimeout(r, 400));

    // 2. 截图：账号健康体检弹窗 (对标图 8)
    await page.click('#menu-health-check');
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: 'data/preview_health_modal.png' });
    console.log('Saved data/preview_health_modal.png');
    await page.click('#close-health-modal');
    await new Promise((r) => setTimeout(r, 400));

    // 3. 截图：全局配置中心弹窗 (对标图 1-6)
    await page.click('#menu-global-config');
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: 'data/preview_global_config_modal.png' });
    console.log('Saved data/preview_global_config_modal.png');
  });

  server.close();
}

captureThreeModals().catch(console.error);
