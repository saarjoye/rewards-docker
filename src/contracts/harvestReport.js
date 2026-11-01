/**
 * 「本次收割」分数与推送文案的统一计算。
 *
 * 历史缺陷：把"本次运行的任务积分增量"当成"收割分数"，并且把"官网没有待领取积分"
 * 也写成 "额外积分已核验到账 (+0 分)"，导致战报里永远显示「本次收割: 0 分」。
 *
 * 口径：
 *   - claimAmount：本次真正从「可领取」抽屉领到并入账的分数（优先用余额差，其次用卡片读数）；
 *   - runPoints：本次任务执行带来的积分增量（搜索/DailySet 等）；
 *   - harvestedPoints：两者之和，即"本次收割"应展示的数字。
 */
export function resolveHarvestReport({
  claimStatus = 'skipped',
  claimPoints = 0,
  beforeBalance = null,
  finalBalance = null,
  runDelta = 0
} = {}) {
  const hasBefore = Number.isFinite(Number(beforeBalance));
  const hasFinal = Number.isFinite(Number(finalBalance));
  const balanceDelta = (hasBefore && hasFinal)
    ? Math.max(0, Number(finalBalance) - Number(beforeBalance))
    : 0;
  const claimed = Math.max(0, Number(claimPoints) || 0);
  const runPoints = Math.max(0, Number(runDelta) || 0);

  let claimAmount = 0;
  if (claimStatus === 'claimed') {
    claimAmount = balanceDelta > 0 ? balanceDelta : claimed;
  }

  const harvestedPoints = claimAmount + runPoints;

  let statusText;
  if (claimStatus === 'claimed') {
    statusText = runPoints > 0
      ? `额外积分 +${claimAmount} 分已入账 · 本次共 +${harvestedPoints} 分`
      : `额外积分 +${claimAmount} 分已入账（官网待领已清零）`;
  } else if (claimStatus === 'already-empty') {
    statusText = runPoints > 0
      ? `官网当前无待领取额外积分 · 本次任务积分 +${runPoints} 分`
      : '官网当前无待领取额外积分（未发生领取）';
  } else {
    statusText = runPoints > 0
      ? `本次任务积分 +${runPoints} 分 · 额外积分未确认到账`
      : '额外积分未确认到账';
  }

  return { claimAmount, runPoints, harvestedPoints, statusText };
}
