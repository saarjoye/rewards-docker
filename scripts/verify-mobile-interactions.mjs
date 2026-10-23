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
      { name: getAdminSessionCookieName(), value: token, domain: '127.0.0.1', path: '/' }
    ]);

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1200));

    // 1. 测试侧边栏抽屉展开与关闭
    console.log('[1/4] 测试点击汉堡菜单展开侧栏...');
    await page.click('#btn-toggle-mobile-menu');
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: 'data/mobile_test_1_sidebar.png' });

    console.log('[1/4] 点击侧边栏菜单项关闭侧栏并打开全局配置中心...');
    await page.click('#menu-global-config');
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: 'data/mobile_test_2_config_modal.png' });
    await page.click('#close-global-modal-x');
    await new Promise((r) => setTimeout(r, 400));

    // 2. 测试全月日历弹窗
    console.log('[2/4] 打开全月日历弹窗...');
    await page.click('#btn-open-month-modal');
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: 'data/mobile_test_3_calendar_modal.png' });
    await page.click('#close-month-modal-x');
    await new Promise((r) => setTimeout(r, 400));

    // 3. 测试任务全景抽屉
    console.log('[3/4] 点击官网任务缺口卡片中的 [详情 ↗] 呼出抽屉...');
    const detailBtn = page.locator('.btn-task-detail').first();
    if (await detailBtn.count()) {
      await detailBtn.click();
      await new Promise((r) => setTimeout(r, 600));
      await page.screenshot({ path: 'data/mobile_test_4_task_drawer.png' });
      await page.click('#btn-close-task-drawer');
      await new Promise((r) => setTimeout(r, 400));
      console.log('✅ 任务全景抽屉打开与关闭成功！');
    }

    console.log('🎉 所有移动端关键弹窗与交互验证完毕！');
  });

  server.close();
}

main().catch(console.error);
