import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuestSubtaskCooling,
  describeQuestCooling,
  hasDayLockHint,
  applyDayLock
} from '../src/contracts/questCooling.js';

test('自身锁定/客户端专属识别（不含时间锁文案）', () => {
  assert.equal(isQuestSubtaskCooling('奖励应用专属'), true);
  assert.equal(isQuestSubtaskCooling('明天再来'), true);
  assert.equal(isQuestSubtaskCooling('稍后再试'), true);
  assert.equal(isQuestSubtaskCooling('需在桌面 Rewards 应用中完成'), true);
  assert.equal(isQuestSubtaskCooling('十一月购物优惠 优惠购物'), false);
  assert.equal(isQuestSubtaskCooling('黑色星期五优惠 查看热门优惠'), false);
  // 关键回归：时间锁文案属于"下一项"，不能用来把当前项判成冷却
  assert.equal(isQuestSubtaskCooling('发现您喜爱的产品的季节性优惠。要获取第二个活动，请在完成第1天后等待24小时或更长时间。'), false);
  assert.match(describeQuestCooling('奖励应用专属'), /桌面奖励应用/);
});

test('识别页面的每日一步时间锁', () => {
  assert.equal(hasDayLockHint('要获取第二个活动，请在完成第1天后等待24小时或更长时间。'), true);
  assert.equal(hasDayLockHint('要获取你的第三个活动，请在完成第2天后等待24小时'), true);
  assert.equal(hasDayLockHint('完成任务活动1-5可赚取50奖励积分'), false);
});

test('applyDayLock：只把"第一个待做项之后"的项标成明日解锁', () => {
  const items = [
    { index: 1, title: '十一月购物优惠', completed: false, locked: false },
    { index: 2, title: '黑色星期五优惠', completed: false, locked: false },
    { index: 3, title: '11月电子产品优惠', completed: false, locked: false },
    { index: 4, title: '节省假日旅行开支', completed: false, locked: false },
    { index: 5, title: '探索节日食谱', completed: false, locked: false }
  ];
  const locked = applyDayLock(items, true);
  assert.equal(locked[0].dayLocked, false, '第一项今天可以做');
  assert.equal(locked[1].dayLocked, true);
  assert.equal(locked[4].dayLocked, true);

  // 第一项已完成时，第二项成为今天可做项
  const withFirstDone = applyDayLock([{ ...items[0], completed: true }, ...items.slice(1)], true);
  assert.equal(withFirstDone[0].dayLocked, false);
  assert.equal(withFirstDone[1].dayLocked, false);
  assert.equal(withFirstDone[2].dayLocked, true);

  // 页面没有时间锁时，一个都不标记
  const noLock = applyDayLock(items, false);
  assert.ok(noLock.every((item) => item.dayLocked === false));
});
