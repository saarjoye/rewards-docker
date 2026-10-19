const http = require('http');
const path = require('path');
const fs = require('fs');

async function testCalendarScreenshots() {
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

    // 1. Account pool
    const poolEl = await page.$('.box-stores');
    if (poolEl) {
      await poolEl.screenshot({ path: 'data/account_pool_updated.png' });
      console.log('Saved data/account_pool_updated.png');
    }

    // 2. Calendar chart normal state - clip with extra top margin so floating cards aren't clipped
    const chartEl = await page.$('.box-revenue');
    const box = await chartEl.boundingBox();
    const clipRegion = {
      x: Math.max(0, box.x - 10),
      y: Math.max(0, box.y - 40),
      width: box.width + 20,
      height: box.height + 50
    };

    await page.screenshot({ path: 'data/chart_calendar_normal.png', clip: clipRegion });
    console.log('Saved data/chart_calendar_normal.png');

    // 3. Hover over 10-18 bar (6th column, index 5)
    const bar1018 = await page.$('.bar-col:nth-child(6) .bar-pillar');
    if (bar1018) {
      await bar1018.hover();
      await new Promise((r) => setTimeout(r, 400));
      await page.screenshot({ path: 'data/chart_calendar_hover_1018.png', clip: clipRegion });
      console.log('Saved data/chart_calendar_hover_1018.png');
    }
  });

  server.close();
}

testCalendarScreenshots().catch(console.error);
