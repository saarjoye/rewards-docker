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

  const patterns = [
    // English patterns
    /Today's points\s*[:\n\r]+\s*([0-9,]+)/i,
    /Daily points\s*[:\n\r]+\s*([0-9,]+)/i,
    // 文本行模式：今日积分 \n 70
    /今日积分\s*[:\n\r]+\s*([0-9,]+)/i,
    /今日积分[^0-9]{1,120}?([0-9,]+)/i,
    // Flight Chunks 模式
    /["']text-pageHeader["'][^}]*?children\s*:\s*["']?([0-9,]+)["']?/i,
    /今日积分[^0-9]{1,100}?class=["'][^"']*?text-pageHeader[^"']*?["'][^>]*?>([0-9,]+)</i,
    /"todayPoints"\s*:\s*([0-9]+)/i
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
  const combined = `${flightText}\n${html}`;

  // 1. 若页面或抽屉明确包含已领完或归零的终态标记，严格判定为 0
  if (combined.includes('\u5f53\u524d\u6ca1\u6709\u8981\u9886\u53d6\u7684\u79ef\u5206')) {
    return 0;
  }

  const currentCardMatch = combined.match(/text-labelControl[^>]*>\u53ef\u9886\u53d6<[\s\S]{0,500}?text-pageHeader[^>]*>([0-9,]+)</i);
  if (currentCardMatch && currentCardMatch[1]) {
    return parseNumberWithCommas(currentCardMatch[1]);
  }

  // The current DOM card takes precedence over cached Flight data.
  const liveClaimable = combined.match(/\u53ef\u9886\u53d6\s*([0-9,]+)\s*\u9886\u53d6/);
  if (liveClaimable && liveClaimable[1]) {
    return parseNumberWithCommas(liveClaimable[1]);
  }

  // 2. 优先提取官方明细账本中的真实 TotalClaimablePoints
  const bdMatch = combined.match(/"TotalClaimablePoints"\s*:\s*([0-9]+)/i)
    || combined.match(/"totalClaimablePoints"\s*:\s*([0-9]+)/i);
  if (bdMatch && bdMatch[1]) {
    const val = parseInt(bdMatch[1], 10);
    if (!isNaN(val)) return val;
  }

  // 3. 从 DOM 结构中提取待领分 (对标图 6 与单元测试样本)
  const patterns = [
    /可领取[\s\S]{0,100}?>([0-9,]+)<[\s\S]{0,100}?>\s*领取/i,
    /class=["'][^"']*?text-labelControl[^"']*?["']>可领取<[\s\S]*?>([0-9,]+)</i,
    /可领取\s*[:\n\r]+\s*([0-9,]+)/i,
    /"claimablePoints"\s*:\s*([0-9]+)/i
  ];

  for (const regex of patterns) {
    const match = combined.match(regex);
    if (match && match[1]) {
      return parseNumberWithCommas(match[1]);
    }
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
