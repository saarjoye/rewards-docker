import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStreakSectionText } from '../src/contracts/streakSection.js';
import { buildOfficialTaskSnapshot } from '../src/core/taskManager.js';

// 取自官网 /earn 页面「连续打卡任务」区块的真实 innerText（脱敏后）
const REAL_SECTION_TEXT = [
  '连续打卡任务',
  '每日连胜重置 13小时后',
  '1,000 奖励',
  '赚取 12 个印章，赢取丰厚奖励积分',
  '了解详细信息',
  '必应搜索连续打卡',
  '已完成连续打卡 2 天，共 7 天。',
  '完成下一天即可赚取 3 积分。',
  '3',
  '100',
  '搜索: 1/1',
  '每日连续打卡活动',
  '已完成连续打卡 4 天，共 7 天。',
  '完成下一天即可赚取 30 积分。',
  '+30',
  '100',
  '活动: 2/3',
  '必应应用连续打卡',
  '已完成连续打卡 6 天，共 7 天。',
  '完成下一天即可赚取 50 积分。',
  '15',
  '50',
  '签到: 1/1'
].join('\n');

test('parseStreakSectionText 解析官网真实连签天数（bing 2 / dailyset 4 / bingapp 6）', () => {
  const streaks = parseStreakSectionText(REAL_SECTION_TEXT);
  assert.equal(streaks.bing.completedDays, 2);
  assert.equal(streaks.bing.isCurrentDayCompleted, true, '搜索 1/1 说明今天已打卡');
  assert.equal(streaks.dailyset.completedDays, 4);
  assert.equal(streaks.dailyset.activitiesCompleted, 2);
  assert.equal(streaks.dailyset.activitiesTotal, 3);
  assert.equal(streaks.dailyset.isCurrentDayCompleted, false, '活动 2/3 说明今天还没做完');
  assert.equal(streaks.dailyset.currentDay, 5);
  assert.equal(streaks.bingapp.completedDays, 6);
  assert.equal(streaks.bingapp.isCurrentDayCompleted, true);
  assert.equal(streaks.edge, undefined, 'Edge 30 分钟由 edgeBrowse 计数器单独呈现');
});

test('parseStreakSectionText 对空文本 / 无连签信息安全返回空对象', () => {
  assert.deepEqual(parseStreakSectionText(''), {});
  assert.deepEqual(parseStreakSectionText('连续打卡任务\n随便一些文字'), {});
});

test('连签区块解析结果可直接驱动快照的 Daily Set / App 判定', () => {
  const streaks = parseStreakSectionText(REAL_SECTION_TEXT);
  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 2/3\n签到: 1/1',
    sections: [],
    streaks
  });
  // dailyset 模型：2/3 -> 仍需补完（文本口径一致，不再误判为已完成 3/3）
  assert.equal(snapshot.dailySet.current, 2);
  assert.equal(snapshot.dailySet.max, 3);
  assert.equal(snapshot.needDailySet, true);
  // bingapp 模型：今天已签到
  assert.equal(snapshot.appCheckIn.current, 1);
  assert.equal(snapshot.needAppSign, false);
  assert.equal(snapshot.streaks.bing.completedDays, 2);
});
