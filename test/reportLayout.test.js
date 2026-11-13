import test from 'node:test';
import assert from 'node:assert/strict';

const { PLATFORM_SIGNATURE, buildTextCardDescription } = await import('../src/contracts/notifyMessage.js');
const notifierModule = await import('../src/core/notifier.js').catch(() => null);

test('平台署名常量：标题用「🤖 自动化平台」', () => {
  assert.equal(PLATFORM_SIGNATURE, '🤖 自动化平台');
});

test('署名放进标题后，正文不再重复署名', () => {
  const desc = buildTextCardDescription({
    dateLabel: '2026/11/13',
    body: '托管账号: 186\n执行状态: 官网任务仍有未完成项',
    footer: ''
  });
  assert.ok(!desc.includes('自动化平台'), '正文不应再出现平台署名');
  assert.ok(desc.endsWith('执行状态: 官网任务仍有未完成项</div>'));
  assert.ok(desc.length > 0 && notifierModule);
});
