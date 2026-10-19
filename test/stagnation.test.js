import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchStagnationGuard } from '../src/core/searchStagnation.js';

test('SearchStagnationGuard 正常增长不触发熔断', () => {
  const guard = new SearchStagnationGuard(3, 'test_acc');
  guard.recordObservation(100);
  guard.recordObservation(105);
  guard.recordObservation(110);
  assert.equal(guard.isTripped(), false);
});

test('SearchStagnationGuard 连续停滞 3 次触发熔断', () => {
  const guard = new SearchStagnationGuard(3, 'test_acc');
  guard.recordObservation(100); // 初始值
  guard.recordObservation(100); // 停滞 1
  assert.equal(guard.isTripped(), false);
  guard.recordObservation(100); // 停滞 2
  assert.equal(guard.isTripped(), false);
  guard.recordObservation(100); // 停滞 3 -> 触发熔断
  assert.equal(guard.isTripped(), true);
});
