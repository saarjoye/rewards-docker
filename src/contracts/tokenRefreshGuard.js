/**
 * Token 续期保护（冷却 + 单次日志）。
 *
 * 背景（实测 2026-11-16，putian163）：
 *   到 Microsoft 令牌端点的网络超时（`timeout of 25000ms exceeded`）时，
 *   每调用一次 DAPI 就会重试一次续期，一次签到流程里会连打 4 轮，
 *   日志被 "Token 续期失败" 刷屏，还拖慢整条流水线。
 *
 * 策略：
 *   - 续期失败后进入冷却期（默认 10 分钟），冷却期内不再尝试；
 *   - 冷却期内只提示一次，避免刷屏；
 *   - 续期成功后立即清除冷却状态。
 */

export const DEFAULT_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

/** 区分「网络问题」与「凭据失效」——前者等网络恢复即可，后者必须重新登录 */
export function classifyRefreshError(message = '') {
  const text = String(message || '').toLowerCase();
  if (/timeout|timed out|econn|etimedout|socket|network|eai_again|enotfound|502|503|504/.test(text)) {
    return 'network';
  }
  if (/invalid_grant|invalid_client|unauthorized|400|401/.test(text)) {
    return 'auth';
  }
  return 'unknown';
}

export function shouldAttemptRefresh(state, now = Date.now(), cooldownMs = DEFAULT_REFRESH_COOLDOWN_MS) {
  if (!state || !state.lastFailureAt) return { allowed: true, notify: true };
  const elapsed = Number(now) - Number(state.lastFailureAt);
  if (elapsed >= Number(cooldownMs)) return { allowed: true, notify: true };
  return {
    allowed: false,
    notify: !state.warned,
    remainingMs: Math.max(0, Number(cooldownMs) - elapsed),
    kind: state.kind || 'unknown'
  };
}

export function markRefreshFailure(state, now = Date.now(), error = '') {
  const kind = classifyRefreshError(error);
  const base = state && typeof state === 'object' ? state : {};
  return { ...base, lastFailureAt: Number(now), lastError: String(error || ''), kind, warned: false };
}

export function markRefreshNotified(state) {
  return { ...(state || {}), warned: true };
}

export function markRefreshSuccess() {
  return null;
}

/** 冷却中的提示文案（只出现一次） */
export function describeRefreshCooldown(state = {}, remainingMs = 0) {
  const minutes = Math.max(1, Math.round(Number(remainingMs) / 60000));
  const reason = state.kind === 'network' ? '令牌接口网络超时' : (state.kind === 'auth' ? '刷新凭据已失效' : '续期失败');
  return `Token 续期已暂停（${reason}），约 ${minutes} 分钟内不再重试，本轮跳过需要 App Token 的任务`;
}
