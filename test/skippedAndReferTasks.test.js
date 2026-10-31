import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskFeasibility } from '../src/contracts/streaks.js';
import { buildOfficialTaskSnapshot } from '../src/core/taskManager.js';

const todayStr = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
})();

test('推荐/邀请类任务被判定为不可执行（参考项目 SKIP_PATTERNS 同样跳过 referral）', () => {
  const refer = classifyTaskFeasibility('将推荐转化为奖励 当朋友在 Bing 上搜索时可赚取 7,500 积分。只需分享邀请即可。 +10', {
    href: 'https://rewards.bing.com/referandearn?form=ML2X5V&OCID=ML2X5V'
  });
  assert.equal(refer.executable, false);
  assert.match(refer.tag, /推荐\/邀请类/);

  // 只有 href 命中 referandearn 也要拦住
  const byHref = classifyTaskFeasibility('分享给好友', { href: 'https://rewards.bing.com/referandearn' });
  assert.equal(byHref.executable, false);

  // 普通日常活动不受影响
  const quiz = classifyTaskFeasibility('你是否知道答案？ 通过这些小问题挑战自己 +5', {
    href: 'https://www.bing.com/search?q=Bing%20Homepage%20quiz'
  });
  assert.equal(quiz.executable, true);
});

test('快照解析 Edge 浏览连续打卡的分钟进度并放入仅展示清单', () => {
  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 2/3\n分钟: 0/30\n签到: 1/1',
    sections: [],
    searchPoints: { current: 60, max: 60, isMaxed: true }
  });

  assert.deepEqual(snapshot.edgeBrowse, { current: 0, max: 30 });

  const edgeCard = snapshot.streakCards.find((card) => card.id === 'streak_edge_browse');
  assert.equal(edgeCard.progress, 0);
  assert.equal(edgeCard.max, 30);
  assert.equal(edgeCard.executable, false);
  assert.equal(edgeCard.done, false);

  const edgeSkipped = snapshot.skippedTasks.find((item) => item.title === 'Edge 浏览连续打卡');
  assert.ok(edgeSkipped, 'Edge 30 分钟必须出现在仅展示清单里');
  assert.equal(edgeSkipped.source, 'streak');
  assert.equal(edgeSkipped.progress, 0);
  assert.match(edgeSkipped.reason, /Edge/);

  // 快照四张连续打卡卡齐全，可执行项进度来自官网计数器
  assert.deepEqual(snapshot.streakCards.map((c) => c.id), [
    'streak_bing_search',
    'streak_dailyset',
    'streak_edge_browse',
    'streak_bing_app'
  ]);
  assert.equal(snapshot.streakCards.find((c) => c.id === 'streak_dailyset').progress, 2);
});

test('「将推荐转化为奖励」只展示状态，不进入待做循环', () => {
  const referCard = {
    title: '将推荐转化为奖励 当朋友在 Bing 上搜索时可赚取 7,500 积分。只需分享邀请即可。',
    href: 'https://rewards.bing.com/referandearn?form=ML2X5V',
    done: false,
    disabled: false,
    executable: false,
    feasibilityTag: '【推荐/邀请类 (跳过)】',
    feasibilityReason: '仅当被邀请的真实好友通过邀请链接使用必应后才计分'
  };

  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [{ title: '日常任务', cards: [referCard] }],
    searchPoints: { current: 60, max: 60, isMaxed: true }
  });

  assert.equal(snapshot.referShare.found, true);
  assert.equal(snapshot.referShare.executable, false);
  assert.equal(snapshot.needDailyActivities, false, '推荐卡不能把账号重新判成"有日常任务待做"');
  assert.deepEqual(snapshot.dailyPending, []);
  assert.ok(snapshot.skippedTasks.some((item) => item.source === 'refer'));
  assert.equal(snapshot.referShare.attemptedAt, 0);
});

test('仅展示清单：已完成卡片与打孔卡不得出现在"不可执行"列表里', () => {
  const doneCard = {
    title: '你是否知道答案？ 通过这些小问题挑战自己 5 已完成',
    href: 'https://www.bing.com/search?q=Bing%20Homepage%20quiz',
    done: true,
    disabled: false,
    executable: false,
    feasibilityTag: '【无积分/仅营销 (跳过)】',
    feasibilityReason: '未发现可验证的积分奖励标记'
  };
  const questCard = {
    title: '通过 Microsoft Rewards 解锁免费 Super Duolingo 5/6 个任务',
    href: '/earn/quest/WW_pcparent_FY27_Duolingo3M_punchcard',
    done: false,
    disabled: false,
    executable: false,
    feasibilityTag: '【打孔卡/任务链 (跳过)】'
  };
  const pendingSkipCard = {
    title: '每天一张新壁纸 一次一张照片，探索世界。立即安装必应壁纸。',
    href: 'https://www.bing.com/apps/wallpaper?pc=W317',
    done: false,
    disabled: false,
    executable: false,
    feasibilityTag: '【客户端/安装引导 (跳过)】',
    feasibilityReason: '依赖客户端或扩展安装，无法通过网页交互完成'
  };

  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [
      { title: '日常任务', cards: [doneCard, pendingSkipCard] },
      { title: '任务', cards: [questCard] }
    ]
  });

  const titles = snapshot.skippedTasks.map((item) => item.title);
  assert.ok(!titles.some((t) => t.includes('你是否知道答案')), '已完成的卡片不能出现在仅展示清单');
  assert.ok(!titles.some((t) => t.includes('Super Duolingo')), '打孔卡由任务链负责，不进仅展示清单');
  assert.ok(titles.some((t) => t.includes('壁纸')), '未完成且不可执行的真实跳过项必须可见');
  // 打孔卡仍然进入 questPending 由任务链推进
  assert.equal(snapshot.questPending.length, 1);
});

test('当日已尝试过邀请分享时，状态里保留尝试结果', () => {
  const referCard = {
    title: '将推荐转化为奖励',
    href: 'https://rewards.bing.com/referandearn',
    done: false,
    disabled: false,
    executable: false
  };

  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [{ title: '日常任务', cards: [referCard] }],
    account: { referShare: { date: todayStr, attemptedAt: Date.now(), result: 'not-found' } }
  });

  assert.ok(snapshot.referShare.attemptedAt > 0);
  assert.equal(snapshot.referShare.lastResult, 'not-found');
  const referSkipped = snapshot.skippedTasks.find((item) => item.source === 'refer');
  assert.match(referSkipped.reason, /今日已尝试/);
});
