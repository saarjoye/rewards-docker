import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuestSubtaskCompleted,
  parseQuestProgress,
  classifyQuestAction,
  questSubtaskKey,
  isDailyQuestSubtask,
  isQuestSubtaskCoolingDown
} from '../src/core/questStatus.js';
import {
  SPECIAL_ACTIVITIES,
  extractSpecialActivitiesFromHtml,
  classifySpecialActivity,
  findSpecialActivity
} from '../src/core/specialActivities.js';

test('questStatus: 真实图标与文本状态准确判定', () => {
  // 1. 图标判定优先级高于普通文本
  assert.equal(isQuestSubtaskCompleted({ hasSuccessIcon: true, rawText: '进行中 (1/5)' }), true);
  assert.equal(isQuestSubtaskCompleted({ hasEmptyCircle: true, rawText: '1/5 天已完成' }), false);
  assert.equal(isQuestSubtaskCompleted({ rawText: '已完成' }), true);
  assert.equal(isQuestSubtaskCompleted({ rawText: 'Complete' }), true);

  // 2. 进度解析
  const p1 = parseQuestProgress('在 Bing 上搜索 (1 / 5 天)');
  assert.deepEqual(p1, { progress: 1, max: 5, done: false });
  const p2 = parseQuestProgress('完成 3 / 3 项活动');
  assert.deepEqual(p2, { progress: 3, max: 3, done: true });

  // 3. 动作分类：准确区分 search, activate, quiz, visit
  assert.equal(classifyQuestAction({ title: '每日搜索打卡', actionText: '开始搜索' }), 'search');
  assert.equal(classifyQuestAction({ title: '万圣节主题活动', actionText: '立即激活' }), 'activate');
  assert.equal(classifyQuestAction({ title: '热点测验', actionText: '立即答题' }), 'quiz');
  assert.equal(classifyQuestAction({ title: '探索新功能', actionText: '去看看' }), 'visit');

  // 4. 每日打卡与冷却检测
  assert.equal(isDailyQuestSubtask({ kind: 'search' }), true);
  assert.equal(isDailyQuestSubtask({ rawText: '连续 5 天打卡' }), true);
  assert.equal(isQuestSubtaskCoolingDown({ cooldownUntil: Date.now() + 100000 }), true);
  assert.equal(isQuestSubtaskCoolingDown({ cooldownUntil: Date.now() - 1000 }), false);
});

test('specialActivities: 识别并提取特殊营销活动卡片', () => {
  const mockHtml = `
    self.__next_f.push([1, "{\"offerId\":\"WW_Rewards_AdHoc_RewardsExtensionBrowser_20191028\",\"title\":\"浏览器中的奖励\",\"points\":30,\"isCompleted\":false,\"destination\":\"/set/browserextension/rewards\"}"])
  `;
  const cards = extractSpecialActivitiesFromHtml(mockHtml);
  assert.ok(cards.length > 0, '应提取到特殊活动卡片');
  const ext = findSpecialActivity(cards, SPECIAL_ACTIVITIES.browserExtension.key);
  assert.ok(ext, '应识别出 browserExtension');
  assert.equal(ext.awardPoints, 30);
  assert.equal(ext.isCompleted, false);
});
