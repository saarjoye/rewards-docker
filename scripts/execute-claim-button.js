import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function executeClaim() {
  console.log('--- 测试无头浏览器在抽屉内点击「领取积分」黑色按钮 ---');
  const session = readBrowserSession('test_live_account');

  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'networkidle', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 4000));

    // 1. 点击右上角可领取卡片
    const claimBtn = await page.$('button:has-text("可领取")');
    if (!claimBtn) {
      console.log('未找到可领取按钮');
      return;
    }
    const box = await claimBtn.boundingBox();
    console.log('[1/3] 展开抽屉, 坐标:', box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // 2. 等待抽屉展开并渲染
    console.log('[2/3] 等待 4 秒抽屉内容完全渲染...');
    await new Promise((r) => setTimeout(r, 4000));

    // 3. 在抽屉内定位黑色「领取积分」按钮
    // 根据刚刚的实测截图，按钮文本精确包含「领取积分」，class 包含黑色背景
    const blackClaimBtn = await page.$('div[role="dialog"] button:has-text("领取积分"), button:has-text("领取积分")');
    if (blackClaimBtn && await blackClaimBtn.isVisible()) {
      const btnBox = await blackClaimBtn.boundingBox();
      console.log('[3/3] 锁定抽屉内「领取积分」黑色按钮！坐标:', btnBox);
      
      // 派发指针点击
      await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
      await page.mouse.down();
      await page.mouse.up();
      console.log('已点击「领取积分」按钮！等待 5 秒服务端到账确认...');
      await new Promise((r) => setTimeout(r, 5000));
    } else {
      console.log('抽屉内未找到可见的「领取积分」按钮');
    }

    await page.screenshot({ path: 'data/after_black_claim_clicked.png' });
    console.log('已保存点击后状态截图: data/after_black_claim_clicked.png');

    // 4. 刷新页面对账
    await page.reload({ waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 3000));
    const finalDashText = await page.evaluate(() => document.body.innerText);
    const balanceMatch = finalDashText.match(/可用积分\s*[:\n\r]+\s*([0-9,]+)/i);
    const claimableMatch = finalDashText.match(/可领取\s*[:\n\r]+\s*([0-9,]+)/i);
    console.log('========================================================');
    console.log('🎉 最终官网实时对账回验：');
    console.log(`   可用总积分余额: ${balanceMatch ? balanceMatch[1] : '未提取'} 分`);
    console.log(`   待领额外积分: ${claimableMatch ? claimableMatch[1] : '0 (已归零)'} 分`);
    console.log('========================================================');
  });
}

executeClaim().catch(console.error);
