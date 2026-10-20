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

test('classifyTaskFeasibility 仅放行有积分且可网页交互的日常活动', () => {
  const fossil = classifyTaskFeasibility('化石精选 拓展你的恐龙知识 +15', {
    href: 'https://www.bing.com/search?q=dinosaurs&form=WNSGPH',
    pointText: '+15'
  });
  assert.equal(fossil.executable, true);
  assert.equal(fossil.kind, 'search-exploration');

  const quiz = classifyTaskFeasibility('你是否知道答案？ 测试你对这些主题的知识 +5', {
    pointText: '+5'
  });
  assert.equal(quiz.executable, true);

  const puzzle = classifyTaskFeasibility('完成此拼图 排列图块以显示图像 +5', {
    href: 'https://www.bing.com/spotlight/imagepuzzle',
    pointText: '+5'
  });
  assert.equal(puzzle.executable, true);
  assert.equal(puzzle.kind, 'puzzle');
});

test('buildUnifiedTaskBoard 保留日常活动执行策略且不重复归类打孔卡', () => {
  const board = buildUnifiedTaskBoard({}, [
    {
      offerId: 'fossil',
      title: '化石精选 拓展你的恐龙知识 +15',
      pointProgressMax: 15,
      destination: 'https://www.bing.com/search?q=dinosaurs&form=WNSGPH'
    },
    {
      offerId: 'marketing',
      title: '免费获取 Super 只需完成一组活动，即可免费享受 2 个月的 Super Duolingo。',
      destination: 'https://www.bing.com/search?q=duolingo'
    }
  ]);
  assert.equal(board[TASK_SECTIONS.DAILY].length, 2);
  assert.equal(board[TASK_SECTIONS.DAILY][0].executable, true);
  assert.equal(board[TASK_SECTIONS.DAILY][0].kind, 'search-exploration');
  assert.equal(board[TASK_SECTIONS.DAILY][1].executable, false);
  assert.equal(board[TASK_SECTIONS.PUNCH_CARDS].length, 0);
});
test('classifyTaskFeasibility 保守过滤营销、打孔卡和客户端项目', () => {
  const marketing = classifyTaskFeasibility('免费获取 Super 只需完成一组活动，即可免费享受 2 个月的 Super Duolingo。');
  assert.equal(marketing.executable, false);
  assert.ok(marketing.tag.includes('营销'));

  const punchCard = classifyTaskFeasibility('到期日期 2周后 50分的万圣节礼遇 +50 5/6 个任务', {
    href: 'https://rewards.bing.com/earn/quest/WW_pcparent_HalloweenQuestROWOct26_punchcard',
    pointText: '+50'
  });
  assert.equal(punchCard.executable, false);
  assert.ok(punchCard.tag.includes('打孔卡'));

  const wallpaper = classifyTaskFeasibility('每天一张新壁纸 一次一张照片，探索世界。立即安装必应壁纸。 +10');
  assert.equal(wallpaper.executable, false);
  assert.ok(wallpaper.tag.includes('客户端/安装'));

  const searchBar = classifyTaskFeasibility('使用搜索栏赚取 100 积分 启用搜索栏并连续使用 3 天可赚取 100 积分');
  assert.equal(searchBar.executable, false);
  assert.ok(searchBar.tag.includes('客户端搜索栏'));

  const missingPoints = classifyTaskFeasibility('探索今日精选内容');
  assert.equal(missingPoints.executable, false);
  assert.ok(missingPoints.tag.includes('无积分'));
});
