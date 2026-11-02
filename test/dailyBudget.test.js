import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeDailyBudget, peekDailyBudget, dayKey } from '../src/contracts/dailyBudget.js';

test('每日配额：同 IP 多账号共享额度，用满即拒绝', () => {
  const today = '2026-11-02';
  let state = { date: '', values: {} };

  const first = consumeDailyBudget(state, 'shopQuestAttempt', 2, today);
  assert.equal(first.allowed, true);
  assert.equal(first.used, 1);
  state = first.state;

  const second = consumeDailyBudget(state, 'shopQuestAttempt', 2, today);
  assert.equal(second.allowed, true);
  assert.equal(second.used, 2);
  state = second.state;

  const third = consumeDailyBudget(state, 'shopQuestAttempt', 2, today);
  assert.equal(third.allowed, false, '第 3 个账号必须被拒绝，避免互相消耗配额');
  assert.equal(third.used, 2);
  assert.equal(third.state.values.shopQuestAttempt, 2);

  const peeked = peekDailyBudget(state, 'shopQuestAttempt', 2, today);
  assert.equal(peeked.allowed, false);
});

test('每日配额：跨天自动重置', () => {
  const used = consumeDailyBudget({ date: '2026-11-02', values: { shopQuestAttempt: 2 } }, 'shopQuestAttempt', 2, '2026-11-03');
  assert.equal(used.allowed, true);
  assert.equal(used.used, 1, '新的一天从第 1 次开始计数');
  assert.equal(used.state.date, '2026-11-03');
  assert.equal(used.state.values.shopQuestAttempt, 1);
});

test('dayKey 生成本地日期字符串', () => {
  assert.equal(dayKey(new Date(2026, 10, 2)), '2026-11-02');
});
