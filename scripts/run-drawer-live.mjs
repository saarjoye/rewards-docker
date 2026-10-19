import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function testDrawerLive() {
  console.log('--- 测试无头浏览器打开可领取抽屉并完整加载 ---');
  const session = readBrowserSession('test_live_account');

  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'networkidle', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 4000));

    const claimBtn = await page.$('button:has-text("可领取")');
    if (!claimBtn) {
      console.log('未找到可领取按钮');
      return;
    }

    const box = await claimBtn.boundingBox();
    console.log('点击可领取卡片坐标:', box);

    // 虚拟指针点击
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    console.log('已点击展开，开始等待抽屉内容渲染 (每 2 秒观测一次)...');

    for (let sec = 2; sec <= 12; sec += 2) {
      await new Promise((r) => setTimeout(r, 2000));
      await page.screenshot({ path: `data/drawer_wait_${sec}s.png` });

      // 检查页面中是否出现了抽屉文本与按钮
      const drawerInfo = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"], aside, div[class*="drawer"], div[class*="flyout"], div[class*="panel"]');
        const text = document.body ? document.body.innerText : '';
        const claimButtons = Array.from(document.querySelectorAll('button, a')).map(b => b.innerText.trim()).filter(t => t.includes('领取'));
        return {
          hasDialog: !!dialog,
          dialogText: dialog ? dialog.innerText.slice(0, 300) : '',
          claimButtons
        };
      });

      console.log(`[+${sec}s] 状态: hasDialog=${drawerInfo.hasDialog}, 发现含领取文本的按钮:`, drawerInfo.claimButtons);
      if (drawerInfo.dialogText) {
        console.log(`[+${sec}s] 抽屉内部文本预览:\n`, drawerInfo.dialogText);
      }
    }
  });
}

testDrawerLive().catch(console.error);
