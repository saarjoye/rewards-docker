import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function copyRefer() {
  const session = readBrowserSession('test_live_account');
  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    await page.goto('https://rewards.bing.com/referandearn/?form=ML2XHD&OCID=ML2XHD&PUBL=RewardsDO&CREA=TEXT&PROGRAMNAME=DailySetZHCN', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));
    const btn = await page.$('button:has-text("复制链接"), button:has-text("共享"), a:has-text("复制链接")');
    if (btn) {
      console.log('Found button:', await btn.innerText());
      await btn.click();
      await new Promise((r) => setTimeout(r, 4000));
    } else {
      console.log('Button not found');
    }

    // 回到 dashboard 核验
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/每日活动[\s\S]{1,60}?活动:\s*(\d+\/\d+)/i);
    console.log('Daily Set after clicking copy link:\n', m ? m[0].replace(/\n+/g, ' ') : 'Not found');
  });
}

copyRefer().catch(console.error);
