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
      {
        name: getAdminSessionCookieName(),
        value: token,
        domain: '127.0.0.1',
        path: '/'
      }
    ]);

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1500));

    const diag = await page.evaluate(() => {
      const docEl = document.documentElement;
      const body = document.body;
      const shell = document.querySelector('.dashboard-shell');
      const main = document.querySelector('.main-viewport');
      const bento = document.querySelector('.bento-grid');

      const initScrollY = window.scrollY;
      window.scrollBy(0, 300);
      const afterScrollY = window.scrollY;

      const boxes = Array.from(document.querySelectorAll('.bento-box')).map(b => ({
        className: b.className,
        offsetWidth: b.offsetWidth,
        offsetHeight: b.offsetHeight,
        clientWidth: b.clientWidth,
        clientHeight: b.clientHeight,
        scrollWidth: b.scrollWidth,
        scrollHeight: b.scrollHeight
      }));

      return {
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        htmlOverflow: getComputedStyle(docEl).overflow,
        htmlOverflowX: getComputedStyle(docEl).overflowX,
        htmlOverflowY: getComputedStyle(docEl).overflowY,
        bodyOverflow: getComputedStyle(body).overflow,
        bodyOverflowX: getComputedStyle(body).overflowX,
        bodyOverflowY: getComputedStyle(body).overflowY,
        bodyHeight: getComputedStyle(body).height,
        docScrollHeight: docEl.scrollHeight,
        bodyScrollHeight: body.scrollHeight,
        shellHeight: shell ? getComputedStyle(shell).height : null,
        shellOverflow: shell ? getComputedStyle(shell).overflow : null,
        shellOverflowY: shell ? getComputedStyle(shell).overflowY : null,
        mainHeight: main ? getComputedStyle(main).height : null,
        mainOverflow: main ? getComputedStyle(main).overflow : null,
        mainOverflowY: main ? getComputedStyle(main).overflowY : null,
        bentoHeight: bento ? getComputedStyle(bento).height : null,
        bentoDisplay: bento ? getComputedStyle(bento).display : null,
        initScrollY,
        afterScrollY,
        scrollFailed: initScrollY === afterScrollY,
        boxes
      };
    });

    console.log('DIAGNOSTICS:', JSON.stringify(diag, null, 2));

    await page.screenshot({ path: 'data/mobile_current_preview.png' });
    try {
      await page.screenshot({ path: 'data/mobile_current_fullpage.png', fullPage: true });
    } catch (e) {
      console.log('Fullpage screenshot error:', e.message);
    }
  });

  server.close();
}

main().catch(console.error);
