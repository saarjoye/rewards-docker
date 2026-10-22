import http from 'http';
import { chromium } from 'patchright-core';
import { createServer } from '../src/web/server.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';

async function main() {
  const secret = configManager.ensureAdminSessionSecret();
  const token = createAdminSessionToken('admin', secret);

  // 设置测试账号模拟真实打孔卡和连签数据
  const testAcc = {
    id: 'test_demo_account',
    name: 'saarjoye',
    user: 'saarjoye@outlook.com',
    enabled: true,
    status: 'ready',
    balance: 14714,
    todayEarned: 146,
    streakDays: 128,
    claimablePoints: 3,
    lastSyncAt: Date.now() - 60000,
    slot: 'auto',
    officialTasks: {
      searchStreak: { current: 3, max: 7 },
      dailySet: { current: 3, max: 3 },
      appCheckIn: { current: 1, max: 1 },
      searchPoints: { current: 24, max: 60, isMaxed: false },
      dailyPending: [],
      questPending: [],
      allQuestCards: [
        { title: '50分的万圣节礼遇', current: 6, total: 6, done: true, percent: 100, isCooling: false, rewardPts: 50 },
        { title: '通过 Microsoft Rewards 解锁免费 Super Duolingo', current: 4, total: 6, done: false, percent: 67, isCooling: true, rewardPts: 50 },
        { title: '桌面奖励应用每周专属任务', current: 4, total: 8, done: false, percent: 50, isCooling: false, rewardPts: 20 },
        { title: '十月必看五大亮点：服饰、玩具、手机、超值优惠和AI设备', current: 5, total: 5, done: true, percent: 100, isCooling: false, rewardPts: 50 }
      ]
    }
  };

  configManager.upsertAccount(testAcc);

  const app = createServer();
  const testPort = 5399;
  const server = http.createServer(app);
  
  await new Promise((resolve) => server.listen(testPort, resolve));
  console.log(`Test server running on port ${testPort}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  await context.addCookies([
    {
      name: getAdminSessionCookieName(),
      value: token,
      domain: '127.0.0.1',
      path: '/'
    }
  ]);

  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__errors = [];
    window.addEventListener('error', (e) => window.__errors.push(e.message + ' at ' + e.filename + ':' + e.lineno));
  });
  page.on('console', (msg) => console.log('PAGE ' + msg.type().toUpperCase() + ':', msg.text()));
  page.on('pageerror', (err) => console.log('PAGE ERR:', err.message));
  page.on('response', (res) => {
    if (res.status() >= 400) console.log('HTTP ERR:', res.status(), res.url());
  });

  try {
    await page.goto(`http://127.0.0.1:${testPort}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
  const evalErr = await page.evaluate(() => {
    try {
      renderSchedulerQueue();
      return null;
    } catch (e) {
      return e.stack;
    }
  });
  console.log('MANUAL CALL EVAL ERR:', evalErr);
  const clientErrors = await page.evaluate(() => window.__errors);
  console.log('CLIENT ERRORS:', clientErrors);

    // 1. 截取整个 Dashboard 全貌 (包含图 2 红框倒计时胶囊)
    await page.screenshot({ path: 'data/verify_dashboard_with_countdown.png' });
    console.log('Saved data/verify_dashboard_with_countdown.png');

    // 2. 截取调度队列与账号锁卡片特写 (图 2 区域)
    const queueBox = page.locator('.box-scheduler-queue').first();
    if (await queueBox.count()) {
      await queueBox.screenshot({ path: 'data/verify_queue_countdown_zoom.png' });
      console.log('Saved data/verify_queue_countdown_zoom.png');
    }

    // 3. 点击左下角官网任务缺口卡片，呼出全景任务抽屉
    const gapCard = page.locator('.task-gap-card').first();
    if (await gapCard.count()) {
      await gapCard.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: 'data/verify_task_drawer_opened.png' });
      console.log('Saved data/verify_task_drawer_opened.png');
    }

    // 4. 关闭抽屉，测试单账号原位切换
    const closeBtn = page.locator('#btn-close-task-drawer').first();
    if (await closeBtn.count()) {
      await closeBtn.click();
      await page.waitForTimeout(400);
    }

    const topCard = page.locator('.metric-card').first();
    if (await topCard.count()) {
      await topCard.click();
      await page.waitForTimeout(600);
      const gapsBox = page.locator('.box-task-gaps').first();
      if (await gapsBox.count()) {
        await gapsBox.screenshot({ path: 'data/verify_single_account_gap_zoom.png' });
        console.log('Saved data/verify_single_account_gap_zoom.png');
      }
    }

  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    configManager.deleteAccount(testAcc.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
