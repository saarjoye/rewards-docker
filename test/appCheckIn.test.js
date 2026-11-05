import test from 'node:test';
import assert from 'node:assert/strict';
import { getDapiCheckInStatus, isCheckInPromotion, DAPI_CHECKIN_OFFER_ID } from '../src/contracts/appCheckIn.js';

const today = new Date(2026, 10, 5, 10, 0, 0).getTime();

test('DAPI 签到状态：last_updated 是今天即视为已签到', () => {
  const promotions = [
    { type: 'sapphire', offerId: 'Sapphire_AppNewBonus_dailyset_offer' },
    { type: 'checkin', offerId: DAPI_CHECKIN_OFFER_ID, last_updated: '2026-11-05T01:23:06.3875978+00:00', progress: 3 }
  ];
  const status = getDapiCheckInStatus(promotions, today);
  assert.equal(status.isCurrentDayCompleted, true);
  assert.equal(status.activitiesCompleted, 1);
  assert.equal(status.activitiesTotal, 1);
  assert.equal(status.source, 'dapi');
});

test('DAPI 签到状态：last_updated 是昨天则未完成', () => {
  const promotions = [
    { type: 'checkin', offerId: DAPI_CHECKIN_OFFER_ID, last_updated: '2026-11-04T01:23:06+00:00', progress: 3 }
  ];
  assert.equal(getDapiCheckInStatus(promotions, today).isCurrentDayCompleted, false);
});

test('DAPI 签到状态：complete=true 也算完成；找不到签到项返回 null', () => {
  const done = getDapiCheckInStatus([{ type: 'checkin', offerId: DAPI_CHECKIN_OFFER_ID, complete: true, last_updated: '2026-10-01T00:00:00Z' }], today);
  assert.equal(done.isCurrentDayCompleted, true);
  assert.equal(getDapiCheckInStatus([{ type: 'sapphire', offerId: 'x' }], today), null);
  assert.equal(getDapiCheckInStatus(null, today), null);
});

test('签到项识别：type=checkin 或固定 offerId', () => {
  assert.equal(isCheckInPromotion({ type: 'checkin' }), true);
  assert.equal(isCheckInPromotion({ offerId: 'Gamification_Sapphire_DailyCheckIn' }), true);
  assert.equal(isCheckInPromotion({ attributes: { offerid: 'Gamification_Sapphire_DailyCheckIn' } }), true);
  assert.equal(isCheckInPromotion({ type: 'sapphire', offerId: 'other' }), false);
});
