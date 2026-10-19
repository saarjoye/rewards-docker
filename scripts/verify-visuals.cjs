const http = require('http');
const path = require('path');
const fs = require('fs');

async function testScreenshots() {
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

  const currentCfg = configManager.get();
  currentCfg.accounts = [
    {
      id: 'acc_idle',
      name: '默认账号',
      user: 'user@example.com',
      enabled: true,
      status: 'ready',
      balance: 1540,
      todayEarned: 93,
      streakDays: 4
    },
    {
      id: 'acc_running',
      name: 'test_user',
      user: 'user@example.com',
      enabled: true,
      status: 'running',
      balance: 2300,
      todayEarned: 135,
      streakDays: 12
    },
    {
      id: 'acc_abnormal',
      name: '异常测试账号',
      user: 'abnormal@outlook.com',
      enabled: true,
      status: 'needs_2fa',
      balance: 820,
      todayEarned: 0,
      streakDays: 0
    }
  ];

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
    await new Promise((r) => setTimeout(r, 800));

    // 1. Screenshot account pool
    const poolEl = await page.$('.box-stores');
    if (poolEl) {
      await poolEl.screenshot({ path: 'data/zoom_account_pool.png' });
      console.log('Saved data/zoom_account_pool.png');
    }

    // 2. Screenshot zoomed on chart (normal state)
    const chartEl = await page.$('.box-revenue');
    if (chartEl) {
      await chartEl.screenshot({ path: 'data/zoom_chart_normal.png' });
      console.log('Saved data/zoom_chart_normal.png');
    }

    // 3. Hover on today bar
    const activeBar = await page.$('.bar-col.active .bar-pillar');
    if (activeBar) {
      await activeBar.hover();
      await new Promise((r) => setTimeout(r, 400));
      await chartEl.screenshot({ path: 'data/zoom_chart_hover.png' });
      console.log('Saved data/zoom_chart_hover.png');
    }
  });

  server.close();
}

testScreenshots().catch(console.error);
