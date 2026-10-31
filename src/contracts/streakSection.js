/**
 * 从官网 /earn「连续打卡任务」区块的可见文本里解析各渠道真实连签进度。
 *
 * 现行官网该区块的 innerText 形如：
 *   连续打卡任务
 *   每日连胜重置 13小时后
 *   必应搜索连续打卡
 *   已完成连续打卡 2 天，共 7 天。
 *   完成下一天即可赚取 3 积分。
 *   搜索: 1/1
 *   每日连续打卡活动
 *   已完成连续打卡 4 天，共 7 天。
 *   活动: 2/3
 *   必应应用连续打卡
 *   已完成连续打卡 6 天，共 7 天。
 *   签到: 1/1
 *
 * 注意：官网现行 RSC 载荷已经不再输出 `"partner":"bing"` 这类字段，DOM 也不再渲染
 * 进度条的 aria-valuenow，所以「读区块文本」是最稳的一条链路。
 */

const STREAK_CARD_MATCHERS = [
  { key: 'bing', re: /必应搜索连续打卡/ },
  { key: 'dailyset', re: /每日连续打卡活动/ },
  { key: 'edge', re: /Edge\s*浏览连续打卡/i },
  { key: 'bingapp', re: /必应应用连续打卡/ }
];

const DEFAULT_ACTIVITY_TOTAL = { bing: 1, dailyset: 3, bingapp: 1 };

/**
 * @param {string} sectionText 「连续打卡任务」区块的 innerText
 * @returns {Record<string, {completedDays:number,currentDay:number,activitiesCompleted:number,activitiesTotal:number,isCurrentDayCompleted:boolean,source:string}>}
 */
export function parseStreakSectionText(sectionText = '') {
  const text = String(sectionText || '');
  const result = {};
  if (!text.trim()) return result;

  for (const { key, re } of STREAK_CARD_MATCHERS) {
    const hit = text.match(re);
    if (!hit) continue;
    // Edge 浏览 30 分钟不属于 7 天连签周期，由 edgeBrowse 计数器单独呈现
    if (key === 'edge') continue;

    const win = text.slice(hit.index, hit.index + 320);
    const days = win.match(/已完成连续打卡\s*(\d+)\s*天\s*[，,]\s*共\s*(\d+)\s*天/);
    const activity = win.match(/(搜索|活动|签到|分钟)\s*[:：]\s*(\d+)\s*\/\s*(\d+)/);
    if (!days && !activity) continue;

    const totalDays = days ? Number(days[2]) : 7;
    const completedDays = days ? Number(days[1]) : 0;
    const activitiesCompleted = activity ? Number(activity[2]) : 0;
    const activitiesTotal = activity ? Number(activity[3]) : (DEFAULT_ACTIVITY_TOTAL[key] || 1);
    const isCurrentDayCompleted = activity
      ? activitiesCompleted >= activitiesTotal
      : completedDays >= totalDays;

    result[key] = {
      completedDays,
      // 官网不直接给 currentDay：今天已完成则停在当日，未完成则指向"下一天"
      currentDay: isCurrentDayCompleted ? completedDays : Math.min(totalDays, completedDays + 1),
      activitiesCompleted,
      activitiesTotal,
      isCurrentDayCompleted,
      source: 'dom-streak-section'
    };
  }

  return result;
}
