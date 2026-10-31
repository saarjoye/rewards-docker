import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStreakModels } from '../src/contracts/streaks.js';
import { buildOfficialTaskSnapshot } from '../src/core/taskManager.js';

test('extractStreakModels 主解析：标准 streak 模型（model.streak 形态）', () => {
  // RSC chunk 经 JSON.parse 还原后是未转义的形态
  const html = '{"props":{"model":{"streak":{"partner":"bing","completedDays":4,"currentDay":5,"isCurrentDayCompleted":true}}}}';
  const streaks = extractStreakModels(html);
  assert.equal(streaks.bing.completedDays, 4);
  assert.equal(streaks.bing.currentDay, 5);
  assert.equal(streaks.bing.isCurrentDayCompleted, true);
});

test('extractStreakModels 兜底解析：只有 partner 埋点 + 真实模型时，必须挑带 completedDays 的窗口', () => {
  // 第一处是埋点（没有 completedDays），第二处才是真实模型
  const html = [
    '{"partner":"bing","eventType":"streakImpression"}',
    '{"partner":"bing","completedDays":3,"currentDay":4,"isCurrentDayCompleted":true}',
    '{"partner":"dailyset","completedDays":5,"currentDay":6,"activitiesCompleted":2,"isCurrentDayCompleted":false}',
    '{"partner":"edge","completedDays":0,"currentDay":1,"isCurrentDayCompleted":false}',
    '{"partner":"bingapp","completedDays":2,"currentDay":3,"activitiesCompleted":1,"activitiesTotal":1,"isCurrentDayCompleted":true}'
  ].join('');

  const streaks = extractStreakModels(html);
  assert.equal(streaks.bing.completedDays, 3);
  assert.equal(streaks.bing.currentDay, 4);
  assert.equal(streaks.dailyset.activitiesCompleted, 2);
  // edge 的 0/7 不得串到 bingapp 上
  assert.equal(streaks.bingapp.completedDays, 2);
  assert.equal(streaks.bingapp.isCurrentDayCompleted, true);
});

test('extractStreakModels 完全不匹配时返回空对象（前端据此显示"未返回"而不是造假进度）', () => {
  assert.deepEqual(extractStreakModels('完全没有连签数据的页面文本'), {});
});

test('快照优先用 streak 模型判定 Daily Set / App 签到，避免 2/3 假待做', () => {
  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 2/3\n签到: 0/1',
    sections: [],
    searchPoints: { current: 60, max: 60, isMaxed: true },
    streaks: {
      bing: { completedDays: 3, currentDay: 4, isCurrentDayCompleted: true },
      dailyset: { completedDays: 5, currentDay: 6, activitiesCompleted: 3, activitiesTotal: 3, isCurrentDayCompleted: true },
      bingapp: { completedDays: 2, currentDay: 3, isCurrentDayCompleted: true }
    }
  });

  assert.deepEqual(snapshot.dailySet, { current: 3, max: 3, source: 'streak-model', isCurrentDayCompleted: true });
  assert.deepEqual(snapshot.appCheckIn, { current: 1, max: 1, source: 'streak-model' });
  assert.equal(snapshot.needDailySet, false);
  assert.equal(snapshot.needAppSign, false);
  assert.equal(snapshot.streaks.bing.completedDays, 3);
});

test('没有 streak 模型时仍按文本计数器兜底（保持原行为）', () => {
  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 2/3\n签到: 0/1',
    sections: []
  });
  assert.equal(snapshot.dailySet.current, 2);
  assert.equal(snapshot.dailySet.max, 3);
  assert.equal(snapshot.needDailySet, true);
  assert.equal(snapshot.needAppSign, true);
});
