import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWeworkMsgType,
  isLegacyTextcardConfig,
  truncateBytes,
  buildNewsDescription
} from '../src/contracts/notifyMessage.js';

test('默认与历史配置都走 news 卡片（不再漏 HTML）', () => {
  assert.equal(resolveWeworkMsgType({}), 'news');
  assert.equal(resolveWeworkMsgType(null), 'news');
  assert.equal(resolveWeworkMsgType({ msgType: 'textcard' }), 'news', '历史 textcard 升级成 news');
  assert.equal(resolveWeworkMsgType({ msgType: 'text' }), 'news', '历史 text 升级成 news');
  assert.equal(isLegacyTextcardConfig({ msgType: 'textcard' }), true);
});

test('用户显式选择时尊重选择', () => {
  assert.equal(resolveWeworkMsgType({ msgTypeChosen: 'text' }), 'text');
  assert.equal(resolveWeworkMsgType({ msgTypeChosen: 'textcard' }), 'textcard');
  assert.equal(resolveWeworkMsgType({ msgType: 'textcard', msgTypeChosen: 'news' }), 'news');
  assert.equal(isLegacyTextcardConfig({ msgType: 'textcard', msgTypeChosen: 'textcard' }), false);
});

test('字节安全截断：不切断多字节字符且带省略号', () => {
  const long = '今日已增: 245 分\n'.repeat(50);
  const cut = truncateBytes(long, 100);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 100 + Buffer.byteLength('…', 'utf8'));
  assert.ok(cut.endsWith('…'));
  assert.equal(truncateBytes('短文本', 100), '短文本');
});

test('news 描述：统计日期 + 正文 + 平台署名，无 HTML', () => {
  const desc = buildNewsDescription({
    dateLabel: '2026/11/5',
    body: '托管账号: 186\n本次收割: +33 分\n今日已增: 140 分'
  });
  assert.ok(desc.startsWith('统计日期: 2026/11/5'));
  assert.ok(desc.includes('托管账号: 186'));
  assert.ok(desc.endsWith('🤖 Microsoft Rewards 自动化平台'));
  assert.ok(!/<div|<span/.test(desc));
});
