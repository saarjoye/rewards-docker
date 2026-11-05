import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCookieForInjection, normalizeCookiesForInjection } from '../src/contracts/cookieCompat.js';

test('__Host- 前缀：只能给 url（给 path/domain 会被 Playwright 拒绝）', () => {
  const out = normalizeCookieForInjection({ name: '__Host-MSAAUTHP', value: 'v', domain: 'login.live.com', path: '/', secure: true });
  assert.equal(out.url, 'https://login.live.com/');
  assert.equal(out.domain, undefined);
  assert.equal(out.path, undefined, '不能同时给 path，否则 addCookies 直接报错');
  assert.equal(out.secure, true);

  // 没有 domain 的 __Host- 无法构造，丢弃
  assert.equal(normalizeCookieForInjection({ name: '__Host-X', value: '1' }), null);
});

test('已过期的 expires 必须丢掉（否则 Chromium 静默丢弃整条 Cookie）', () => {
  const nowMs = Date.now();
  const expired = normalizeCookieForInjection(
    { name: '_U', value: 'u', domain: '.bing.com', path: '/', secure: true, expires: Math.floor(nowMs / 1000) - 3600 },
    nowMs
  );
  assert.equal(expired.expires, undefined, '过期时间要丢掉，当作会话 Cookie');
  assert.equal(expired.domain, '.bing.com');
  assert.equal(expired.path, '/');

  const future = normalizeCookieForInjection(
    { name: '_U', value: 'u', domain: '.bing.com', path: '/', secure: true, expires: Math.floor(nowMs / 1000) + 86400 },
    nowMs
  );
  assert.ok(future.expires > 0, '未来的过期时间保留');
});

test('__Secure- 强制 secure；普通 Cookie 保持原样；无 domain 丢弃', () => {
  const secure = normalizeCookieForInjection({ name: '__Secure-AB', value: 'v', domain: '.bing.com' });
  assert.equal(secure.secure, true);

  const normal = normalizeCookieForInjection({ name: '_U', value: 'u', domain: '.bing.com', path: '/', secure: false, sameSite: 'lax' });
  assert.equal(normal.secure, false);
  assert.equal(normal.sameSite, 'Lax');

  assert.equal(normalizeCookieForInjection({ name: 'noDomain', value: 'x' }), null);
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
