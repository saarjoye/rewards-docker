/**
 * 官方任务模型提取器与四大板块契约定义
 * 依据 REWARDS_NEW_ARCHITECTURE_DESIGN.md 第 3 节规范
 */

export const TASK_SECTIONS = {
  STREAKS: 'streaks',          // 1. 连续打卡任务
  LEVEL_UP: 'levelUp',        // 2. 升级活动
  PUNCH_CARDS: 'punchCards',  // 3. 任务 (打孔卡/Quests)
  DAILY: 'dailyActivities'    // 4. 日常任务
};

/**
 * 判断卡片是否为绝对不可执行任务（根据文档 3.5 节黑名单规则）
 */
export function classifyTaskFeasibility(taskName = '', attributes = {}) {
  const name = String(taskName).toLowerCase();

  // 1. 操作系统级遥测
  if (name.includes('edge 浏览连续打卡') || name.includes('浏览 30 分钟') || name.includes('默认浏览器')) {
    return {
      executable: false,
      tag: '【客户端硬件遥测限制 (跳过)】',
      reason: '依赖 Windows 宿主机 Edge 操作系统级守护进程上报，无头浏览器无法伪造'
    };
  }

  // 2. 默认引擎配置项
  if (name.includes('默认搜索引擎') || name.includes('设置为必应')) {
    return {
      executable: false,
      tag: '【客户端环境配置项 (跳过)】',
      reason: '依赖客户端检测物理机默认搜索引擎设置，属于静态配置而非交互动作'
    };
  }

  // 3. 付费消费/会员类
  if (name.includes('xbox') || name.includes('game pass') || name.includes('购买') || name.includes('订阅') || name.includes('充值')) {
    return {
      executable: false,
      tag: '【外部付费消费项 (跳过)】',
      reason: '涉及真实货币交易与外部付费订阅，属于商业营销引导卡'
    };
  }

  // 4. 未来未解锁步骤
  if (name.includes('第') && name.includes('天解锁') || name.includes('明天再来')) {
    return {
      executable: false,
      tag: '【明日解锁 (当前已满)】',
      reason: '微软服务器端强时间锁，当天强制请求会触发风控'
    };
  }

  // 5. 移动应用安装引导
  if (name.includes('下载并安装') || name.includes('安装 edge 移动版')) {
    return {
      executable: false,
      tag: '【外部应用引导 (免做)】',
      reason: '依赖应用商店回调或移动端包名检测'
    };
  }

  return {
    executable: true,
    tag: '【可执行】',
    reason: ''
  };
}

/**
 * 结构化构建四大版块的完整任务树
 */
