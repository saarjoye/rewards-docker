import test from 'node:test';
import assert from 'node:assert/strict';
import configManager, { getTodayDateString } from '../src/config.js';
import taskManager from '../src/core/taskManager.js';
import { writeBrowserSession, deleteBrowserSession } from '../src/identity/browserSession.js';

test('未完成任务最多重试 2 次保护，防止死循环', async () => {
  const testAccId = 'test_retry_limit_acc';
  const todayStr = getTodayDateString();

  configManager.upsertAccount({
    id: testAccId,
    name: '测试重试账号',
    enabled: true,
    remainingRetryCount: 0,
    remainingRetriesDate: todayStr
  });

  writeBrowserSession(testAccId, {
    tokens: { accessToken: 'mock_token' },
    cookies: [{ name: '_U', value: 'mock_u', domain: 'bing.com' }]
  });

  // Mock fetchOfficialTaskSnapshot and fetchOfficialDashboard to avoid real browser network
  const origSnapshot = taskManager.fetchOfficialTaskSnapshot;
  const origDash = taskManager.fetchOfficialDashboard;
  taskManager.fetchOfficialTaskSnapshot = async () => ({ hasWork: false, hasUnknown: false, details: {} });
  taskManager.fetchOfficialDashboard = async () => ({
    todayPoints: 100,
    balance: 1000,
    streakDays: 5,
    claimablePoints: 0,
    sources: { balance: 'live', todayPoints: 'live', streakDays: 'live', claimablePoints: 'live' }
  });

  try {
    // 第一次尝试 remaining -> 成功执行 (count 变为 1)
    await taskManager.runAccountTasks(testAccId, { taskScope: 'remaining' });
    let acc = configManager.getAccount(testAccId);
    assert.equal(acc.remainingRetryCount, 1);

    // 第二次尝试 remaining -> 成功执行 (count 变为 2)
    await taskManager.runAccountTasks(testAccId, { taskScope: 'remaining' });
    acc = configManager.getAccount(testAccId);
    assert.equal(acc.remainingRetryCount, 2);

    // 第三次尝试 remaining -> 触发重试上限被安全拦截跳过
    const res3 = await taskManager.runAccountTasks(testAccId, { taskScope: 'remaining' });
    assert.equal(res3.skipped, true);
    assert.equal(res3.reason, 'max-remaining-retries-reached');
    acc = configManager.getAccount(testAccId);
    assert.equal(acc.remainingRetryCount, 2);

    // 带 force: true 手动强行重跑 -> 允许绕过限制
    await taskManager.runAccountTasks(testAccId, { taskScope: 'remaining', force: true });
    acc = configManager.getAccount(testAccId);
    assert.equal(acc.remainingRetryCount, 2);
  } finally {
    taskManager.fetchOfficialTaskSnapshot = origSnapshot;
    taskManager.fetchOfficialDashboard = origDash;
    configManager.deleteAccount(testAccId);
    deleteBrowserSession(testAccId);
  }
});
