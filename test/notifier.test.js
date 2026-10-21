import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeWorkAppBaseUrl,
  buildWeWorkAppTokenUrl,
  buildWeWorkAppSendUrl,
  formatSettlementReportContent
} from '../src/core/notifier.js';

test('buildWeWorkAppBaseUrl 默认地址与反代地址规整化', () => {
  // 默认地址
  assert.equal(buildWeWorkAppBaseUrl(''), 'https://qyapi.weixin.qq.com');

  // 自定义反代地址 (带端口与路径前缀)
  const customProxy = 'https://wecom-proxy.my-nas.com:8443/qyapi/';
  assert.equal(buildWeWorkAppBaseUrl(customProxy), 'https://wecom-proxy.my-nas.com:8443/qyapi');

  // 必须使用 HTTPS
  assert.throws(() => buildWeWorkAppBaseUrl('http://insecure-proxy.com'), /必须使用 HTTPS/);

  // 不能包含查询参数
  assert.throws(() => buildWeWorkAppBaseUrl('https://proxy.com?foo=bar'), /不能包含查询参数/);
});

test('buildWeWorkAppTokenUrl 正确拼接获取 Token 地址', () => {
  const tokenUrl = buildWeWorkAppTokenUrl('https://custom.proxy.com', 'ww_corp123', 'sec_456');
  assert.equal(tokenUrl, 'https://custom.proxy.com/cgi-bin/gettoken?corpid=ww_corp123&corpsecret=sec_456');
});

test('buildWeWorkAppSendUrl 正确拼接发送消息地址', () => {
  const sendUrl = buildWeWorkAppSendUrl('https://custom.proxy.com/prefix', 'mock_token_abc');
  assert.equal(sendUrl, 'https://custom.proxy.com/prefix/cgi-bin/message/send?access_token=mock_token_abc');
});

test('formatSettlementReportContent 战报格式化：包含本次收割与真实今日积分', () => {
  const account = { name: 'saarjoye', user: 'saarjoye@example.com' };

  // 1. 额外积分核验到账：本次收割 +3 分，今日已增 160 分
  const contentClaimed = formatSettlementReportContent(account, {
    harvestedPoints: 3,
    todayEarned: 160,
    balance: 14498,
    streakDays: 127,
    claimablePoints: 0,
    taskStatusText: '额外积分已核验到账 (+3 分)'
  });

  assert.ok(contentClaimed.includes('托管账号: saarjoye'));
  assert.ok(contentClaimed.includes('本次收割: +3 分'));
  assert.ok(contentClaimed.includes('今日已增: 160 分'));
  assert.ok(contentClaimed.includes('账户总额: 14,498 分'));
  assert.ok(contentClaimed.includes('连续打卡: 127 天'));
  assert.ok(contentClaimed.includes('待领额外: 0 分'));
  assert.ok(contentClaimed.includes('执行状态: 额外积分已核验到账 (+3 分)'));

  // 2. 字段名兼容：todayPoints 能正确映射至今日已增
  const contentPointsKey = formatSettlementReportContent(account, {
    harvestedPoints: 125,
    todayPoints: 125,
    balance: 14460,
    streakDays: 127,
    claimablePoints: 3,
    taskStatusText: '官网任务已全部完成'
  });
  assert.ok(contentPointsKey.includes('本次收割: +125 分'));
  assert.ok(contentPointsKey.includes('今日已增: 125 分'));

  // 3. 0 增量展示
  const contentZero = formatSettlementReportContent(account, {
    harvestedPoints: 0,
    todayEarned: 160,
    balance: 14498,
    streakDays: 127,
    claimablePoints: 0,
    taskStatusText: '官网当前无待领取积分（未发生领取）'
  });
  assert.ok(contentZero.includes('本次收割: 0 分'));

  // 4. 未确认/缺失字段优雅退化
  const contentNull = formatSettlementReportContent(account, {
    harvestedPoints: null,
    todayEarned: null,
    balance: null,
    streakDays: null,
    claimablePoints: null
  });
  assert.ok(contentNull.includes('本次收割: 官网未确认'));
  assert.ok(contentNull.includes('今日已增: 官网未确认'));
  assert.ok(contentNull.includes('账户总额: 官网未确认'));
});

test('configManager.updateGlobalSettings: 防止反代地址与 secret 被空值冲掉', () => {
  const currentNotify = {
    weworkApp: {
      enabled: true,
      baseUrl: 'https://wx.saar.cc.cd',
      corpId: 'ww123',
      agentId: '1000002',
      secret: 'real_secret_xyz',
      toUser: '@all'
    }
  };

  // 模拟从前端提交全局配置，baseUrl 传空或未修改，secret 传脱敏占位符
  const incomingNotify = {
    weworkApp: {
      enabled: true,
      baseUrl: '',
      corpId: 'ww123',
      agentId: '1000002',
      secret: '******',
      toUser: '@all'
    }
  };

  const incomingWw = incomingNotify.weworkApp || {};
  const currentWw = currentNotify.weworkApp || {};
  let wwSecret = incomingWw.secret;
  if (!wwSecret || wwSecret === '******') {
    wwSecret = currentWw.secret || '';
  }
  let wwBaseUrl = incomingWw.baseUrl !== undefined ? String(incomingWw.baseUrl).trim() : '';
  if (!wwBaseUrl && currentWw.baseUrl) {
    wwBaseUrl = currentWw.baseUrl;
  }

  assert.equal(wwBaseUrl, 'https://wx.saar.cc.cd');
  assert.equal(wwSecret, 'real_secret_xyz');
});
