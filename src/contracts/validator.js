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
    // 文本行模式：今日积分 \n 70
    /今日积分\s*[:\n\r]+\s*([0-9,]+)/i,
    /今日积分[^0-9]{1,40}?([0-9,]+)/i,
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
    /每日连续打卡[^0-9]{1,40}?([0-9,]+)/i,
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
    /可用积分[^0-9]{1,40}?([0-9,]+)/i,
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
  const patterns = [
    /可领取\s*[:\n\r]+\s*([0-9,]+)/i,
    /可领取\s*([0-9,]+)\s*领取/i,
    /class=["'][^"']*?text-labelControl[^"']*?["']>可领取<[\s\S]*?>([0-9,]+)</i,
    /"claimablePoints"\s*:\s*([0-9]+)/i
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
 * 严格真实校验函数：防止任何非真实数据污染
 */
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
