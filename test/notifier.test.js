import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWeWorkAppBaseUrl,
  buildWeWorkAppTokenUrl,
  buildWeWorkAppSendUrl
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