export function buildUnifiedTaskBoard(flightData = {}, rawCards = []) {
  const board = {
    [TASK_SECTIONS.STREAKS]: [
      {
        id: 'streak_stamps',
        title: '1,000 奖励 (12印章)',
        subtitle: '收集 12 个打卡印章，赢取 1,000 积分奖励',
        progress: flightData.stampsProgress || 0,
        max: 12,
        points: 1000,
        executable: true,
        tag: '【被动累积】',
        note: '每完成一轮打卡周期官网自动点亮 1 个印章',
        done: (flightData.stampsProgress || 0) >= 12
      },
      {
        id: 'streak_bing_search',
        title: '必应搜索连续打卡 (搜索: 1/1)',
        subtitle: '每天在必应进行至少 1 次有效搜索',
        progress: flightData.bingSearchCompleted ? 1 : 0,
        max: 1,
        points: 5,
        executable: true,
        tag: '【PC搜索】',
        note: '由拟人化 PC 搜索自动点亮',
        done: !!flightData.bingSearchCompleted
      },
      {
        id: 'streak_dailyset',
        title: '每日连续打卡活动 (活动: 3/3)',
        subtitle: '每天完成当日 Daily Set 推荐的 3 项活动',
        progress: flightData.dailySetCompleted || 0,
        max: 3,
        points: 30,
        executable: true,
        tag: '【DailySet】',
        note: '由真机点击穿透或协议直连触发',
        done: (flightData.dailySetCompleted || 0) >= 3
      },
      {
        id: 'streak_edge_browse',
        title: 'Edge 浏览连续打卡 (分钟: 30/30)',
        subtitle: '在 Windows 上的 Edge 浏览器登录并浏览 30 分钟',
        progress: 0,
        max: 30,
        points: 10,
        executable: false,
        tag: '【客户端硬件遥测限制 (跳过)】',
        note: '需物理机系统后台活跃，无头环境跳过',
        done: false
      },
      {
        id: 'streak_bing_app',
        title: '必应应用连续打卡 (签到: 1/1)',
        subtitle: '在手机必应移动端 App 内签到',
        progress: flightData.bingAppCompleted ? 1 : 0,
        max: 1,
        points: 10,
        executable: true,
        tag: '【App签到】',
        note: '由 DAPI 网关直连协议完成',
        done: !!flightData.bingAppCompleted
      }
    ],

    [TASK_SECTIONS.LEVEL_UP]: [
      {
        id: 'level_dailyset_7d',
        title: '连续 7 天完成每日活动',
        progress: flightData.levelDailySetDays || 0,
        max: 7,
        points: 0,
        executable: true,
        tag: '【周期驱动】',
        note: '随每日连续打卡活动达成而自增',
        done: (flightData.levelDailySetDays || 0) >= 7
      },
      {
        id: 'level_bing_7d',
        title: '使用必应连续搜索 7 天',
        progress: flightData.levelBingDays || 0,
        max: 7,
        points: 0,
        executable: true,
        tag: '【周期驱动】',
        note: '随必应搜索完成而自增',
        done: (flightData.levelBingDays || 0) >= 7
      },
      {
        id: 'level_bingapp_7d',
        title: '连续签到必应应用 7 天',
        progress: flightData.levelBingAppDays || 0,
        max: 7,
        points: 0,
        executable: true,
        tag: '【周期驱动】',
        note: '随 App 签到完成而自增',
        done: (flightData.levelBingAppDays || 0) >= 7
      },
      {
        id: 'level_default_engine',
        title: '将必应设置为默认搜索引擎 14 天',
        progress: 0,
        max: 14,
        points: 0,
        executable: false,
        tag: '【客户端环境配置项 (跳过)】',
        note: '无头环境不修改宿主机环境配置',
        done: false
      },
      {
        id: 'level_xbox_gpu',
        title: '获取 XBOX Game Pass Ultimate',
        progress: 0,
        max: 1,
        points: 0,
        executable: false,
        tag: '【外部付费消费项 (跳过)】',
        note: '外部付费订阅引导，禁止自动化',
        done: false
      }
    ],

    [TASK_SECTIONS.PUNCH_CARDS]: [],
    [TASK_SECTIONS.DAILY]: []
  };

  // 动态解析打孔卡 (Quests / Punch Cards) 与日常活动卡片 (Daily Activities)
  if (Array.isArray(rawCards)) {
    for (const card of rawCards) {
      const feasibility = classifyTaskFeasibility(card.title || card.name || '', card.attributes);
      const item = {
        id: card.offerId || card.id || Math.random().toString(36).slice(2, 8),
        title: card.title || card.name || '未命名活动',
        subtitle: card.description || '',
        points: Number(card.pointProgressMax || card.points || 0),
        progress: Number(card.pointProgress || (card.isCompleted ? card.pointProgressMax || card.points : 0)),
        max: Number(card.pointProgressMax || card.points || 1),
        executable: feasibility.executable,
        tag: feasibility.tag,
        note: feasibility.reason,
        destination: card.destination || '',
        done: !!card.isCompleted
      };

      if (card.isPunchCard || card.isQuest || (card.destination && card.destination.includes('/quest/'))) {
        board[TASK_SECTIONS.PUNCH_CARDS].push(item);
      } else {
        board[TASK_SECTIONS.DAILY].push(item);
      }
    }
  }

  return board;
}
