import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDapiDailySetOfferIds,
  buildDapiDailySetCards,
  compactDateKey,
  isDapiClaimConfirmed
} from '../src/contracts/dapiDailySet.js';

test('按日期生成 App Daily Set 三个 Child offerId（对齐参考项目 v1.10.10）', () => {
  const now = new Date(2026, 10, 4, 10, 0, 0).getTime();
  assert.equal(compactDateKey(now), '20261104');
  assert.deepEqual(buildDapiDailySetOfferIds(now), [
    'Gamification_DailySet_ZHCN_20261104_Child1',
    'Gamification_DailySet_ZHCN_20261104_Child2',
    'Gamification_DailySet_ZHCN_20261104_Child3'
  ]);
  assert.deepEqual(buildDapiDailySetOfferIds(now, 'ENUS')[0], 'Gamification_DailySet_ENUS_20261104_Child1');
});

test('兜底卡片形状：每张 10 分、category=dailyset、kind=dapi_reward', () => {
  const cards = buildDapiDailySetCards(new Date(2026, 10, 4).getTime());
  assert.equal(cards.length, 3);
  assert.ok(cards.every((c) => c.points === 10));
  assert.ok(cards.every((c) => c.category === 'dailyset'));
  assert.ok(cards.every((c) => c.kind === 'dapi_reward'));
  assert.ok(cards.every((c) => c.offerId.includes('_20261104_Child')));
});

test('DAPI 领取回执判定：必须 code=0 且拿到积分或余额', () => {
  assert.equal(isDapiClaimConfirmed({ code: 0, response: { activity: { p: 10 }, balance: 100 } }), true);
  assert.equal(isDapiClaimConfirmed({ code: 0, response: { balance: 8800 } }), true, '只有余额也可确认');
  assert.equal(isDapiClaimConfirmed({ code: 0, response: { activity: { p: 0 } } }), false, '没加分不算成功');
  assert.equal(isDapiClaimConfirmed({ code: 452, response: {} }), false);
  assert.equal(isDapiClaimConfirmed(null), false);
});
