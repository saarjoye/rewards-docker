import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESKTOP_APP_HEADERS,
  extractJsonObjectsWithKey,
  isServerActionAcknowledged,
  buildQuestRouterStateTree,
  weekdayFromOfferId,
  getDeploymentId
} from '../src/core/desktopQuest.js';

test('desktopQuest: 请求头与专属UA定义准确', () => {
  assert.equal(DESKTOP_APP_HEADERS['X-MSRewards-App'], '1');
  assert.equal(DESKTOP_APP_HEADERS['X-Rewards-Source'], 'msrewards-desktop');
  assert.ok(DESKTOP_APP_HEADERS['user-agent'].includes('MSRewards/Desktop'));
});

test('desktopQuest: extractJsonObjectsWithKey 准确提取嵌套的 WW_pcchild 对象', () => {
  const flightText = 'self.__next_f.push([1, "{\"offerId\":\"WW_pcchild1_Monday_search\",\"title\":\"周一搜索\",\"points\":10,\"hash\":\"abc123hash\",\"isCompleted\":false,\"isLocked\":false}{\"offerId\":\"WW_pcchild2_Tuesday_search\",\"title\":\"周二搜索\",\"points\":10,\"hash\":\"def456hash\",\"isCompleted\":false,\"isLocked\":true}"]\n';
  const objects = extractJsonObjectsWithKey(flightText);
  assert.equal(objects.length, 2);
  assert.equal(objects[0].offerId, 'WW_pcchild1_Monday_search');
  assert.equal(objects[0].hash, 'abc123hash');
  assert.equal(objects[0].isCompleted, false);
  assert.equal(objects[0].isLocked, false);
  assert.equal(objects[1].isLocked, true);
});

test('desktopQuest: buildQuestRouterStateTree 正确编码专享任务路由树', () => {
  const questId = 'WW_pcparent_RewardsApp_weekly_Exclusive';
  const encoded = buildQuestRouterStateTree(questId);
  const decoded = JSON.parse(decodeURIComponent(encoded));
  assert.ok(Array.isArray(decoded));
  assert.ok(encoded.includes(encodeURIComponent(questId)));
});

test('desktopQuest: isServerActionAcknowledged 正确识别官方确认报文', () => {
  assert.equal(isServerActionAcknowledged('0:true'), true);
  assert.equal(isServerActionAcknowledged('1:true\n'), true);
  assert.equal(isServerActionAcknowledged('0:false'), false);
  assert.equal(isServerActionAcknowledged(''), false);
  assert.equal(isServerActionAcknowledged('error'), false);
});

test('desktopQuest: weekdayFromOfferId 提取解锁星期', () => {
  assert.equal(weekdayFromOfferId('WW_pcchild1_Monday_01'), 'monday');
  assert.equal(weekdayFromOfferId('WW_pcchild2_Tuesday_02'), 'tuesday');
  assert.equal(weekdayFromOfferId('WW_pcchild3_Wednesday_03'), 'wednesday');
});

test('desktopQuest: getDeploymentId 提取构建版本', () => {
  assert.equal(getDeploymentId('script src="/_next/static/app.js?dpl=dpl_12345"'), 'dpl_12345');
  assert.equal(getDeploymentId('{"buildId":"build_abc123"}'), 'build_abc123');
});
