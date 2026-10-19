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

    // 打开全局配置中心
    await page.click('#menu-global-config');
    await new Promise((r) => setTimeout(r, 600));

    // Tab 2: 网络与代理 (对标图 2)
    await page.click('button[data-cfgtab="network"]');
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: 'data/tab2_network.png' });
    console.log('Saved data/tab2_network.png');

    // Tab 3: 任务与防风控 (对标图 3)
    await page.click('button[data-cfgtab="tasks"]');
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: 'data/tab3_tasks.png' });
    console.log('Saved data/tab3_tasks.png');

    // Tab 5: 消息推送 (对标图 5)
    await page.click('button[data-cfgtab="notify"]');
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: 'data/tab5_notify.png' });
    console.log('Saved data/tab5_notify.png');
  });

  server.close();
}

run().catch(console.error);
