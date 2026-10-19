import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function inspectItem3() {
  const session = readBrowserSession('test_live_account');
  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));
    const links = await page.$$('#dailyset a, div[data-bi-area="DailySet"] a');
    console.log('Daily Set link count:', links.length);
    for (let i = 0; i < links.length; i++) {
      const text = await links[i].innerText();
      const href = await links[i].getAttribute('href');
      console.log(`Item ${i + 1}: text=[${text.replace(/\n+/g, ' ')}], href=[${href?.substring(0, 80)}]`);
    }
  });
}

inspectItem3().catch(console.error);
