/**
 * Chromium/Playwright Cookie 注入兼容层（v2 修复版）。
 *
 * 实测坑（2026-11-05，真实容器逐个验证）：
 *  1) `__Host-` 前缀必须是 host-only —— 只能传 `url`。
 *     **同时传 url 和 path 会被 Playwright 直接拒绝**
 *     （报 "Cookie should have either url or path"），并导致整批注入失败。
 *  2) Cookie 的 `expires` 若已过期，Chromium 会**静默丢弃**该 Cookie。
 *     实测 `_U`、`.MSA.Auth` 就是这样丢的 → 官网变成"未登录空壳"，读不到连签/任务/今日积分。
 *     因此过期时间要丢掉，按"会话 Cookie"注入。
 */

const VALID_SAME_SITE = new Set(['Strict', 'Lax', 'None']);

function normalizeSameSite(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  if (s === 'none') return 'None';
  return undefined;
}

export function normalizeCookieForInjection(cookie = {}, nowMs = Date.now()) {
  if (!cookie || !cookie.name) return null;
  const name = String(cookie.name);
  const value = String(cookie.value ?? '');
  const isHostPrefixed = name.startsWith('__Host-');
  const isSecurePrefixed = name.startsWith('__Secure-');
  const domain = String(cookie.domain || '').trim();
  const path = String(cookie.path || '/') || '/';
  const sameSite = normalizeSameSite(cookie.sameSite);

  if (isHostPrefixed) {
    const host = domain.replace(/^\./, '');
    if (!host) return null;
    // 只给 url：再给 path/domain 会被 Playwright 拒绝
    const out = { name, value, url: `https://${host}/`, secure: true };
    if (sameSite && VALID_SAME_SITE.has(sameSite)) out.sameSite = sameSite;
    return out;
  }

  if (!domain) return null; // 没有 domain 也没有 url 的 Cookie 无法注入

  const out = { name, value, domain, path };
  out.secure = isSecurePrefixed ? true : cookie.secure === true;
  if (sameSite && VALID_SAME_SITE.has(sameSite)) out.sameSite = sameSite;

  // 只保留未来的过期时间；已过期 → 当作会话 Cookie，避免被静默丢弃
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires) && expires > 0 && expires * 1000 > Number(nowMs)) {
    out.expires = expires;
  }
  if (cookie.httpOnly === true) out.httpOnly = true;
  return out;
}

export function normalizeCookiesForInjection(cookies = [], nowMs = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const normalized = normalizeCookieForInjection(cookie, nowMs);
    if (!normalized) continue;
    const key = `${normalized.name}|${normalized.url || normalized.domain || ''}|${normalized.path || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}
