import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function solvePuzzle() {
  const session = readBrowserSession('test_live_account');
  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    console.log('Navigating to spotlight puzzle...');
    await page.goto('https://www.bing.com/spotlight/imagepuzzle', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));

    // 寻找跳过拼图或开始拼图
    const skipBtn = await page.$(':text("跳过拼图"), a:has-text("跳过拼图"), button:has-text("跳过拼图")');
    if (skipBtn) {
      console.log('Found skip puzzle button, clicking...');
      await skipBtn.click();
      await new Promise((r) => setTimeout(r, 4000));
    } else {
      console.log('Skip button not found, clicking click to begin...');
      const beginBtn = await page.$(':text("Click to begin")');
      if (beginBtn) await beginBtn.click();
      await new Promise((r) => setTimeout(r, 4000));
    }

    await page.screenshot({ path: 'data/puzzle_completed.png' });
    console.log('Saved data/puzzle_completed.png');

    // 访问 /earn 检查今日积分
    await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));
    const text = await page.evaluate(() => document.body.innerText);
    const todayMatch = text.match(/今日积分\s*[:\n\r]+\s*([0-9,]+)/i);
    console.log('Official todayPoints after puzzle:', todayMatch ? todayMatch[1] : 'Not found');
  });
}

solvePuzzle().catch(console.error);
