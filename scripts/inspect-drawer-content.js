import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function testOnce() {
  const session = readBrowserSession('test_live_account');
  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));

    const claimBtn = await page.$('button:has-text("可领取")');
    const box = await claimBtn.boundingBox();
    console.log('Clicking once at:', box);

    // 单次精准点击
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();

    // 每 2 秒截一张图，观察抽屉内容加载
    for (let i = 1; i <= 4; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await page.screenshot({ path: `data/drawer_open_stream_${i}.png` });
      console.log(`Saved stream ${i}`);
    }

    // 输出此时所有的文本
    const texts = await page.evaluate(() => document.body.innerText);
    console.log('Page text after drawer open:\n', texts.slice(0, 1200));
  });
}

testOnce().catch(console.error);
