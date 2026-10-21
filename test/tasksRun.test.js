import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/web/server.js';
import taskManager, {
  buildOfficialTaskSnapshot,
  buildTaskPlan,
  parseOfficialSearchPointsDetail
} from '../src/core/taskManager.js';
import configManager from '../src/config.js';
import { createAdminSessionToken, getAdminSessionCookieName } from '../src/identity/adminAuth.js';
import http from 'http';

test('POST /api/tasks/run 灵活任务调度接口测试', async () => {
  const origAdmin = JSON.parse(JSON.stringify(configManager.get().admin || {}));
  configManager.setAdminCredentials('admin_test', 'test_salt', 'test_hash');
  const secret = configManager.ensureAdminSessionSecret();
  const token = createAdminSessionToken('admin_test', secret);
  const authHeaders = {
    'Content-Type': 'application/json',
    Cookie: `${getAdminSessionCookieName()}=${encodeURIComponent(token)}`
  };

  const origRunAll = taskManager.runAllAccountsTasks;
  const origRunSingle = taskManager.runAccountTasks;
  taskManager.runAllAccountsTasks = async () => ({ success: true });
  taskManager.runAccountTasks = async () => ({ success: true });

  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 1. 测试 single 模式缺少 accountId 报错
    const errRes = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountScope: 'single' })
    });
    assert.equal(errRes.status, 400);

    // 2. 测试 single 模式账号不存在报错
    const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountScope: 'single', accountId: 'non_existent_acc' })
    });
    assert.equal(notFoundRes.status, 404);

    // 3. 测试 all 模式正常接收
    const allRes = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ accountScope: 'all', taskScope: 'search' })
    });
    assert.equal(allRes.status, 200);
    const allData = await allRes.json();
    assert.equal(allData.success, true);
    assert.ok(allData.message.includes('全部已启用账号'));
  } finally {
    taskManager.runAllAccountsTasks = origRunAll;
    taskManager.runAccountTasks = origRunSingle;
    configManager.get().admin = origAdmin;
    configManager.save();
    server.close();
  }
});

test('积分明细只从当前账号搜索行读取搜索上限', () => {
  const parsed = parseOfficialSearchPointsDetail('今日积分\n250\n必应搜索\n30/30\n优惠\n220');
  assert.deepEqual(parsed, {
    current: 30,
    max: 30,
    isMaxed: true,
    source: 'points-detail'
  });
  assert.equal(parseOfficialSearchPointsDetail('搜索: 1/1\n今日积分 250\n优惠 220'), null);
  assert.equal(parseOfficialSearchPointsDetail('必应搜索\n31/30'), null);
});

test('剩余任务快照严格区分未知、完成和待做', () => {
  const unknownSearch = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3',
    sections: []
  });
  assert.equal(unknownSearch.needSearch, null);
  assert.equal(unknownSearch.needDailySet, false);
  assert.equal(unknownSearch.needAppSign, null);
  assert.equal(unknownSearch.hasUnknown, true);

  const complete = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [
      { title: '日常任务', cards: [{ title: 'x', done: true, disabled: false }] },
      { title: '任务', cards: [{ title: 'q', done: true, disabled: false }] }
    ],
    searchPoints: { current: 30, max: 30, isMaxed: true }
  });
  assert.equal(complete.hasWork, false);
  assert.equal(complete.hasUnknown, false);
});

test('remaining 只执行官网明确 true 的任务，unknown 不会被当成待做', () => {
  const plan = buildTaskPlan('remaining', {
    needSearch: null,
    needAppSign: true,
    needDailySet: false,
    needQuests: null,
    needDailyActivities: true
  });
  assert.deepEqual(plan, {
    appSign: true,
    dailySet: false,
    quests: false,
    dailyActivities: true,
    search: false
  });
  assert.deepEqual(buildTaskPlan('remaining', null), {
    appSign: false,
    dailySet: false,
    quests: false,
    dailyActivities: false,
    search: false
  });
});

test('多步打孔卡当日已推进记忆保护：排除已推进任务，防止死循环重复执行', () => {
  const questHref = '/earn/quest/WW_pcparent_FY27_Duolingo3M_punchcard';
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const accountDone = {
    dailyQuestsDone: {
      date: todayStr,
      hrefs: [questHref]
    }
  };

  const snapshot = buildOfficialTaskSnapshot({
    text: '搜索: 1/1\n活动: 3/3\n签到: 1/1',
    sections: [
      {
        title: '任务',
        cards: [
          { title: '通过 Microsoft Rewards 解锁免费 Super Duolingo 1/6 个任务', href: questHref, done: false, disabled: false }
        ]
      }
    ],
    searchPoints: { current: 60, max: 60, isMaxed: true },
    account: accountDone
  });

  // 验证已被当日记忆排除，不再列入待做项
  assert.equal(snapshot.questPending.length, 0);
  assert.equal(snapshot.needQuests, false);
  assert.equal(snapshot.questsTodayDone, true);
  assert.equal(snapshot.hasWork, false);
});
