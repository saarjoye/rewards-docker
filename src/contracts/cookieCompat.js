/**
 * Chromium/Playwright Cookie 注入兼容层。
 *
 * 问题背景（参考项目 fix：兼容 __Host- / __Secure- 前缀 Cookie 注入）：
 *  - `__Host-` 前缀的 Cookie 必须满足：Secure、Path=/、且 **不允许带 Domain**（host-only）。
 *    直接把带 domain 的对象丢给 context.addCookies 会被 Chromium 拒绝（CDP 报错/静默丢弃）。
 *  - `__Secure-` 前缀必须 Secure，否则同样被丢弃。
 * 于是会出现"部分账号登录态注入失败 → 官网读到未登录/别的账号"这类诡异问题。
 */

export function normalizeCookieForInjection(cookie = {}) {
  if (!cookie || !cookie.name) return null;
  const name = String(cookie.name);
  const value = String(cookie.value ?? '');
  const isHostPrefixed = name.startsWith('__Host-');
  const isSecurePrefixed = name.startsWith('__Secure-');
  const domain = String(cookie.domain || '').trim();
  const path = String(cookie.path || '/') || '/';

  let sameSite;
  const rawSame = String(cookie.sameSite || '').toLowerCase();
  if (rawSame === 'strict') sameSite = 'Strict';
  else if (rawSame === 'lax') sameSite = 'Lax';
  else if (rawSame === 'none') sameSite = 'None';

  if (isHostPrefixed) {
    const host = domain.replace(/^\./, '');
    if (!host) return null; // 没有域名无法构造 host-only Cookie
    const out = { name, value, url: `https://${host}/`, path: '/', secure: true };
    if (sameSite) out.sameSite = sameSite;
    return out;
  }

  const out = { name, value, path };
  if (domain) out.domain = domain;
  out.secure = isSecurePrefixed ? true : cookie.secure === true;
  if (sameSite) out.sameSite = sameSite;
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires) && expires > 0) out.expires = expires;
  if (cookie.httpOnly === true) out.httpOnly = true;
  return out;
}

export function normalizeCookiesForInjection(cookies = []) {
  const out = [];
  const seen = new Set();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const normalized = normalizeCookieForInjection(cookie);
    if (!normalized) continue;
    const key = `${normalized.name}|${normalized.url || normalized.domain || ''}|${normalized.path || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}
