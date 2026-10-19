const http = require('http');

async function run() {
  const { createServer } = await import('../src/web/server.js');
  const browserManager = (await import('../src/browser/browser.js')).default;
  const configManager = (await import('../src/config.js')).default;
  const { createAdminSessionToken, getAdminSessionCookieName } = await import('../src/identity/adminAuth.js');

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

    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1000));

    // 1. 官网数据同步 (对标图 7)
    await page.click('#menu-sync-official');
    await new Promise((r) => setTimeout(r, 900));
    await page.screenshot({ path: 'data/preview_sync_modal.png' });
    console.log('Saved data/preview_sync_modal.png');

    await page.evaluate(() => document.getElementById('modal-sync-official')?.classList.add('hidden'));
    await new Promise((r) => setTimeout(r, 500));

    // 2. 账号健康体检 (对标图 8)
    await page.click('#menu-health-check');
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: 'data/preview_health_modal.png' });
    console.log('Saved data/preview_health_modal.png');

    await page.evaluate(() => document.getElementById('modal-health-check')?.classList.add('hidden'));
    await new Promise((r) => setTimeout(r, 500));

    // 3. 全局配置中心 (对标图 1-6)
    await page.click('#menu-global-config');
    await new Promise((r) => setTimeout(r, 900));
    await page.screenshot({ path: 'data/preview_global_config_modal.png' });
    console.log('Saved data/preview_global_config_modal.png');
  });

  server.close();
}

run().catch(console.error);
