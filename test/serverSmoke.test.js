import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/web/server.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import configManager from '../src/config.js';
import http from 'http';

test('Express WebUI 与 API 基础服务烟雾测试', async () => {
  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));
  // 注入管理员测试会话
  configManager.setAdminCredentials('admin_test', 'test_salt', 'test_hash');
  const secret = configManager.ensureAdminSessionSecret();
  const token = createAdminSessionToken('admin_test', secret);
  const authHeaders = { Cookie: `${getAdminSessionCookieName()}=${encodeURIComponent(token)}` };

  const app = createServer();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: authHeaders });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.accounts));

    // 测试静态页面加载 (登录网关页公开访问)
    const loginRes = await fetch(`http://127.0.0.1:${port}/login.html`);
    assert.equal(loginRes.status, 200);
    const loginHtml = await loginRes.text();
    assert.ok(loginHtml.includes('安全网关'));
  } finally {
    configManager.get().admin = origAdmin;
    configManager.save();
    server.close();
  }
});
