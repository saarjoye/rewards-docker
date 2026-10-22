/**
 * 绝不造假校验器 (Data Integrity & Ground Truth Validator)
 * 严格对标 REWARDS_NEW_ARCHITECTURE_DESIGN.md 第 4 节：
 * 今日已增积分 (earned) 必须且只能由官方页面的 todayPoints 赋值，绝对严禁使用本地卡片积分相加。
 */

export function parseNumberWithCommas(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[^\d]/g, '');
  const val = parseInt(cleaned, 10);
  return isNaN(val) ? 0 : val;
}

/**
 * 从 /earn 页面 Flight 数据或 HTML/Text 提取官方今日积分 (图 5 对标)
 */
export function extractOfficialTodayPoints(flightText = '', html = '') {
  const combined = `${flightText}\n${html}`;

  // 1. 优先提取以「今日积分」为前置锚点的真实大卡片数值 (对齐 wangheqiang530 官方实现，彻底杜绝被页面其他卡片的 145 误伤)
  const todayPointValues = [];
  const todayPointPatterns = [
    /"children":"(?:今日积分|Points earned today|Today(?:'|&#39;)s points)"[\s\S]{0,1600}?"className":"text-pageHeader","children":"([\d,]+)"/gi,
    /(?:今日积分|Points earned today|Today(?:'|&#39;)s points)<\/p>[\s\S]{0,1200}?class="text-pageHeader">([\d,]+)</gi,
    /(?:今日积分|Points earned today|Today(?:'|&#39;)s points)[\s\S]{0,1200}?text-pageHeader[^>]*>([\d,]+)</gi
  ];
  for (const pattern of todayPointPatterns) {
    for (const match of combined.matchAll(pattern)) {
      const n = parseNumberWithCommas(match[1]);
      if (Number.isFinite(n) && n >= 0) todayPointValues.push(n);
    }
  }
  if (todayPointValues.length > 0) {
    return Math.max(...todayPointValues);
  }

  // 2. 备选通用正则 (兼顾历史单测与轻量片段)
  const patterns = [
    /Today's points\s*[:\n\r]+\s*([0-9,]+)/i,
    /Daily points\s*[:\n\r]+\s*([0-9,]+)/i,
    /今日积分\s*[:\n\r]+\s*([0-9,]+)/i,
    /今日积分[^0-9]{1,120}?([0-9,]+)/i,
    /今日积分[^0-9]{1,100}?class=["'][^"']*?text-pageHeader[^"']*?["'][^>]*?>([0-9,]+)</i,
    /"todayPoints"\s*:\s*([0-9]+)/i,
    /["']text-pageHeader["'][^}]*?children\s*:\s*["']?([0-9,]+)["']?/i
  ];

  for (const regex of patterns) {
    const match = combined.match(regex);
    if (match && match[1]) {
      const num = parseNumberWithCommas(match[1]);
      if (num >= 0) return num;
    }
  }

  return null;
}

/**
 * 提取连续打卡天数 (图 5 对标)
 */
export function extractOfficialStreakDays(flightText = '', html = '') {
  const combined = `${flightText}\n${html}`;
  const patterns = [
    /每日连续打卡\s*[:\n\r]+\s*([0-9,]+)/i,
    /每日连续打卡[^0-9]{1,120}?([0-9,]+)/i,
    /每日连续打卡[^0-9]{1,100}?class=["'][^"']*?text-pageHeader[^"']*?["'][^>]*?>([0-9,]+)</i,
    /"streakDays"\s*:\s*([0-9]+)/i,
    /"dailyStreakDays"\s*:\s*([0-9]+)/i
  ];

  for (const regex of patterns) {
    const match = combined.match(regex);
    if (match && match[1]) {
      return parseNumberWithCommas(match[1]);
    }
  }
  return 0;
}

/**
 * 从 /dashboard 页面提取可用积分总余额 (图 6 对标)
 */
export function extractOfficialBalance(flightText = '', html = '') {
  const combined = `${flightText}\n${html}`;
  const patterns = [
    /可用积分\s*[:\n\r]+\s*([0-9,]+)/i,
    /可用积分[^0-9]{1,120}?([0-9,]+)/i,
    /可用积分[^0-9]{1,100}?class=["'][^"']*?text-pageHeader[^"']*?["'][^>]*?>([0-9,]+)</i,
    /"availablePoints"\s*:\s*([0-9]+)/i,
    /"balance"\s*:\s*([0-9]+)/i
  ];

  for (const regex of patterns) {
    const match = combined.match(regex);
    if (match && match[1]) {
      return parseNumberWithCommas(match[1]);
    }
  }
  return null;
}

/**
 * 从 /dashboard 页面提取可领取额外积分 (图 6 对标)
 */
export function extractOfficialClaimablePoints(flightText = '', html = '') {
  const live = String(html || '');
  const flight = String(flightText || '');

  // Current DOM must win over stale Flight data or hidden historical text.
  const currentCardMatch = live.match(/text-labelControl[^>]*>\u53ef\u9886\u53d6<[\s\S]{0,500}?text-pageHeader[^>]*>([0-9,]+)</i);
  if (currentCardMatch && currentCardMatch[1]) return parseNumberWithCommas(currentCardMatch[1]);

  const liveClaimable = live.match(/\u53ef\u9886\u53d6\s*([0-9,]+)\s*\u9886\u53d6/);
  if (liveClaimable && liveClaimable[1]) return parseNumberWithCommas(liveClaimable[1]);

  if (live.includes('\u5f53\u524d\u6ca1\u6709\u8981\u9886\u53d6\u7684\u79ef\u5206') || (!live.includes('\u53ef\u9886\u53d6') && live.length > 500)) return 0;

  const livePatterns = [
    /\u53ef\u9886\u53d6[\s\S]{0,100}?>([0-9,]+)<[\s\S]{0,100}?>\s*\u9886\u53d6/i,
    /class=["'][^"']*?text-labelControl[^"']*?["']>\u53ef\u9886\u53d6<[\s\S]*?>([0-9,]+)</i,
    /\u53ef\u9886\u53d6\s*[:\n\r]+\s*([0-9,]+)/i
  ];
  for (const regex of livePatterns) {
    const match = live.match(regex);
    if (match && match[1]) return parseNumberWithCommas(match[1]);
  }

  const bdMatch = flight.match(/"TotalClaimablePoints"\s*:\s*([0-9]+)/i)
    || flight.match(/"totalClaimablePoints"\s*:\s*([0-9]+)/i)
    || flight.match(/"claimablePoints"\s*:\s*([0-9]+)/i);
  if (bdMatch && bdMatch[1]) {
    const value = parseInt(bdMatch[1], 10);
    if (!Number.isNaN(value)) return value;
  }

  return null;
}


export function validateStrictMetrics({ officialToday, previousToday, claimedAdd = 0 }) {
  if (officialToday === null || officialToday === undefined) {
    return { valid: false, earned: previousToday || 0, reason: '未能读取官网今日真实积分' };
  }
  return {
    valid: true,
    earned: officialToday,
    delta: previousToday !== undefined ? officialToday - previousToday : 0
  };
}


export function extractOfficialSearchPoints(text = '') {
  if (!text) return null;

  // 只匹配积分明细中的“必应搜索 60/60”，不能误匹配连续打卡卡片中的“搜索: 1/1”。
  const patterns = [
    /必应搜索\s*[:：]?\s*([0-9]+)\s*\/\s*([0-9]+)/i,
    /Bing search\s*[:：]?\s*([0-9]+)\s*\/\s*([0-9]+)/i,
    /PC\s*搜索\s*[:：]?\s*([0-9]+)\s*\/\s*([0-9]+)/i,
    /PC\s*Search\s*[:：]?\s*([0-9]+)\s*\/\s*([0-9]+)/i
  ];

  for (const re of patterns) {
    const match = text.match(re);
    if (!match) continue;
    const current = parseInt(match[1], 10);
    const max = parseInt(match[2], 10);
    // 连续打卡的“搜索: 1/1”不是积分明细中的搜索上限，排除这种误识别。
    if (max <= 1) continue;
    return { current, max, isMaxed: max > 0 && current >= max, source: 'points-detail' };
  }
  return null;
}
