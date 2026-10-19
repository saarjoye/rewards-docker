import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTaskFeasibility, buildUnifiedTaskBoard, TASK_SECTIONS } from '../src/contracts/streaks.js';

test('classifyTaskFeasibility 黑名单不可执行任务准确识别', () => {
  const edgeTask = classifyTaskFeasibility('Edge 浏览连续打卡 30分钟');
  assert.equal(edgeTask.executable, false);
  assert.ok(edgeTask.tag.includes('客户端硬件遥测限制'));

  const defaultEngine = classifyTaskFeasibility('将必应设置为默认搜索引擎 14 天');
  assert.equal(defaultEngine.executable, false);
  assert.ok(defaultEngine.tag.includes('客户端环境配置项'));

  const xboxTask = classifyTaskFeasibility('获取 XBOX Game Pass Ultimate 会员');
  assert.equal(xboxTask.executable, false);
  assert.ok(xboxTask.tag.includes('外部付费消费项'));

  const dailySet = classifyTaskFeasibility('每日活动集 (Daily Set)');
  assert.equal(dailySet.executable, true);
});

test('buildUnifiedTaskBoard 正确生成四大板块任务树', () => {
  const rawCards = [
    { offerId: 'card_1', title: '50分的万圣节礼遇', isQuest: true, points: 50, isCompleted: false },
    { offerId: 'card_2', title: '完成此拼图', points: 5, isCompleted: true }
  ];

  const board = buildUnifiedTaskBoard({ stampsProgress: 2, streakDays: 10 }, rawCards);

  assert.ok(Array.isArray(board[TASK_SECTIONS.STREAKS]));
  assert.ok(Array.isArray(board[TASK_SECTIONS.LEVEL_UP]));
  assert.equal(board[TASK_SECTIONS.PUNCH_CARDS].length, 1);
  assert.equal(board[TASK_SECTIONS.DAILY].length, 1);
});
