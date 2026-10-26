export const SPECIAL_ACTIVITIES = Object.freeze({
  browserExtension: Object.freeze({
    key: 'browserExtension',
    offerId: 'WW_Rewards_AdHoc_RewardsExtensionBrowser_20191028',
    destinationPattern: /\/set\/browserextension\/rewards/i,
    name: '浏览器中的奖励',
    awardPoints: 30,
    unit: '项',
    icon: '🧩'
  })
});

function decodeText(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * 读取 Next.js Flight 数据里的 activityCards。
 * 这里保留零积分卡片，因为扩展安装、搜索栏等特殊活动在官网数据中
 * 经常是 points: 0，但完成后仍有固定奖励。
 */
export function extractActivityCardsFromHtml(html = '') {
  const text = String(html || '')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, '&');
  const re = /\{[^{}]*?"offerId"\s*:\s*"([^"]+)"[^{}]*?\}/g;
  const byOfferId = new Map();
  let match;

  while ((match = re.exec(text)) !== null) {
    const raw = match[0]
      .replace(/:\$undefined/g, ':null')
      .replace(/:\$D[^\",}]+/g, ':null');
    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!item?.offerId) continue;

    const card = {
      offerId: String(item.offerId),
      title: decodeText(item.title || item.name || ''),
      description: decodeText(item.description || ''),
      destination: String(item.destination || item.destinationUrl || ''),
      hash: String(item.hash || ''),
      points: Number(item.points || 0),
      isCompleted: item.isCompleted === true,
      isLocked: item.isLocked === true,
      isPromotional: item.isPromotional === true
    };
    const previous = byOfferId.get(card.offerId);
    if (!previous
      || (!previous.isCompleted && card.isCompleted)
      || (!previous.hash && card.hash)) {
      byOfferId.set(card.offerId, card);
    }
  }

  return Array.from(byOfferId.values());
}

export function classifySpecialActivity(card = {}) {
  const offerId = String(card.offerId || '');
  const destination = String(card.destination || '');
  for (const definition of Object.values(SPECIAL_ACTIVITIES)) {
    if (offerId === definition.offerId) return definition;
    if (definition.destinationPattern?.test(destination)) return definition;
  }
  return null;
}

export function extractSpecialActivitiesFromHtml(html = '') {
  return extractActivityCardsFromHtml(html)
    .map(card => {
      const definition = classifySpecialActivity(card);
      return definition ? { ...card, ...definition, offerId: card.offerId } : null;
    })
    .filter(Boolean);
}

export function findSpecialActivity(cards = [], key = '') {
  if (!Array.isArray(cards) || !key) return null;
  return cards.find(card => card?.key === key) || null;
}

export function buildSpecialActivityTask(activity, previous = {}, now = Date.now()) {
  if (!activity) return null;
  const done = activity.isCompleted === true || previous?.done === true;
  const awardPoints = Math.max(0, Number(activity.awardPoints || 0));
  const lastResult = String(previous?.lastResult || '');
  const attemptedButUnconfirmed = lastResult === 'no-change' || lastResult === 'attempting';
  return {
    ...(previous && typeof previous === 'object' ? previous : {}),
    name: activity.name || '浏览器中的奖励',
    progress: done ? 1 : 0,
    max: 1,
    points: done ? awardPoints : 0,
    awardPoints,
    unit: activity.unit || '项',
    icon: activity.icon || '🧩',
    done,
    available: true,
    offerId: activity.offerId,
    taskHash: activity.hash || previous?.taskHash || '',
    statusMessage: done
      ? '官网已完成，30 分可能延迟入账'
      : (attemptedButUnconfirmed
          ? '已尝试，等待官网确认'
          : (lastResult === 'not-found'
              ? '官网未找到可点击入口'
              : (lastResult === 'locked' ? '任务当前未解锁' : '检测到任务，待执行'))),
    lastAttemptAt: Number(previous?.lastAttemptAt || 0),
    lastResult,
    lastVerifiedAt: done ? Number(previous?.lastVerifiedAt || now) : Number(previous?.lastVerifiedAt || 0),
    cooldownUntil: Number(previous?.cooldownUntil || 0)
  };
}

export function isSpecialActivityAttemptedToday(previous = {}, now = Date.now()) {
  const lastAttemptAt = Number(previous?.lastAttemptAt || 0);
  if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) return false;
  return new Date(lastAttemptAt).toDateString() === new Date(now).toDateString();
}
