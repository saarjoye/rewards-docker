import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWeworkMsgType,
  isLegacyTextcardConfig,
  truncateBytes,
  escapeHtml,
  splitReportLines,
  buildTextCardDescription,
  buildNewsDescription,
  buildTextContent
} from '../src/contracts/notifyMessage.js';

test('默认走 textcard（用户要的卡片样式）；显式选择才切换', () => {
  assert.equal(resolveWeworkMsgType({}), 'textcard');
  assert.equal(resolveWeworkMsgType(null), 'textcard');
  assert.equal(resolveWeworkMsgType({ msgType: 'text' }), 'textcard', '历史 text 配置回到 textcard');
  assert.equal(resolveWeworkMsgType({ msgType: 'news' }), 'textcard', '历史 news 配置回到 textcard');
  assert.equal(resolveWeworkMsgType({ msgTypeChosen: 'text' }), 'text');
  assert.equal(resolveWeworkMsgType({ msgTypeChosen: 'news' }), 'news');
  assert.equal(resolveWeworkMsgType({ msgTypeChosen: 'textcard' }), 'textcard');
  assert.equal(isLegacyTextcardConfig({ msgType: 'textcard' }), true);
  assert.equal(isLegacyTextcardConfig({ msgType: 'textcard', msgTypeChosen: 'textcard' }), false);
});

test('textcard 描述只使用 gray/normal，绝不含 highlight（否则客户端漏标签）', () => {
  const desc = buildTextCardDescription({
    dateLabel: '2026/11/13',
    body: '托管账号: 186\n本次收割: +100 分\n今日已增: 135 分'
  });
  assert.ok(desc.startsWith('<div class="gray">统计日期: 2026/11/13</div>'));
  assert.ok(desc.includes('<div class="normal">托管账号: 186</div>'));
  assert.ok(desc.endsWith('🤖 Microsoft Rewards 自动化平台</div>'));
  assert.ok(!desc.includes('highlight'), '不能出现 highlight class');
  const stripped = desc.replace(/<div class="(?:gray|normal)">/g, '').replace(/<\/div>/g, '');
  assert.ok(!/[<>]/.test(stripped), '除卡片自身标签外不能出现裸 < >');
});

test('正文里的裸 HTML 会被转义/剥离，不会破坏卡片结构', () => {
  const desc = buildTextCardDescription({ dateLabel: '2026/11/13', body: '<div class="highlight">坏标签</div>\n正常行' });
  assert.ok(!desc.includes('<div class="highlight">坏标签'), '裸标签必须先剥掉');
  assert.ok(desc.includes('正常行'));
  assert.equal(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
  assert.deepEqual(splitReportLines('**加粗**\n`code`\n\n标题'), ['加粗', 'code', '标题']);
});

test('字节安全截断：不切断多字节字符且带省略号', () => {
  const long = '今日已增: 135 分\n'.repeat(60);
  const cut = truncateBytes(long, 120);
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 120 + Buffer.byteLength('…', 'utf8'));
  assert.ok(cut.endsWith('…'));
  assert.equal(truncateBytes('短文本', 100), '短文本');
});

test('news 与 text 版式一致：统计日期 + 正文 + 平台署名，无 HTML', () => {
  const news = buildNewsDescription({ dateLabel: '2026/11/13', body: '托管账号: 186\n本次收割: +100 分' });
  assert.ok(news.startsWith('统计日期: 2026/11/13'));
  assert.ok(news.endsWith('🤖 Microsoft Rewards 自动化平台'));
  assert.ok(!/<div|<span/.test(news));

  const text = buildTextContent({ title: 'Rewards 每日对账战报 - 186', dateLabel: '2026/11/13', body: '本次收割: +100 分' });
  assert.ok(text.startsWith('🎁 Rewards 每日对账战报 - 186'));
  assert.ok(text.includes('统计日期: 2026/11/13'));
  assert.ok(text.includes('🤖 Microsoft Rewards 自动化平台'));
});
