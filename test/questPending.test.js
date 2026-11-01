import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOfficialTaskSnapshot } from '../src/core/taskManager.js';
import { isQuestSubtaskCooling, describeQuestCooling } from '../src/contracts/questCooling.js';

const todayStr = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
})();

const OLD_QUEST = '/earn/quest/WW_pcparent_FY27_Duolingo3M_punchcard';
const NEW_QUEST = '/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Nov_punchcard';

function buildCards() {
  return [
    { title: '通过 Microsoft Rewards 解锁免费 Super Duolingo 4/6 个任务', href: OLD_QUEST, done: false, disabled: false },
    { title: '到期日期 4周后 十一月购物优惠、旅行省钱与季节精选指南 +50 0/5 个任务', href: NEW_QUEST, done: false, disabled: false }
  ];
}

test('按 href 记录已尝试：只屏蔽今天真的跑过的卡，当天新上线的卡仍可执行', () => {
  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [{ title: '任务', cards: buildCards() }],
    account: { dailyQuestsAttempted: { date: todayStr, attemptedAt: Date.now(), hrefs: [OLD_QUEST] } }
  });

  const pendingHrefs = snapshot.questPending.map((q) => q.href);
  assert.deepEqual(pendingHrefs, [NEW_QUEST], '只应保留今天还没跑过的新卡');
  assert.equal(snapshot.needQuests, true);
});

test('旧版日级记录（无 hrefs 字段）不再一刀切屏蔽全部打孔卡', () => {
  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [{ title: '任务', cards: buildCards() }],
    account: { dailyQuestsAttempted: { date: todayStr, attemptedAt: Date.now() } }
  });
  assert.equal(snapshot.questPending.length, 2);
});

test('所有卡都试过时正常判为无待做打孔卡', () => {
  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [{ title: '任务', cards: buildCards() }],
    account: { dailyQuestsAttempted: { date: todayStr, hrefs: [OLD_QUEST, NEW_QUEST] } }
  });
  assert.equal(snapshot.questPending.length, 0);
  assert.equal(snapshot.needQuests, false);
});

test('子任务冷却识别只看自身锁定信号（时间锁由页面级 applyDayLock 处理）', () => {
  assert.equal(isQuestSubtaskCooling('奖励应用专属'), true);
  assert.equal(isQuestSubtaskCooling('明天再来'), true);
  assert.equal(isQuestSubtaskCooling('十一月购物优惠 优惠购物'), false);
  // 时间锁文案属于"下一项"，不能把当前项判成冷却（v6.8.8 因此把 11 月卡 5 项全跳过）
  assert.equal(isQuestSubtaskCooling('要获取第二个活动，请在完成第1天后等待24小时或更长时间。'), false);
  assert.equal(isQuestSubtaskCooling(''), false);

  assert.match(describeQuestCooling('奖励应用专属'), /桌面奖励应用/);
  assert.equal(describeQuestCooling('正常任务'), '');
});
