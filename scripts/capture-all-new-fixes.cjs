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
    await new Promise((r) => setTimeout(r, 1200));

    // 截图 1：大盘主屏 (验证黑色气泡不常驻，账号池状态前移并新增编辑按钮)
    await page.screenshot({ path: 'data/new_pool_with_edit_btn.png' });
    console.log('Saved data/new_pool_with_edit_btn.png');

    // 截图 2：打开健康体检弹窗 (验证初始空闲等待状态，显示「▶ 开始检测」按钮，不自动检测)
    await page.click('#menu-health-check');
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: 'data/new_health_modal_idle.png' });
    console.log('Saved data/new_health_modal_idle.png');
    await page.click('#btn-health-confirm');
    await new Promise((r) => setTimeout(r, 500));

    // 截图 3：打开官网同步弹窗 (验证初始空闲等待状态，显示「▶ 开始同步」按钮，不自动同步)
    await page.click('#menu-sync-official');
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: 'data/new_sync_modal_idle.png' });
    console.log('Saved data/new_sync_modal_idle.png');
  });

  server.close();
}

run().catch(console.error);
