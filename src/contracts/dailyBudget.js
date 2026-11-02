/**
 * 每日配额计数器（多账号共享同一出口 IP 时用）。
 *
 * 背景：微软对「优惠购物」这类打孔卡子任务有每日次数限制。实测 2026-11-02：
 * 同 IP 下 4 个账号，只有 2 个账号（+ 用户手动 1 次）被记分，其余无论怎么点都不再记分。
 * 为避免账号之间互相消耗配额，这里做"每日每 IP 最多 N 次购物尝试"的预算控制。
 */

export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function consumeDailyBudget(state = {}, key = 'default', limit = 2, today = dayKey()) {
  const base = state && state.date === today && state.values && typeof state.values === 'object'
    ? state
    : { date: today, values: {} };
  const used = Number(base.values[key] || 0);
  const allowed = used < Math.max(0, Number(limit) || 0);
  const values = allowed ? { ...base.values, [key]: used + 1 } : { ...base.values };
  // used 表示"本次占用后的计数"：允许时为 used+1，被拒时保持原计数
  return { allowed, used: allowed ? used + 1 : used, limit: Number(limit) || 0, state: { date: today, values } };
}

export function peekDailyBudget(state = {}, key = 'default', limit = 2, today = dayKey()) {
  const base = state && state.date === today && state.values && typeof state.values === 'object'
    ? state
    : { date: today, values: {} };
  const used = Number(base.values[key] || 0);
  return { allowed: used < Math.max(0, Number(limit) || 0), used, limit: Number(limit) || 0 };
}
