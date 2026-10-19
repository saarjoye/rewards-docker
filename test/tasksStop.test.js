import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/web/server.js';
import taskManager from '../src/core/taskManager.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import http from 'http';

test('POST /api/tasks/stop 中断任务接口测试', async () => {
  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));
  configManager.setAdminCredentials('admin_test', 'test_salt', 'test_hash');
  const secret = configManager.ensureAdminSessionSecret();
  const token = createAdminSessionToken('admin_test', secret);
  const authHeaders = {
    'Content-Type': 'application/json',
    Cookie: `${getAdminSessionCookieName()}=${encodeURIComponent(token)}`
  };

  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/stop`, {
      method: 'POST',
      headers: authHeaders
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
  } finally {
    configManager.get().admin = origAdmin;
    configManager.save();
    server.close();
  }
});
