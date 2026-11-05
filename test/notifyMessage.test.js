import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWeworkMsgType, isLegacyTextcardConfig } from '../src/contracts/notifyMessage.js';

test('历史 textcard 配置自动迁移为 text（避免微信里漏出 HTML 标签）', () => {
  assert.equal(resolveWeworkMsgType({ msgType: 'textcard' }), 'text');
  assert.equal(isLegacyTextcardConfig({ msgType: 'textcard' }), true);
});

test('用户显式选择 textcard 时尊重选择', () => {
  assert.equal(resolveWeworkMsgType({ msgType: 'textcard', msgTypeChosen: 'textcard' }), 'textcard');
  assert.equal(isLegacyTextcardConfig({ msgType: 'textcard', msgTypeChosen: 'textcard' }), false);
  assert.equal(resolveWeworkMsgType({ msgType: 'text', msgTypeChosen: 'textcard' }), 'textcard');
});

test('默认走 text；显式 text 也是 text', () => {
  assert.equal(resolveWeworkMsgType({}), 'text');
  assert.equal(resolveWeworkMsgType({ msgType: 'text' }), 'text');
  assert.equal(resolveWeworkMsgType({ msgType: 'text', msgTypeChosen: 'text' }), 'text');
  assert.equal(resolveWeworkMsgType(null), 'text');
});
