import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/web/server.js';
import taskManager from '../src/core/taskManager.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import http from 'http';

test('POST /api/tasks/run 灵活任务调度接口测试', async () => {
  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));
  configManager.setAdminCredentials('admin_test', 'test_salt', 'test_hash');
  const secret = configManager.ensureAdminSessionSecret();
  const token = createAdminSessionToken('admin_test', secret);
  const authHeaders = {
    'Content-Type': 'application/json',
    Cookie: `${getAdminSessionCookieName()}=${encodeURIComponent(token)}`
  };

  const origRunAll = taskManager.runAllAccountsTasks;
  const origRunSingle = taskManager.runAccountTasks;
  taskManager.runAllAccountsTasks = async () => ({ success: true });
  taskManager.runAccountTasks = async () => ({ success: true });

  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 1. 测试 single 模式缺少 accountId 报错
    const errRes = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountScope: 'single' })
    });
    assert.equal(errRes.status, 400);

    // 2. 测试 single 模式账号不存在报错
    const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountScope: 'single', accountId: 'non_existent_acc' })
    });
    assert.equal(notFoundRes.status, 404);

    // 3. 测试 all 模式正常接收
    const allRes = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountScope: 'all', taskScope: 'search' })
    });
    assert.equal(allRes.status, 200);
    const allData = await allRes.json();
    assert.equal(allData.success, true);
    assert.ok(allData.message.includes('全部已启用账号'));
  } finally {
    taskManager.runAllAccountsTasks = origRunAll;
    taskManager.runAccountTasks = origRunSingle;
    configManager.get().admin = origAdmin;
    configManager.save();
    server.close();
  }
});
