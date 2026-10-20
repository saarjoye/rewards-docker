import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/web/server.js';
import taskManager from '../src/core/taskManager.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import http from 'http';

test('停止标记在整个批量队列结束前保持有效，且单账号 finally 不清除', async () => {
  const manager = new taskManager.constructor();
  const originalGetAccounts = configManager.getAccounts;
  const originalGetAccount = configManager.getAccount;
  const originalRun = manager.runAccountTasks;
  const calls = [];

  configManager.getAccounts = () => [
    { id: 'acc_a', name: 'A', enabled: true },
    { id: 'acc_b', name: 'B', enabled: true }
  ];
  configManager.getAccount = (id) => ({ id, name: id });
  manager.runAccountTasks = async (id) => {
    calls.push(id);
    manager.stopCurrentTask();
    manager.shouldStop = true;
    await manager.waitUnlessStopped(5000);
  };

  try {
    const result = await manager.runAllAccountsTasks({ taskScope: 'remaining' });
    assert.equal(result.stopped, true);
    assert.equal(manager.shouldStop, true);
    assert.deepEqual(calls, ['acc_a']);
  } finally {
    manager.runAccountTasks = originalRun;
    configManager.getAccounts = originalGetAccounts;
    configManager.getAccount = originalGetAccount;
  }
});

test('stopCurrentTask 在批量队列冷却期间也能中止', async () => {
  const manager = new taskManager.constructor();
  manager.isQueueRunning = true;
  const result = manager.stopCurrentTask();
  assert.equal(result.stopped, true);
  assert.equal(manager.shouldStop, true);
  assert.equal(await manager.waitUnlessStopped(5000), false);
});

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
