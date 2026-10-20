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
  const title = String(attributes.title || '').toLowerCase();
  const destination = String(attributes.destination || attributes.href || '').toLowerCase();
  const combined = `${name} ${title}`.trim();

  const notExecutable = (tag, reason) => ({ executable: false, tag, reason });
  const executable = (kind, reason = '') => ({ executable: true, kind, tag: '【可执行】', reason });

  // 1. Operating-system telemetry and browser configuration cannot be
  // reproduced by a headless page.
  if (combined.includes('edge 浏览连续打卡') || combined.includes('浏览 30 分钟') || combined.includes('默认浏览器')) {
    return notExecutable('【客户端硬件遥测限制 (跳过)】', '依赖 Windows 宿主机 Edge 操作系统级守护进程上报，无头浏览器无法伪造');
  }
  if (combined.includes('默认搜索引擎') || combined.includes('设置为必应')) {
    return notExecutable('【客户端环境配置项 (跳过)】', '依赖客户端检测物理机默认搜索引擎设置，属于静态配置而非交互动作');
  }

  // 2. Commercial and external client flows are never point activities.
  if (combined.includes('xbox') || combined.includes('game pass') || combined.includes('购买') || combined.includes('订阅') || combined.includes('充值')) {
    return notExecutable('【外部付费消费项 (跳过)】', '涉及真实货币交易与外部付费订阅，属于商业营销引导卡');
  }
  if (combined.includes('免费获取') || (combined.includes('free') && combined.includes('super')) || combined.includes('super duolingo')) {
    return notExecutable('【营销/订阅引导 (跳过)】', '营销或订阅引导不产生可直接领取的积分');
  }
  if (combined.includes('下载') || combined.includes('安装') || combined.includes('壁纸') || combined.includes('扩展') || combined.includes('extension') || combined.includes('客户端')) {
    return notExecutable('【客户端/安装引导 (跳过)】', '依赖客户端或扩展安装，无法通过网页交互完成');
  }
  if (combined.includes('搜索栏') || combined.includes('search bar') || (combined.includes('启用') && combined.includes('搜索') && combined.includes('连续'))) {
    return notExecutable('【客户端搜索栏引导 (跳过)】', '依赖客户端搜索栏启用和连续使用，不能由网页搜索替代');
  }
  if (combined.includes('连续使用') && combined.includes('天')) {
    return notExecutable('【多日客户端任务 (跳过)】', '需要多日客户端使用记录，不属于单次网页活动');
  }
  if ((combined.includes('第') && combined.includes('天解锁')) || combined.includes('明天再来')) {
    return notExecutable('【明日解锁 (当前已满)】', '微软服务器端强时间锁，当天强制请求会触发风控');
  }

  // 3. Punch cards are owned by the quest pipeline. Re-entering them from the
  // daily section would duplicate work and can reset in-progress state.
  if (destination.includes('/quest/') || combined.includes('打孔卡') || /\d+\s*\/\s*\d+\s*个任务/.test(combined)) {
    return notExecutable('【打孔卡/任务链 (跳过)】', '打孔卡由独立任务链执行，不能作为日常活动重复穿透');
  }

  // 4. Require an explicit point badge/value. A positive number in marketing
  // prose is not enough; this keeps non-point promotional cards out.
  const pointBadge = String(attributes.pointText || '').match(/^\s*\+?\s*(\d{1,4})\s*(?:分|points?)?\s*$/i);
  const declaredPoints = Number(attributes.points ?? attributes.pointProgressMax ?? NaN);
  const hasPositivePoints = (pointBadge && Number(pointBadge[1]) > 0) || (Number.isFinite(declaredPoints) && declaredPoints > 0);
  const hasPointToken = /(?:^|\s)\+\s*\d{1,4}(?:\s|$)/.test(combined)
    || /(?:^|\s)\d{1,4}\s*(?:分|积分)(?:\s|$|[，,。.])/.test(combined);
  const isKnownContainer = /每日活动集|daily set/.test(combined);
  if (!hasPositivePoints && !hasPointToken && !isKnownContainer) {
    return notExecutable('【无积分/仅营销 (跳过)】', '未发现可验证的积分奖励标记');
  }

  // 5. Select the interaction strategy used by the executor.
  if (destination.includes('imagepuzzle') || combined.includes('拼图') || combined.includes('puzzle')) {
    return executable('puzzle', '拼图类交互');
  }
  if (destination.includes('bing.com/search') || /化石精选|拓展你的|探索知识|知识探索/.test(combined)) {
    return executable('search-exploration', '需要打开结果页并点击自然搜索结果');
  }
  return executable('web-interaction', '网页内可执行活动');
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
      const feasibility = classifyTaskFeasibility(card.title || card.name || '', {
        ...(card.attributes || {}),
        points: card.pointProgressMax || card.points,
        destination: card.destination || ''
      });
      const item = {
        id: card.offerId || card.id || Math.random().toString(36).slice(2, 8),
        title: card.title || card.name || '未命名活动',
        subtitle: card.description || '',
        points: Number(card.pointProgressMax || card.points || 0),
        progress: Number(card.pointProgress || (card.isCompleted ? card.pointProgressMax || card.points : 0)),
        max: Number(card.pointProgressMax || card.points || 1),
        executable: feasibility.executable,
        kind: feasibility.kind || null,
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
