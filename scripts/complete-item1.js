import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function completeItem1() {
  const session = readBrowserSession('test_live_account');
  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    console.log('Navigating to Item 1: https://rewards.bing.com/referandearn/?form=ML2XHD&OCID=ML2XHD&PUBL=RewardsDO&CREA=TEXT&PROGRAMNAME=DailySetZHCN');
    await page.goto('https://rewards.bing.com/referandearn/?form=ML2XHD&OCID=ML2XHD&PUBL=RewardsDO&CREA=TEXT&PROGRAMNAME=DailySetZHCN', {
      waitUntil: 'domcontentloaded',
      timeout: 35000
    });
    await new Promise((r) => setTimeout(r, 5000));

    // 回到 dashboard 核验
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));
    const text = await page.evaluate(() => document.body.innerText);
    const m = text.match(/每日活动[\s\S]{1,60}?活动:\s*(\d+\/\d+)/i);
    console.log('Daily Set after Item 1:\n', m ? m[0].replace(/\n+/g, ' ') : 'Not found');
  });
}

completeItem1().catch(console.error);
