/**
 * App 签到（Sapphire Daily Check-In）状态判定。
 *
 * 关键背景（对齐参考项目 v1.10.10）：
 *  - 新版 App 的签到状态只体现在 **DAPI promotions** 里：
 *      GET /dapi/me?channel=SAAndroid&options=613
 *      → response.promotions[] 里 type==='checkin'、offerId===Gamification_Sapphire_DailyCheckIn 的那一项
 *  - 官方【网页】/earn 的 `"partner":"bingapp"` 连签模型**不会**因为我们用 DAPI 签到而更新
 *    （实测：DAPI last_updated 已是今天，但网页仍显示 0/1、连签 3/4）。
 *  - 判定规则：promotion.complete === true，或 `last_updated` 的日期就是今天。
 */

const LOCAL_DAY = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function parseTimestamp(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export const DAPI_CHECKIN_OFFER_ID = 'Gamification_Sapphire_DailyCheckIn';

export function isCheckInPromotion(promotion = {}) {
  const attributes = promotion?.attributes || {};
  const type = String(promotion?.type || attributes.type || '').toLowerCase();
  const offerId = String(
    promotion?.offerId || promotion?.offerid || promotion?.id || attributes.offerid || ''
  ).toLowerCase();
  return type === 'checkin' || offerId === DAPI_CHECKIN_OFFER_ID.toLowerCase();
}

export function getDapiCheckInStatus(promotions = [], now = Date.now()) {
  if (!Array.isArray(promotions)) return null;
  const promotion = promotions.find(isCheckInPromotion);
  if (!promotion) return null;
  const attributes = promotion.attributes || {};
  const lastUpdated = parseTimestamp(promotion.last_updated || promotion.lastUpdated || attributes.last_updated);
  const completedToday = promotion.complete === true
    || attributes.complete === true
    || (Number.isFinite(lastUpdated) && LOCAL_DAY(lastUpdated) === LOCAL_DAY(now));
  const days = Number(promotion.progress ?? promotion.pointProgress ?? 0) || 0;
  return {
    isCurrentDayCompleted: completedToday,
    completedDays: days,
    currentDay: days,
    activitiesCompleted: completedToday ? 1 : 0,
    activitiesTotal: 1,
    lastUpdated: Number.isFinite(lastUpdated) ? new Date(lastUpdated).toISOString() : null,
    source: 'dapi'
  };
}
