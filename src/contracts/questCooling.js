/**
 * 打孔卡子任务的状态识别（冷却 / 锁定 / 时间锁）。
 *
 * 官网对多步打孔卡有三类限制，处理方式完全不同：
 * 1) 自身被锁：按钮 disabled / 有锁图标 → 任何情况都不点；
 * 2) 客户端专属：「奖励应用专属」必须由桌面 Rewards 应用完成 → 跳过；
 * 3) 时间锁（每日一步）：「要获取第二个活动，请在完成第 1 天后等待 24 小时…」
 *    —— 这句出现在**每个**子任务的描述里，说的是"下一项还没解锁"，
 *    所以只能按"整张卡每天推进 1 步"处理，绝不能用它把当前项判成冷却
 *    （v6.8.8 就踩了这个坑：5 项全被跳过，卡在 0/5）。
 */

const COOLING_PATTERNS = [
  { re: /(明天再来|明日解锁|次日解锁)/, label: '明日解锁' },
  { re: /(稍后再试|等待冷却|冷却中)/, label: '冷却中' },
  { re: /奖励应用专属/, label: '仅限桌面奖励应用' },
  { re: /需在[^。]{0,24}(桌面|Rewards)\s*应用/, label: '仅限桌面奖励应用' }
];

const DAY_LOCK_HINT = /等待\s*24\s*小时|请在完成第\s*\d+\s*天后等待/;

/** 单个子任务自身是否处于锁定/客户端专属状态（不含时间锁） */
export function isQuestSubtaskCooling(text = '') {
  const value = String(text || '');
  if (!value) return false;
  return COOLING_PATTERNS.some(({ re }) => re.test(value));
}

export function describeQuestCooling(text = '') {
  const value = String(text || '');
  for (const { re, label } of COOLING_PATTERNS) {
    if (re.test(value)) return label;
  }
  return '';
}

/** 页面是否声明了"每日只能推进 1 步"的 24 小时时间锁 */
export function hasDayLockHint(text = '') {
  return DAY_LOCK_HINT.test(String(text || ''));
}

/**
 * 按时间锁规则标记：第一个待做项之后的待做项属于"明日解锁"。
 * @param {Array} items 子任务列表（需含 completed / locked）
 * @param {boolean} pageHasDayLock 页面是否声明了 24 小时时间锁
 */
export function applyDayLock(items = [], pageHasDayLock = false) {
  let pendingSeen = false;
  return (items || []).map((item) => {
    const isPending = !item.completed && !item.locked;
    const dayLocked = Boolean(pageHasDayLock && isPending && pendingSeen);
    if (isPending) pendingSeen = true;
    return { ...item, dayLocked };
  });
}
