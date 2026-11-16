import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRefreshError,
  shouldAttemptRefresh,
  markRefreshFailure,
  markRefreshNotified,
  markRefreshSuccess,
  describeRefreshCooldown,
  DEFAULT_REFRESH_COOLDOWN_MS
} from '../src/contracts/tokenRefreshGuard.js';

test('错误分类：网络超时 vs 凭据失效', () => {
  assert.equal(classifyRefreshError('timeout of 25000ms exceeded'), 'network');
  assert.equal(classifyRefreshError('ETIMEDOUT'), 'network');
  assert.equal(classifyRefreshError('connect ECONNREFUSED 1.2.3.4:443'), 'network');
  assert.equal(classifyRefreshError('Token refresh failed: invalid_grant - expired'), 'auth');
  assert.equal(classifyRefreshError('HTTP 401'), 'auth');
  assert.equal(classifyRefreshError(''), 'unknown');
});

test('失败后进入冷却：期内不再尝试，且只提示一次', () => {
  const now = 1_800_000_000_000;
  let state = markRefreshFailure(null, now, 'timeout of 25000ms exceeded');
  assert.equal(state.kind, 'network');
  assert.equal(state.warned, false, '失败本身不置提示位，由 markRefreshNotified 置位');
  state = markRefreshNotified(state);
  assert.equal(state.warned, true);

  // 冷却中
  const inWindow = shouldAttemptRefresh(state, now + 60_000, DEFAULT_REFRESH_COOLDOWN_MS);
  assert.equal(inWindow.allowed, false);
  assert.equal(inWindow.notify, false, '已提示过，不再重复打印');
  assert.ok(inWindow.remainingMs > 0);
  assert.equal(inWindow.kind, 'network');

  // 未提示过时应该提示一次
  const fresh = markRefreshFailure(null, now, 'timeout');
  const first = shouldAttemptRefresh({ ...fresh, warned: false }, now + 1000, DEFAULT_REFRESH_COOLDOWN_MS);
  assert.equal(first.allowed, false);
  assert.equal(first.notify, true);

  // 冷却结束
  const after = shouldAttemptRefresh(state, now + DEFAULT_REFRESH_COOLDOWN_MS + 1, DEFAULT_REFRESH_COOLDOWN_MS);
  assert.equal(after.allowed, true);
});

test('成功后续期状态清空，允许再次尝试', () => {
  const cleared = markRefreshSuccess();
  assert.equal(cleared, null);
  assert.equal(shouldAttemptRefresh(cleared).allowed, true);
});

test('冷却提示文案区分网络/凭据原因', () => {
  const net = describeRefreshCooldown({ kind: 'network' }, 9 * 60_000);
  assert.match(net, /网络超时/);
  assert.match(net, /9 分钟/);
  assert.match(describeRefreshCooldown({ kind: 'auth' }, 600_000), /凭据已失效/);
});

test('markRefreshNotified 只影响提示位，不改失败时间', () => {
  const now = 1_800_000_000_000;
  const failed = markRefreshFailure(null, now, 'timeout');
  const notified = markRefreshNotified(failed);
  assert.equal(notified.lastFailureAt, now);
  assert.equal(notified.warned, true);
});
