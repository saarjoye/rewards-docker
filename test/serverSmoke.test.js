import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/web/server.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import configManager from '../src/config.js';
import http from 'http';

test('Express WebUI 与 API 基础服务烟雾测试', async () => {
  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));
  const origAccounts = JSON.parse(JSON.stringify(configManager.get().accounts || []));
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
    assert.ok(loginHtml.includes('Rewards自动任务系统'));

    // 测试 GET /api/health (未知账号时返回标准 404 JSON 而非 HTML 报错页)
    const healthNotFoundRes = await fetch(`http://127.0.0.1:${port}/api/health?accountId=nonexistent_test_id`, { headers: authHeaders });
    assert.equal(healthNotFoundRes.status, 404);
    assert.ok(healthNotFoundRes.headers.get('content-type')?.includes('application/json'));
    const healthNotFoundData = await healthNotFoundRes.json();
    assert.equal(healthNotFoundData.success, false);
    assert.ok(healthNotFoundData.message.includes('未找到指定账号'));

    // 测试未匹配 API 路由的 404 兜底保护 (必须返回 JSON，杜绝 <!DOCTYPE html 破坏前端)
    const apiNotFoundRes = await fetch(`http://127.0.0.1:${port}/api/nonexistent_action_smoke`, { headers: authHeaders });
    assert.equal(apiNotFoundRes.status, 404);
    assert.ok(apiNotFoundRes.headers.get('content-type')?.includes('application/json'));
    const apiNotFoundData = await apiNotFoundRes.json();
    assert.equal(apiNotFoundData.success, false);
    assert.ok(apiNotFoundData.message.includes('未找到 API 路由'));

    // 测试已有账号的 GET /api/health 响应结构
    configManager.upsertAccount({
      id: 'smoke_health_test_acc',
      user: 'smoke@outlook.com',
      name: '体检测试账号'
    });
    const healthOkRes = await fetch(`http://127.0.0.1:${port}/api/health?accountId=smoke_health_test_acc`, { headers: authHeaders });
    assert.equal(healthOkRes.status, 200);
    assert.ok(healthOkRes.headers.get('content-type')?.includes('application/json'));
    const healthOkData = await healthOkRes.json();
    assert.equal(healthOkData.success, true);
    assert.ok(Array.isArray(healthOkData.results));
    assert.equal(healthOkData.results.length, 1);
    assert.equal(healthOkData.results[0].accountId, 'smoke_health_test_acc');
    assert.ok(healthOkData.results[0].status);
  } finally {
    configManager.get().admin = origAdmin;
    configManager.get().accounts = origAccounts;
    configManager.save();
    server.close();
  }
});
