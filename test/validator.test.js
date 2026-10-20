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

  // 真实 /earn 页面换行文本样本
  const earnTextSample = '首页\n积分赚取\n今日积分\n\n155\n\n积分明细\n每日连续打卡\n5';
  assert.equal(extractOfficialTodayPoints('', earnTextSample), 155);
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

test('extractOfficialClaimablePoints current zero wins over stale success toast', () => {
  const liveZero = '<div class="text-labelControl">\u53ef\u9886\u53d6</div><div class="text-pageHeader">0</div><div>\u9886\u53d6</div>';
  assert.equal(extractOfficialClaimablePoints('', liveZero), 0);

  const staleToast = '<div>\u5df2\u6210\u529f\u9886\u53d6</div><div class="text-labelControl">\u53ef\u9886\u53d6</div><div class="text-pageHeader">6</div><div>\u9886\u53d6</div>';
  assert.equal(extractOfficialClaimablePoints('', staleToast), 6);
});

test('extractOfficialClaimablePoints returns null without official evidence', () => {
  assert.equal(extractOfficialClaimablePoints('', '<div>maintenance</div>'), null);
});

test('extractOfficialClaimablePoints current positive card wins over hidden zero and stale Flight', () => {
  const liveCard = '<div class="text-labelControl">\u53ef\u9886\u53d6</div><div class="text-pageHeader">3</div><div>\u9886\u53d6</div>';
  const hiddenZero = '<template>\u5f53\u524d\u6ca1\u6709\u8981\u9886\u53d6\u7684\u79ef\u5206</template>';
  const staleFlight = '"TotalClaimablePoints":0';
  assert.equal(extractOfficialClaimablePoints(staleFlight, liveCard + hiddenZero), 3);
});

test('validateStrictMetrics 绝不造假原则：今日积分仅由官网值决定', () => {
  const res = validateStrictMetrics({ officialToday: 174, previousToday: 120 });
  assert.equal(res.valid, true);
  assert.equal(res.earned, 174);
  assert.equal(res.delta, 54);
});
