import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCookieForInjection, normalizeCookiesForInjection } from '../src/contracts/cookieCompat.js';
import { redactText, readRecentLogLines, buildDiagnosticsReport } from '../src/contracts/diagnostics.js';

test('__Host- 前缀 Cookie 必须转成 host-only（无 domain、secure、path=/）', () => {
  const out = normalizeCookieForInjection({ name: '__Host-Rewards', value: 'abc', domain: '.bing.com', path: '/x', secure: false });
  assert.equal(out.url, 'https://bing.com/');
  assert.equal(out.domain, undefined, '__Host- 不能带 domain，否则 Chromium 直接丢弃');
  assert.equal(out.path, '/');
  assert.equal(out.secure, true);

  // 没有 domain 的 __Host- Cookie 只能丢弃（无法构造 host-only）
  assert.equal(normalizeCookieForInjection({ name: '__Host-X', value: '1' }), null);
});

test('__Secure- 前缀 Cookie 强制 secure=true，其它 Cookie 保持原样', () => {
  const secure = normalizeCookieForInjection({ name: '__Secure-AB', value: 'v', domain: '.bing.com' });
  assert.equal(secure.secure, true);

  const normal = normalizeCookieForInjection({ name: '_U', value: 'u', domain: '.bing.com', path: '/', secure: false, sameSite: 'lax' });
  assert.equal(normal.secure, false);
  assert.equal(normal.sameSite, 'Lax');
  assert.equal(normal.domain, '.bing.com');
});

test('批量注入去重且丢弃非法项', () => {
  const list = normalizeCookiesForInjection([
    { name: '_U', value: 'a', domain: '.bing.com' },
    { name: '_U', value: 'a', domain: '.bing.com' },
    { value: 'no-name' },
    { name: '__Host-K', value: 'b', domain: 'bing.com' }
  ]);
  assert.equal(list.length, 2);
});

test('诊断日志脱敏：邮箱 / Cookie / Token / 密码 / 代理密码 / 长 hash', () => {
  const raw = [
    '[2026/11/04 20:00:00] 账号 saarjoye@outlook.com 开始执行',
    '[2026/11/04 20:00:01] Cookie: _U=abcdefghijklmnop123456; MUID=xyz1234567890abcdef',
    '[2026/11/04 20:00:02] Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdef',
    '[2026/11/04 20:00:03] pass=MySecretPass proxy=http://user:pa55word@192.168.1.9:1084',
    '[2026/11/04 20:00:04] offerId=Gamification_DailySet_ZHCN_20261104_Child1 hash=a3cbeb504b103d1f2e3d4c5b6a7f8091'
  ].join('\n');
  const out = redactText(raw);
  assert.ok(!out.includes('saarjoye@outlook.com'));
  assert.ok(out.includes('<EMAIL>'));
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert.ok(!out.includes('MySecretPass'));
  assert.ok(!out.includes('pa55word'));
  assert.ok(!out.includes('a3cbeb504b103d1f2e3d4c5b6a7f8091'));
  assert.ok(out.includes('Child1'), 'offerId 结构信息保留，便于排查');
});

test('诊断报告包含账号概览与版本号', () => {
  const report = buildDiagnosticsReport({
    version: '6.8.30',
    accounts: [{ name: 'tester', user: 'tester@outlook.com', todayEarned: 10, balance: 100, status: 'ready', lastSyncAt: Date.now() }],
    notify: { weworkApp: { enabled: true, msgType: 'text' }, dingdingRobot: 'x' },
    now: Date.now(),
    hours: 1
  });
  assert.ok(report.includes('程序版本: 6.8.30'));
  assert.ok(report.includes('今日=10'));
  assert.ok(report.includes('钉钉群机器人: 已配置'));
  assert.ok(!report.includes('tester@outlook.com'), '账号邮箱必须脱敏');
});
