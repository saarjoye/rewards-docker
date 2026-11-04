/**
 * 新版 App Daily Set 的「日期兜底」offerId 生成。
 *
 * 背景（参考项目 v1.10.10 实测）：官网改版后，`/earn` 页面和 dashboard API 都可能
 * 不再下发今日的 3 张 Daily Set 卡片，网页端点击抽屉会卡在 2/3 甚至 0/3。
 * 但 App 侧 DAPI 仍接受固定格式的 Child offerId：
 *
 *   Gamification_DailySet_<LOCALE>_<YYYYMMDD>_Child1 / Child2 / Child3
 *
 * 每张 10 分（合计 30 分），用 type=101 的普通领取活动提交即可。
 */

export function compactDateKey(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function buildDapiDailySetOfferIds(now = Date.now(), locale = 'ZHCN') {
  const date = compactDateKey(now);
  return [1, 2, 3].map((index) => `Gamification_DailySet_${locale}_${date}_Child${index}`);
}

export function buildDapiDailySetCards(now = Date.now(), locale = 'ZHCN') {
  return buildDapiDailySetOfferIds(now, locale).map((offerId, index) => ({
    title: `移动端每日活动 ${index + 1}`,
    points: 10,
    offerId,
    kind: 'dapi_reward',
    category: 'dailyset',
    source: 'dapi-dailyset-fallback'
  }));
}

/**
 * 领取成功判定：必须 code=0 且 **真的加了分**（或回执里明确写了已完成）。
 * 注意：DAPI 对「今天已经领过」的 offerId 也会返回 code=0 并附带 balance，
 * 若把 balance 当成成功依据，就会每天虚报 3/3（实测坑）。
 */
export function isDapiClaimConfirmed(res = {}) {
  if (!res || typeof res !== 'object') return false;
  const code = res.code;
  const okCode = code === 0 || code === '0' || res.success === true;
  const points = Number(
    res.response?.activity?.p
    ?? res.response?.creditedPoints
    ?? res.response?.activity?.points
    ?? 0
  );
  const activity = res.response?.activity || {};
  const explicitDone = activity.complete === true
    || activity.isCompleted === true
    || activity.completed === true
    || res.response?.isCompleted === true;
  return okCode && (points > 0 || explicitDone);
}

/** 回执里本次实际入账的积分（拿不到就是 0） */
export function dapiClaimedPoints(res = {}) {
  return Number(
    res?.response?.activity?.p
    ?? res?.response?.creditedPoints
    ?? res?.response?.activity?.points
    ?? 0
  ) || 0;
}
