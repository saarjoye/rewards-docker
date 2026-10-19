import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumberWithCommas,
  extractOfficialTodayPoints,
  extractOfficialBalance,
  extractOfficialStreakDays,
  extractOfficialClaimablePoints,
  validateStrictMetrics
} from '../src/contracts/validator.js';

test('parseNumberWithCommas 千分位逗号解析', () => {
  assert.equal(parseNumberWithCommas('14,020'), 14020);
  assert.equal(parseNumberWithCommas('174'), 174);
  assert.equal(parseNumberWithCommas(''), 0);
});

test('extractOfficialTodayPoints 提取今日真实积分 (对标图 5)', () => {
  const flightSample = 'some prefix "text-pageHeader", key: "abc", children: "174" some suffix';
  const points = extractOfficialTodayPoints(flightSample, '');
  assert.equal(points, 174);

  const domSample = '<div class="flex"><p>今日积分</p><p class="text-pageHeader">210</p></div>';
  const domPoints = extractOfficialTodayPoints('', domSample);
  assert.equal(domPoints, 210);
});

test('extractOfficialBalance 提取可用积分余额 (对标图 6)', () => {
  const domSample = '<div class="flex"><p>可用积分</p><p class="text-pageHeader">14,020</p></div>';
  const balance = extractOfficialBalance('', domSample);
  assert.equal(balance, 14020);
});

test('extractOfficialStreakDays 提取连续打卡天数 (对标图 5)', () => {
  const domSample = '<div class="flex"><p>每日连续打卡</p><p class="text-pageHeader">125</p></div>';
  const days = extractOfficialStreakDays('', domSample);
  assert.equal(days, 125);
});

test('extractOfficialClaimablePoints 提取待领抽屉积分 (对标图 6)', () => {
  const domSample = '<div class="card"><p class="text-labelControl">可领取</p><p>3</p><span>领取</span></div>';
  const claimable = extractOfficialClaimablePoints('', domSample);
  assert.equal(claimable, 3);
});

test('validateStrictMetrics 绝不造假原则：今日积分仅由官网值决定', () => {
  const res = validateStrictMetrics({ officialToday: 174, previousToday: 120 });
  assert.equal(res.valid, true);
  assert.equal(res.earned, 174);
  assert.equal(res.delta, 54);
});
