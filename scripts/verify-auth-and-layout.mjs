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

  // 1. 无凭据访问 / 验证重定向到 /login.html
  console.log('[1/3] 测试未登录访问主页，验证安全拦截重定向...');
  const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
  console.log(`未登录访问返回状态: ${res.status}, Location: ${res.headers.get('location')}`);

  await browserManager.withBrowser({ headless: true }, async (browser, context) => {
    const page = await context.newPage({ viewport: { width: 1440, height: 900 } });

    // 2. 截取登录页画面
    await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'data/login_page_preview.png' });
    console.log('[2/3] 保存登录安全网关截图: data/login_page_preview.png');

    // 3. 携带登录 Cookie 访问主页，截取一屏最终画面
    configManager.setAdminCredentials('admin', 'salt', 'hash');
    const secret = configManager.ensureAdminSessionSecret();
    const token = createAdminSessionToken('admin', secret);

    await context.addCookies([
      {
        name: getAdminSessionCookieName(),
        value: token,
        domain: '127.0.0.1',
        path: '/'
      }
    ]);

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: 'data/final_dashboard_clean.png' });
    console.log('[3/3] 保存已登录最终一屏控制台截图: data/final_dashboard_clean.png');
  });

  server.close();
}

main().catch(console.error);
