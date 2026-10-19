import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function trackClaimNetwork() {
  const session = readBrowserSession('test_live_account');
  await browserManager.withBrowser({ cookies: session.cookies, headless: true }, async (browser, context) => {
    const page = await context.newPage();
    const networkLogs = [];

    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('claim') || u.includes('rewards') || u.includes('points') || u.includes('authorize') || u.includes('token')) {
        let text = '';
        try {
          if (res.headers()['content-type']?.includes('json')) {
            text = (await res.text()).substring(0, 200);
          }
        } catch {}
        networkLogs.push(`[RES ${res.status()}] ${u.substring(0, 80)} ${text}`);
      }
    });

    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 4000));

    console.log('--- Clicking Claim Button ---');
    const claimBtn = await page.$('button:has-text("可领取")');
    if (claimBtn) {
      const box = await claimBtn.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.up();
    }

    // 等待 10 秒
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      console.log(`Waited ${i * 2}s... Network entries: ${networkLogs.length}`);
      await page.screenshot({ path: `data/drawer_step_${i}.png` });
    }

    console.log('All matched responses:\n', networkLogs.join('\n'));
  });
}

trackClaimNetwork().catch(console.error);
