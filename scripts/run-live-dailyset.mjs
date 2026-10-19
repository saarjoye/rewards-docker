import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';
import { penetrateDailySetActivities } from '../src/browser/actions.js';
import taskManager from '../src/core/taskManager.js';
import configManager from '../src/config.js';

async function testDailySet() {
  console.log('========================================================');
  console.log('📅 真实执行实测：每日活动集 (Daily Set 3/3) 穿透点击与加分');
  console.log('========================================================');

  const account = configManager.getAccount('test_live_account');
  const session = readBrowserSession(account.id);

  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    // 1. 获取执行前状态
    console.log('[1/3] 同步执行前官网状态...');
    const beforeData = await taskManager.fetchOfficialDashboard(context, account);
    console.log(`执行前今日积分: ${beforeData.todayPoints} 分, 连签天数: ${beforeData.streakDays} 天`);

    // 2. 执行 Daily Set 弹窗点击穿透
    console.log('[2/3] 启动无头浏览器执行真实弹窗点击与驻留遥测...');
    const page = await context.newPage();
    try {
      await penetrateDailySetActivities(page, { accountPrefix: account.name });
    } finally {
      await page.close().catch(() => {});
    }

    // 3. 等待 10 秒后二次回验官网数据
    console.log('[3/3] 等待 10 秒微软异步入账后进行官网二次对账...');
    await new Promise((r) => setTimeout(r, 10000));

    const afterData = await taskManager.fetchOfficialDashboard(context, account);
    console.log('========================================================');
    console.log('📊 Daily Set 执行后官网真实对账报告：');
    console.log(`   执行前今日积分: ${beforeData.todayPoints} 分 ➔ 执行后今日积分: ${afterData.todayPoints} 分 (增量: +${afterData.todayPoints - beforeData.todayPoints} 分)`);
    console.log(`   执行前总可用额: ${beforeData.balance} 分 ➔ 执行后总可用额: ${afterData.balance} 分`);
    console.log('========================================================');
  });
}

testDailySet().catch(console.error);
