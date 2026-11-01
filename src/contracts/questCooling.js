/**
 * 打孔卡子任务的"冷却/需明日解锁"识别。
 *
 * 官网对多步打孔卡有两类限制：
 * 1) 时间锁：「要获取第二个活动，请在完成第 1 天后等待 24 小时或更长时间」
 * 2) 客户端专属：「奖励应用专属」（必须由桌面 Rewards 应用完成）
 * 这两种情况点多少次都不会推进，只会浪费请求并放大风控风险，因此统一识别为 cooling 并跳过。
 */

const COOLING_PATTERNS = [
  { re: /等待\s*24\s*小时/, label: '需等待 24 小时解锁下一项' },
  { re: /请在完成第\s*\d+\s*天后等待/, label: '需等待 24 小时解锁下一项' },
  { re: /(明天再来|明日解锁|次日解锁)/, label: '明日解锁' },
  { re: /(稍后再试|等待冷却|冷却中)/, label: '冷却中' },
  { re: /奖励应用专属/, label: '仅限桌面奖励应用' },
  { re: /需在[^。]{0,24}(桌面|Rewards)\s*应用/, label: '仅限桌面奖励应用' }
];

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
