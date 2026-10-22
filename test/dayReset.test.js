import test from 'node:test';
import assert from 'node:assert/strict';
import configManager, { getTodayDateString } from '../src/config.js';

test('次日跨天官网数据缺口自动重置测试', async () => {
  const testAccId = 'test_acc_day_reset_' + Date.now();
  
  // 模拟昨天的账号数据：有昨日官网任务快照、昨日积分、昨日完成状态
  configManager.upsertAccount({
    id: testAccId,
    name: '跨天测试账号',
    user: 'crossday@test.com',
    enabled: true,
    todayEarned: 146,
    todayDate: '2026-10-01', // 模拟昨天的旧日期
    lastSyncAt: Date.now() - 86400000,
    officialTasks: {
      searchStreak: { current: 3, max: 7 },
      dailySet: { current: 3, max: 3 },
      appCheckIn: { current: 1, max: 1 },
      dailyPending: [],
      questPending: [],
      needSearch: false,
      needDailySet: false,
      needAppSign: false,
      needDailyActivities: false,
      needQuests: false
    }
  });

  // 调用 getAccounts() 触发跨天检测
  const accounts = configManager.getAccounts();
  const acc = accounts.find((a) => a.id === testAccId);

  assert.ok(acc, '账号应存在');
  assert.equal(acc.todayDate, getTodayDateString(), '日期应更新为今日');
  assert.equal(acc.todayEarned, 0, '今日积分应归零');
  assert.equal(acc.officialTasks, null, '跨天后官方任务缺口快照必须重置为 null，杜绝残留昨日完成状态');
  assert.equal(acc.lastSyncAt, null, '跨天后同步时间戳必须重置为 null');
  assert.equal(acc.dataState, 'unknown', '数据状态应重置为待同步');

  // 清理测试账号
  configManager.deleteAccount(testAccId);
});

test('scheduler.getNextScheduledTask 正确计算距离最近的待执行定时任务', async () => {
  const { scheduler } = await import('../src/scheduler.js');
  const nextTask = scheduler.getNextScheduledTask();

  assert.ok(nextTask, '应返回计划任务实体');
  assert.equal(nextTask.enabled, true, '调度器应已启用');
  assert.ok(nextTask.name, '应包含任务名称');
  assert.ok(nextTask.time, '应包含计划执行时刻字符串');
  assert.ok(typeof nextTask.targetTimestamp === 'number', '应包含目标时间戳');
  assert.ok(nextTask.targetTimestamp > Date.now() - 1000, '目标时间戳应为未来时间');
  assert.ok(Array.isArray(nextTask.allSlots), '应包含全天时段安排列表');
  assert.equal(nextTask.allSlots.length, 6, '应包含 6 大标准定时时间窗口');
});
