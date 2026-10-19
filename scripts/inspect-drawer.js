import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function clickClaim() {
  const session = readBrowserSession('test_live_account');
  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));

    // 精确锁定带有“可领取”的 button
    const claimBtn = await page.$('button:has-text("可领取")');
    if (!claimBtn) {
      console.log('Claim button not found');
      return;
    }
    const box = await claimBtn.boundingBox();
    console.log('Exact Button Box:', box);

    // 虚拟指针派发展开抽屉
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    
    // 等待抽屉异步内容加载完成 (等待 6 秒)
    console.log('Waiting 6s for drawer content to load...');
    await new Promise((r) => setTimeout(r, 6000));

    // 检查抽屉内的全部文本和按钮
    const drawerElements = await page.evaluate(() => {
      const drawer = document.querySelector('div[role="dialog"], aside, [data-bi-area="drawer"]');
      return {
        drawerFound: !!drawer,
        drawerText: drawer ? drawer.innerText : '',
        buttons: Array.from(document.querySelectorAll('button, a[role="button"]')).map(b => ({
          text: b.innerText.trim(),
          ariaLabel: b.getAttribute('aria-label'),
          className: b.className
        })).filter(b => b.text)
      };
    });
    console.log('Drawer elements:\n', JSON.stringify(drawerElements, null, 2));

    await page.screenshot({ path: 'data/drawer_content_loaded.png' });
    console.log('Saved data/drawer_content_loaded.png');
  });
}

clickClaim().catch(console.error);
