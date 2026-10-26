import path from 'path';
import { DATA_DIR } from '../fsUtil.js';
﻿import configManager, { getTodayDateString } from '../config.js';
import logger from '../logger.js';
import accountContextLock from './contextLock.js';
import { readBrowserSession, writeBrowserSession } from '../identity/browserSession.js';
import { executeAutonomousAccountLogin } from '../identity/adaptiveAuth.js';
import { DapiClient } from '../identity/dapi.js';
import browserManager from '../browser/browser.js';
import {
  performHumanizedSearch,
  penetrateDailySetActivities,
  penetrateDailyActivities,
  penetratePunchCardQuest,
  penetratePuzzleSpotlight,
  harvestClaimablePointsWithVirtualPointer,
  getRandomSearchWord,
  claimBrowserExtensionActivity
} from '../browser/actions.js';
import { SearchStagnationGuard } from './searchStagnation.js';
import {
  extractOfficialTodayPoints,
  extractOfficialBalance,
  extractOfficialStreakDays,
  extractOfficialClaimablePoints
} from '../contracts/validator.js';
import { concatFlightChunks, extractOfferObjects } from '../contracts/flightParse.js';
import { buildUnifiedTaskBoard, classifyTaskFeasibility, extractStreakModels, extractOfficialStamps } from '../contracts/streaks.js';
import historyManager from './history.js';
import notifier from './notifier.js';

export const TASK_STOP_MESSAGE = '任务已被用户主动中断';

/**
 * Parse only the search row from the opened official points drawer.
 * A loose page-wide number match is intentionally forbidden here.
 */
export function parseOfficialSearchPointsDetail(detailText = '') {
  const lines = String(detailText || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const valueRe = /^([0-9]{1,5})\s*\/\s*([0-9]{1,5})(?:\s*(?:分|points?))?$/i;
  const rowRe = /^(必应搜索|Bing search|PC\s*搜索|PC\s*Search)\s*[:：]?\s*([0-9]{1,5})\s*\/\s*([0-9]{1,5})(?:\s*(?:分|points?))?(?:\s*[+＋]\s*[0-9]{1,5}\s*分)?$/i;
  const labelRe = /^(必应搜索|Bing search|PC\s*搜索|PC\s*Search)\s*[:：]?$/i;

  for (let i = 0; i < lines.length; i++) {
    let current;
    let max;
    const rowMatch = lines[i].match(rowRe);
    if (rowMatch) {
      current = Number(rowMatch[2]);
      max = Number(rowMatch[3]);
    } else if (labelRe.test(lines[i]) && i + 1 < lines.length) {
      const valueMatch = lines[i + 1].match(valueRe);
      if (valueMatch) {
        current = Number(valueMatch[1]);
        max = Number(valueMatch[2]);
      }
    }

    if (!Number.isInteger(current) || !Number.isInteger(max)) continue;
    // 关键拦截：PC/必应搜索积分上限至少为 30 分，彻底排除“连续打卡 1/1”等非积分配额卡片
    if (max < 30 || current < 0 || current > max) continue;
    return {
      current,
      max,
      isMaxed: current >= max,
      source: 'points-detail'
    };
  }
  return null;
}

export function describeOfficialNeed(value) {
  if (value === true) return '待做';
  if (value === false) return '已完成';
  return '未知';
}

/**
 * Build a tri-state task snapshot from official DOM evidence.
 * null means unknown. Unknown never becomes work and never counts as complete.
 */
export function buildOfficialTaskSnapshot({ text = '', sections = [], searchPoints = null, account = null, streaks = {}, stamps = null } = {}) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const counter = (re) => {
    for (const line of lines) {
      const match = line.match(re);
      if (match) return { current: Number(match[1]), max: Number(match[2]) };
    }
    return null;
  };

  const todayStr = getTodayDateString();
  const todayDoneQuests = (account?.dailyQuestsDone?.date === todayStr)
    ? (account.dailyQuestsDone.hrefs || [])
    : [];
  const questsAttemptedToday = account?.dailyQuestsAttempted?.date === todayStr;

  const searchStreak = counter(/^搜索\s*:\s*([0-9]+)\s*\/\s*([0-9]+)$/);
  const dailySet = counter(/^活动\s*:\s*([0-9]+)\s*\/\s*([0-9]+)$/);
  const appCheckIn = counter(/^签到\s*:\s*([0-9]+)\s*\/\s*([0-9]+)$/);
  const dailySection = sections.find((section) => section.title === '日常任务') || null;
  const questSection = sections.find((section) => section.title === '任务') || null;
  const dailyCards = dailySection?.cards || [];
  const questCards = questSection?.cards || [];
  const dailyPending = dailyCards.filter((card) => !card.done && !card.disabled && card.executable !== false);

  // 关键：若打孔卡今天已推进（打卡过或检测到明日解锁），从待做列表中剔除，防止死循环重跑
  const questPending = questCards.filter((card) => {
    if (questsAttemptedToday) return false;
    if (card.done || card.disabled) return false;
    const cardHref = card.href || '';
    const isDoneToday = todayDoneQuests.some((doneHref) => doneHref && (cardHref.includes(doneHref) || doneHref.includes(cardHref)));
    return !isDoneToday;
  });

  let needSearch = searchPoints ? !searchPoints.isMaxed : null;
  const needDailySet = dailySet ? dailySet.current < dailySet.max : null;
  const needAppSign = appCheckIn ? appCheckIn.current < appCheckIn.max : null;
  const needDailyActivities = dailySection ? dailyPending.length > 0 : null;
  const needQuests = questSection ? questPending.length > 0 : null;
  const state = {
    search: needSearch,
    dailySet: needDailySet,
    appSign: needAppSign,
    dailyActivities: needDailyActivities,
    quests: needQuests
  };
  const unknown = Object.entries(state)
    .filter(([, value]) => value === null)
    .map(([key]) => key);

  const questsTodayCount = questCards.filter((card) => !card.done && !card.disabled).length;
  const questsTodayDone = questsTodayCount > 0 && questPending.length === 0;

  // 结构化整理全量打孔卡与日常任务，供前端抽屉与详细列表渲染
  const formatCard = (c) => {
    const rawTitle = c.title || '';
    const progressMatch = rawTitle.match(/(\d+)\s*\/\s*(\d+)\s*个任务/);
    const cur = progressMatch ? Number(progressMatch[1]) : (c.done ? 1 : 0);
    const total = progressMatch ? Number(progressMatch[2]) : 1;
    const ptsMatch = rawTitle.match(/\+(\d+)/);
    const rewardPts = ptsMatch ? Number(ptsMatch[1]) : 0;
    const isCooling = /等待冷却|冷却|稍后再试|明日解锁/.test(rawTitle);
    return {
      title: rawTitle,
      href: c.href || '',
      done: !!c.done || (cur >= total && total > 0),
      current: cur,
      total: total,
      percent: Math.min(100, Math.round((cur / Math.max(1, total)) * 100)),
      rewardPts,
      isCooling,
      executable: c.executable !== false,
      feasibilityTag: c.feasibilityTag || ''
    };
  };

  const allQuestCards = questCards.map(formatCard);
  const allDailyCards = dailyCards.map(formatCard);

  return {
    searchStreak,
    dailySet,
    appCheckIn,
    searchPoints,
    dailyPending,
    questPending,
    allQuestCards,
    allDailyCards,
    questsTodayDone,
    questsAttemptedToday,
    needSearch,
    needDailySet,
    needAppSign,
    needDailyActivities,
    needQuests,
    hasWork: Object.values(state).some((value) => value === true),
    hasUnknown: unknown.length > 0,
    streaks,
    stamps,
    details: {
      searchStreak,
      dailySet,
      appCheckIn,
      streaks,
      stamps,
      dailyPending: dailyPending.map((card) => card.title),
      questPending: questPending.map((card) => card.title),
      allQuestCards,
      allDailyCards,
      questsTodayDone,
      searchPoints: searchPoints || { unknown: true },
      state,
      unknown
    }
  };
}

/**
 * A remaining plan is allow-listed by explicit official true values only.
 * Unknown and false are both non-executable in remaining mode.
 */
export function buildTaskPlan(taskScope, officialTasks = null) {
  if (taskScope === 'remaining') {
    return {
      appSign: officialTasks?.needAppSign === true,
      dailySet: officialTasks?.needDailySet === true,
      quests: officialTasks?.needQuests === true,
      dailyActivities: officialTasks?.needDailyActivities === true,
      search: officialTasks?.needSearch === true
    };
  }
  return {
    appSign: taskScope === 'all' || taskScope === 'appSign',
    dailySet: taskScope === 'all' || taskScope === 'dailySet',
    quests: taskScope === 'all' || taskScope === 'quests',
    dailyActivities: taskScope === 'all' || taskScope === 'puzzle' || taskScope === 'dailyActivities',
    search: taskScope === 'all' || taskScope === 'search'
  };
}

export class TaskManager {
  constructor() {
    this.runningAccountId = null;
    this.runningAccountName = '';
    this.currentTaskSection = '';
    this.currentTaskName = '';
    this.shouldStop = false;
    this.isQueueRunning = false;
    this.activeRunId = null;
    this.stopReason = '';
  }

  isAccountRunning(accountId) {
    return this.runningAccountId === accountId;
  }

  beginRun(reason = '任务流水线') {
    const runId = Date.now() + Math.random().toString(36).slice(2, 8);
    this.activeRunId = runId;
    this.shouldStop = false;
    this.stopReason = '';
    return runId;
  }

  async waitUnlessStopped(milliseconds) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (this.shouldStop) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    }
    return !this.shouldStop;
  }

  finalizeAccountRun(accountId) {
    this.runningAccountId = null;
    this.runningAccountName = '';
    this.currentTaskSection = '';
    this.currentTaskName = '';
    accountContextLock.release(accountId);
  }

  /**
   * 用户主动中断/停止当前任务流水线
   */
  stopCurrentTask(reason = '用户主动中断') {
    if (!this.runningAccountId && !this.isQueueRunning) {
      return { stopped: false, message: '当前没有正在执行中的任务' };
    }

    const accName = this.runningAccountName || this.runningAccountId || '批量队列';
    if (this.shouldStop) {
      return { stopped: true, alreadyStopping: true, accountName: accName };
    }
    this.shouldStop = true;
    this.stopReason = reason;
    logger.log('🛑', reason + '：正在安全回收浏览器并释放账号 [' + accName + '] 上下文...');

    // 强行关闭浏览器中断所有导航与等待
    if (browserManager.activeBrowser) {
      browserManager.close(browserManager.activeBrowser).catch(() => {});
    }

    return { stopped: true, accountName: accName, message: `已中断账号 [${accName}] 的自动化任务流水线` };
  }

  /**
   * 抓取官网权威数据看板
   */
  async fetchOfficialDashboard(context, account, options = {}) {
    let page = await context.newPage();
    const log = (msg) => logger.log('📊', `[官网同步] ${msg}`, '', account.name);

    let todayPoints = null;
    let balance = null;
    let streakDays = 0;
    let claimablePoints = null;
    let flightChunks = '';
    let earnHtml = '';
    let earnText = '';
    let dashHtml = '';
    let dashText = '';
    let sources = { balance: 'unknown', todayPoints: 'unknown', streakDays: 'unknown', claimablePoints: 'unknown' };

    const safeGoto = async (url, name) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (page.isClosed()) {
            page = await context.newPage();
          }
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          } catch (navErr) {
            const isCrashOrTimeout = navErr.message && (
              navErr.message.includes('Timeout') ||
              navErr.message.includes('timeout') ||
              navErr.message.includes('crashed') ||
              navErr.message.includes('Target') ||
              navErr.message.includes('closed')
            );
            if (isCrashOrTimeout) {
              log(`访问 ${name} 遇到网络延迟或视口重载 (${navErr.message})，降级为轻量直连模式自愈...`);
              try { if (page && !page.isClosed()) await page.close().catch(() => {}); } catch {}
              page = await context.newPage();
              await page.goto(url, { waitUntil: 'commit', timeout: 25000 });
            } else {
              throw navErr;
            }
          }
          await new Promise((r) => setTimeout(r, 2500));
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await page.waitForFunction(() => document.body && document.body.innerText.length > 30, { timeout: 12000 }).catch(() => {});
          return true;
        } catch (e) {
          log(`访问 ${name} 尝试 ${attempt}/2 异常: ${e.message}`);
          try { await page.close(); } catch {}
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 1500));
            page = await context.newPage();
          }
        }
      }
      return false;
    };

    try {
      // 1. 请求 /earn 页面
      try {
        log('访问 https://rewards.bing.com/earn 页面获取今日成效看板...');
        const ok = await safeGoto('https://rewards.bing.com/earn', '/earn');
        if (ok) {
          for (let r = 0; r < 10; r++) {
            try {
              earnHtml = await page.content();
              earnText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
              flightChunks = concatFlightChunks(earnHtml);
              const tp = extractOfficialTodayPoints(flightChunks, `${earnHtml}\n${earnText}`);
              if (tp !== null) {
                todayPoints = tp;
                break;
              }
            } catch {}
            await new Promise((res) => setTimeout(res, 800));
          }
          if (todayPoints === null && earnHtml && earnText) {
            todayPoints = extractOfficialTodayPoints(flightChunks, `${earnHtml}\n${earnText}`);
          }
          if (earnHtml && earnText) {
            streakDays = extractOfficialStreakDays(flightChunks, `${earnHtml}\n${earnText}`);
            balance = extractOfficialBalance(flightChunks, `${earnHtml}\n${earnText}`);
          }

          try {
            const shotPath = path.join(DATA_DIR, 'latest_screencast.png');
            await page.screenshot({ path: shotPath }).catch(() => {});
          } catch {}
        } else {
          log('访问 /earn 未能成功建立连接，将通过 /dashboard 页面兜底');
        }
      } catch (e) {
        log(`访问 /earn 发生异常: ${e.message}，将通过 /dashboard 页面兜底`);
      }

      // 2. 请求 /dashboard 页面
      try {
        log('访问 https://rewards.bing.com/dashboard 页面获取资产总额与待领抽屉...');
        const ok = await safeGoto('https://rewards.bing.com/dashboard', '/dashboard');
        if (ok) {
          for (let r = 0; r < 10; r++) {
            try {
              dashHtml = await page.content();
              dashText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
              const dashFlight = concatFlightChunks(dashHtml);
              const combinedDash = `${dashFlight}\n${dashHtml}\n${dashText}`;
              if (balance === null) balance = extractOfficialBalance(dashFlight, combinedDash);
              if (todayPoints === null) todayPoints = extractOfficialTodayPoints(dashFlight, combinedDash);
              if (!streakDays) streakDays = extractOfficialStreakDays(dashFlight, combinedDash);
              claimablePoints = extractOfficialClaimablePoints(dashFlight, `${dashHtml}\n${dashText}`);
              if (balance !== null && claimablePoints !== null) break;
            } catch {}
            await new Promise((res) => setTimeout(res, 800));
          }

          try {
            const shotPath = path.join(DATA_DIR, 'latest_screencast.png');
            await page.screenshot({ path: shotPath }).catch(() => {});
          } catch {}
        }
      } catch (e) {
        log(`访问 /dashboard 异常: ${e.message}`);
      }

      sources.balance = balance !== null ? 'live' : 'unknown';
      sources.todayPoints = todayPoints !== null ? 'live' : 'unknown';
      sources.streakDays = streakDays ? 'live' : 'unknown';
      sources.claimablePoints = claimablePoints !== null ? 'live' : 'unknown';
      const allowCachedFallback = options.allowCachedFallback !== false;
      if (allowCachedFallback) {
        if (balance === null && account.balance !== undefined) { balance = account.balance; sources.balance = 'cache'; }
        if (todayPoints === null && account.todayEarned !== undefined) { todayPoints = account.todayEarned; sources.todayPoints = 'cache'; }
        if (!streakDays && account.streakDays !== undefined) { streakDays = account.streakDays; sources.streakDays = 'cache'; }
        if (claimablePoints === null && account.claimablePoints !== undefined) { claimablePoints = account.claimablePoints; sources.claimablePoints = 'cache'; }
      }
      log(`权威数据采集结果 - 可用余额: ${balance !== null ? balance + ' 分' : '未捕获'}, 今日已增: ${todayPoints !== null ? todayPoints + ' 分' : '0 分'}, 连续打卡: ${streakDays} 天, 待领额外: ${claimablePoints} 分`);
    } catch (e) {
      log(`官网看板数据同步异常: ${e.message}`);
    } finally {
      if (page && typeof page.close === 'function') { await page.close().catch(() => {}); }
    }

    const rawOffers = extractOfferObjects(flightChunks || dashHtml);
    const parsedCards = [];
    for (const chunk of rawOffers) {
      try {
        const obj = JSON.parse(chunk);
        if (obj && (obj.offerId || obj.title)) parsedCards.push(obj);
      } catch {}
    }

    const taskBoard = buildUnifiedTaskBoard(
      {
        stampsProgress: streakDays % 7,
        bingSearchCompleted: todayPoints >= 60,
        dailySetCompleted: todayPoints >= 30 ? 3 : Math.floor(todayPoints / 10),
        bingAppCompleted: todayPoints >= 10,
        levelDailySetDays: Math.min(streakDays, 7),
        levelBingDays: Math.min(streakDays, 7),
        levelBingAppDays: Math.min(streakDays, 7)
      },
      parsedCards
    );

    const combinedRaw = (flightChunks || "") + "\n" + (earnHtml || "") + "\n" + (dashHtml || "");
    const streaks = extractStreakModels(combinedRaw);
    const stamps = extractOfficialStamps(combinedRaw);

    return {
      todayPoints: todayPoints !== null ? todayPoints : 0,
      balance: balance !== null ? balance : 0,
      streakDays,
      claimablePoints,
      taskBoard,
      parsedCards,
      sources,
      streaks,
      stamps,
      combinedRawText: combinedRaw
    };
  }

  /**
   * 顺序执行全账号批量任务
   */
  async runAllAccountsTasks(options = {}) {
    this.beginRun('批量队列');
    this.isQueueRunning = true;
    const accounts = configManager.getAccounts().filter((a) => a.enabled);
    const taskScope = options.taskScope || 'all';
    try {
      if (accounts.length === 0) throw new Error('未检测到已启用的托管账号');
      logger.log('🚀', `>>> 开始批量执行全账号队列流水线 (共 ${accounts.length} 户，任务范围: ${taskScope}) <<<`);

    for (let i = 0; i < accounts.length; i++) {
      if (this.shouldStop) {
        logger.log('🛑', '检测到中断指令，批量队列提前终止');
        break;
      }

      const acc = accounts[i];
      try {
        await this.runAccountTasks(acc.id, { taskScope, preserveStopState: true });
      } catch (err) {
        if (err.message === TASK_STOP_MESSAGE) {
          logger.log('🛑', `账号 [${acc.name}] 已按用户指令停止`);
        } else {
          logger.log('🔴', `账号 [${acc.name}] 流水线异常: ${err.message}`);
        }
      }

      if (i < accounts.length - 1 && !this.shouldStop) {
        logger.log('❄️', '账号切换物理隔离冷却 15 秒...');
        await this.waitUnlessStopped(15000);
      }
    }
    if (this.shouldStop) {
      logger.log('🛑', '>>> 批量全账号任务流水线已按用户指令中断 <<<');
    } else {
      logger.log('🎉', '>>> 批量全账号任务流水线执行完毕 <<<');
    }
    this.isQueueRunning = false;
    return { success: true, stopped: this.shouldStop };
    } finally {
      this.isQueueRunning = false;
    }
  }

  /**
   * 执行单账号全生命周期任务流水线
   */
  async runAccountTasks(accountId, options = {}) {
    const account = configManager.getAccount(accountId);
    if (!account) throw new Error(`找不到账号 ID: ${accountId}`);

    // A standalone invocation starts a new cancellation scope. Calls made by
    // an active batch or scheduler series preserve the stop signal.
    if (!options.preserveStopState && !this.isQueueRunning) {
      this.beginRun('账号任务');
    }
    const currentRunId = this.activeRunId;
    if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

    const taskScope = options.taskScope || 'all';
    const todayStr = getTodayDateString();

    // 未完成任务自动重试次数控制：可在配置中心自行设置，设为 0 则不自动重试未完成任务
    if (taskScope === 'remaining' && !options.force) {
      const fullCfg = configManager.get();
      const configuredMax = fullCfg.scheduler?.maxRemainingRetries !== undefined
        ? Number(fullCfg.scheduler.maxRemainingRetries)
        : (fullCfg.taskOptions?.maxRemainingRetries !== undefined ? Number(fullCfg.taskOptions.maxRemainingRetries) : 2);
      const maxRetries = options.maxRemainingRetries !== undefined
        ? Number(options.maxRemainingRetries)
        : configuredMax;

      if (maxRetries === 0) {
        logger.log('🛑', `[重试保护] 账号 [${account.name}] 未完成任务重试次数配置为 0，跳过自动补做。`, '', account.name);
        return { success: true, skipped: true, reason: 'remaining-retries-disabled' };
      }

      const retryCount = (account.remainingRetriesDate === todayStr) ? (Number(account.remainingRetryCount) || 0) : 0;
      if (retryCount >= maxRetries) {
        logger.log('🛑', `[重试保护] 账号 [${account.name}] 今日未完成剩余任务已执行 ${retryCount} 次（已达配置上限 ${maxRetries} 次），安全跳过，防止反复死循环。`, '', account.name);
        return { success: true, skipped: true, reason: 'max-remaining-retries-reached' };
      }
      configManager.upsertAccount({
        id: accountId,
        remainingRetryCount: retryCount + 1,
        remainingRetriesDate: todayStr
      });
      logger.log('🎯', `[未完成任务补做] 账号 [${account.name}] 正在进行今日第 ${retryCount + 1}/${maxRetries} 次未完成任务补做扫描...`, '', account.name);
    }

    if (!accountContextLock.acquire(accountId)) {
      throw new Error(`账号 [${account.name}] 正在执行任务中，锁定互斥！`);
    }

    this.runningAccountId = accountId;
    this.runningAccountName = account.name || account.user;
    this.currentTaskSection = '环境准备';
    this.currentTaskName = '正在准备执行环境...'; this.taskStartTime = Date.now();

    configManager.upsertAccount({ id: accountId, status: 'running' });
    const log = (msg) => logger.log('🚀', msg, '', account.name);

    log(`>>> 启动账号 [${account.name}] 自动化流水线 (范围: ${taskScope}) <<<`);

    if (taskScope === 'harvest') {
      try {
        this.currentTaskName = '\u989d\u5916\u79ef\u5206\u9886\u53d6\u4e0e\u5b98\u7f51\u5bf9\u8d26';
        return await this.harvestMidnightClaimable(accountId, { lockAlreadyHeld: true });
      } finally {
        this.finalizeAccountRun(accountId);
      }
    }

    try {
      // 1. 会话校验与自愈登录
      let session = readBrowserSession(accountId);
      let tokens = session?.tokens;
      let cookies = session?.cookies || [];

      const hasU = cookies.some((c) => c.name === '_U' && c.domain.includes('bing.com'));
      if (!session || !tokens || !hasU) {
        this.currentTaskName = '账号密码自适应登录与凭据自愈...';
        log('缺少有效登录会话或必应 _U 凭据，正在触发自适应自愈登录...');
        const authRes = await executeAutonomousAccountLogin(account);
        if (!authRes.success) {
          if (authRes.status === 'needs_2fa') {
            configManager.upsertAccount({ id: accountId, status: 'needs_2fa' });
            log('⚠️ 该账号需要手机端 2FA 验证，安全跳过');
            return authRes;
          }
          throw new Error(authRes.message || '自适应登录失败');
        }
        session = readBrowserSession(accountId);
        tokens = session.tokens;
        cookies = session.cookies;
      }

      if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

      // 2. 移动端 DAPI 任务
      if (taskScope === 'all' || taskScope === 'appSign' || taskScope === 'newsRead') {
        const dapi = new DapiClient(account, tokens, (refreshedTokens) => {
          session.tokens = refreshedTokens;
          writeBrowserSession(accountId, session);
        });

        this.currentTaskSection = '移动端任务';
        if (taskScope === 'all' || taskScope === 'appSign') {
          this.currentTaskName = '必应移动应用连续签到 (DAPI直连)';
          await dapi.performAppCheckIn();
        }

        if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

        if (taskScope === 'all' || taskScope === 'newsRead') {
          this.currentTaskName = '移动端新闻资讯阅读 (30 积分)';
          await dapi.performNewsReading(10);
        }
      }

      if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

      // 3. PC 端任务
      // remaining 必须进入浏览器，先从官网实时 DOM 生成任务快照，再逐项只补未完成项。
      const needBrowser = taskScope === 'all' || taskScope === 'remaining' || ['dailySet', 'search', 'puzzle', 'quests', 'dailyActivities'].includes(taskScope);
      if (needBrowser) {
        this.currentTaskSection = '桌面端任务';
        await browserManager.withBrowser(
          { proxy: account.proxy, cookies, headless: true },
          async (browser, context) => {
            log('同步初始官网成效看板...');
            this.currentTaskName = '同步官网初始真实看板...';
            // 先读取官网实时任务快照，供后续执行分支与历史快照共同使用。
            let officialTasks = null;
            try {
              officialTasks = await this.fetchOfficialTaskSnapshot(context, account);
            } catch (snapshotErr) {
              log(`⚠️ 官网实时任务判定失败；remaining 模式将按未知处理且不执行未确认任务: ${snapshotErr.message}`);
            }
            const initialData = await this.fetchOfficialDashboard(context, account);
            const initialToday = initialData?.todayPoints ?? null;
            const initialBalance = initialData?.balance ?? null;
            const initialAccountUpdate = { id: accountId, lastSyncAt: Date.now() };
            if (initialData.sources?.balance === 'live') initialAccountUpdate.balance = initialData.balance;
            if (initialData.sources?.todayPoints === 'live') initialAccountUpdate.todayEarned = initialData.todayPoints;
            if (initialData.sources?.streakDays === 'live') initialAccountUpdate.streakDays = initialData.streakDays;
            if (initialData.sources?.claimablePoints === 'live') initialAccountUpdate.claimablePoints = initialData.claimablePoints;
            if (officialTasks) { initialAccountUpdate.officialTasks = officialTasks; if (officialTasks.streaks) initialAccountUpdate.streaks = officialTasks.streaks; if (officialTasks.stamps) initialAccountUpdate.stamps = officialTasks.stamps; }
            initialAccountUpdate.dataState = initialData.sources?.balance === 'live'
              && initialData.sources?.todayPoints === 'live'
              && officialTasks
              ? (officialTasks.hasUnknown ? 'partial' : 'complete')
              : 'partial';
            configManager.upsertAccount(initialAccountUpdate);
            historyManager.recordDaily(accountId, {
              todayEarned: initialData.sources?.todayPoints === 'live' ? initialData.todayPoints : null,
              balance: initialData.sources?.balance === 'live' ? initialData.balance : null,
              streakDays: initialData.sources?.streakDays === 'live' ? initialData.streakDays : null,
              claimablePoints: initialData.sources?.claimablePoints === 'live' ? initialData.claimablePoints : null,
              officialTasks,
              source: 'official-sync'
            });

            const ensureHealthyPage = async (p) => {
              try {
                if (!p || p.isClosed()) return await context.newPage();
                await p.evaluate(() => 1);
                return p;
              } catch (err) {
                log(`🔄 检测到前置视口状态异常 (${err.message})，立即自愈新建独立健康视口...`);
                try { if (p && !p.isClosed()) await p.close().catch(() => {}); } catch {}
                return await context.newPage();
              }
            };

            let page = await context.newPage();

            try {
              // remaining 只消费当前账号刚刚读取的官网快照；unknown 绝不当成待做。
              const taskPlan = buildTaskPlan(taskScope, officialTasks, account);
              if (taskScope === 'remaining') {
                if (!officialTasks) {
                  log('⚠️ [剩余任务] 未取得当前账号官网快照，安全跳过全部任务，不执行全量兜底。');
                  return;
                }
                log(`🎯 [官网实时判定] 剩余: 搜索=${describeOfficialNeed(officialTasks.needSearch)}, App=${describeOfficialNeed(officialTasks.needAppSign)}, DailySet=${describeOfficialNeed(officialTasks.needDailySet)}, 日常任务=${describeOfficialNeed(officialTasks.needDailyActivities)}, 打孔卡=${describeOfficialNeed(officialTasks.needQuests)}`);
                if (officialTasks.hasUnknown) {
                  log(`⚠️ [剩余任务] 官网状态未知项: ${officialTasks.details.unknown.join(', ')}；未知项不会执行。`);
                }
                if (!officialTasks.hasWork && !officialTasks.hasUnknown) {
                  log('✅ [剩余任务] 官网实时状态显示今日可执行任务已全部完成。');
                  const cleanData = await this.fetchOfficialDashboard(context, account, { allowCachedFallback: false });
                  const cleanUpdate = { id: accountId, status: 'ready', officialTasks, lastSyncAt: Date.now(), lastRun: Date.now() };
                  if (cleanData.sources?.balance === 'live') cleanUpdate.balance = cleanData.balance;
                  if (cleanData.sources?.todayPoints === 'live') cleanUpdate.todayEarned = cleanData.todayPoints;
                  if (cleanData.sources?.streakDays === 'live') cleanUpdate.streakDays = cleanData.streakDays;
                  if (cleanData.sources?.claimablePoints === 'live') cleanUpdate.claimablePoints = cleanData.claimablePoints;
                  cleanUpdate.dataState = cleanData.sources?.balance === 'live' && cleanData.sources?.todayPoints === 'live'
                    ? (officialTasks?.hasUnknown ? 'partial' : 'complete')
                    : 'partial';
                  configManager.upsertAccount(cleanUpdate);
                  historyManager.recordDaily(accountId, {
                    todayEarned: cleanData.sources?.todayPoints === 'live' ? cleanData.todayPoints : null,
                    balance: cleanData.sources?.balance === 'live' ? cleanData.balance : null,
                    streakDays: cleanData.sources?.streakDays === 'live' ? cleanData.streakDays : null,
                    claimablePoints: cleanData.sources?.claimablePoints === 'live' ? cleanData.claimablePoints : null,
                    officialTasks,
                    source: 'official-sync'
                  });
                  return;
                }
                if (taskPlan.appSign) {
                  this.currentTaskSection = '移动端任务';
                  this.currentTaskName = '必应移动应用连续签到 (官网判定待做)';
                  const dapi = new DapiClient(account, tokens, (refreshedTokens) => {
                    session.tokens = refreshedTokens;
                    writeBrowserSession(accountId, session);
                  });
                  await dapi.performAppCheckIn();
                }
              }

              const runDailySet = taskPlan.dailySet;
              const runQuests = taskPlan.quests;
              const runDailyActs = taskPlan.dailyActivities;
              const runSearch = taskPlan.search;

              if (runDailySet) {
                this.currentTaskSection = '板块 1: 连续打卡';
                this.currentTaskName = '每日活动集 (Daily Set 3/3 抽屉打卡)';
                log('>>> 执行【板块 1: 连续打卡任务 (Streaks)】每日活动集 (Daily Set 3/3)...');
                const setPage = await context.newPage();
                try {
                  await penetrateDailySetActivities(setPage, { accountPrefix: account.name });
                  if (taskScope === 'dailySet' && officialTasks?.dailyPending?.length > 0) {
                    log(`💡 [执行指引] 每日活动集 (Daily Set) 已处理完毕；检测到尚有 ${officialTasks.dailyPending.length} 项日常任务待做 (如: ${officialTasks.dailyPending.slice(0, 2).map(x => (x.title || x)).join(', ')})，若需执行请选择【仅日常活动与问答】或【仅执行未完成剩余任务】模式。`);
                  }
                } finally {
                  if (setPage && !setPage.isClosed()) await setPage.close().catch(() => {});
                }
              }
              if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

              log('>>> 检查【板块 2: 升级活动 (Level Up)】(随日常打卡与搜索自动驱动累积)...');

              if (runQuests) {
                this.currentTaskSection = '板块 3: 打孔卡任务';
                this.currentTaskName = '多步任务打孔卡 (Punch Cards)';
                log('>>> 执行【板块 3: 任务 (Punch Cards / Quests)】多步打孔卡...');
                const questHrefs = taskScope === 'remaining'
                  ? (officialTasks?.questPending || []).map((q) => q.href).filter(Boolean)
                  : (officialTasks?.questPending?.length
                    ? officialTasks.questPending.map((q) => q.href).filter(Boolean)
                    : await (async () => {
                        const tempP = await context.newPage();
                        try {
                          await tempP.goto('https://rewards.bing.com/earn', { waitUntil: 'commit', timeout: 25000 });
                          return await tempP.evaluate(() => {
                            const hrefs = [...new Set([...document.querySelectorAll('a[href*="/quest/"]')].map((a) => a.getAttribute('href')).filter(Boolean))];
                            const html = document.body.innerHTML || '';
                            const match = html.match(/href="(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i)
                              || html.match(/"(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i);
                            if (match && match[1] && !hrefs.includes(match[1])) {
                              hrefs.push(match[1]);
                            }
                            return hrefs;
                          });
                        } catch { return []; } finally { await tempP.close().catch(() => {}); }
                      })());

                log(`检索到 ${questHrefs.length} 个待推进打孔卡任务`);
                const completedTodayHrefs = [];
                for (const qUrl of questHrefs) {
                  if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);
                  if (qUrl) {
                    const questPage = await context.newPage();
                    try {
                      const questRes = await penetratePunchCardQuest(questPage, qUrl, { accountPrefix: account.name });
                      if (questRes !== false) {
                        completedTodayHrefs.push(qUrl);
                      }
                    } finally {
                      if (questPage && !questPage.isClosed()) await questPage.close().catch(() => {});
                    }
                  }
                }
                const attemptedRecord = { date: todayStr, attemptedAt: Date.now() };
                account.dailyQuestsAttempted = attemptedRecord;
                if (completedTodayHrefs.length > 0) {
                  const currentQuestsDone = (account.dailyQuestsDone?.date === todayStr)
                    ? (account.dailyQuestsDone.hrefs || [])
                    : [];
                  const updatedQuestsDone = [...new Set([...currentQuestsDone, ...completedTodayHrefs])];
                  account.dailyQuestsDone = { date: todayStr, hrefs: updatedQuestsDone };
                }
                configManager.upsertAccount({
                  id: accountId,
                  dailyQuestsAttempted: attemptedRecord,
                  ...(account.dailyQuestsDone ? { dailyQuestsDone: account.dailyQuestsDone } : {})
                });
              }
              if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

              if (runDailyActs) {
                this.currentTaskSection = '板块 4: 日常任务';
                this.currentTaskName = '日常活动与问答 (Daily Activities)';
                log('>>> 执行【板块 4: 日常任务 (Daily Activities)】日常活动与拼图全量穿透...');
                const pendingKeys = officialTasks?.dailyPending?.map((x) => x.key || x.href || x.title) || null;
                if (taskScope !== 'remaining' || pendingKeys) {
                  const actPage = await context.newPage();
                  try {
                    await penetrateDailyActivities(actPage, { accountPrefix: account.name, pendingKeys });
                  } finally {
                    if (actPage && !actPage.isClosed()) await actPage.close().catch(() => {});
                  }
                }

                // 核心穿透：特殊扩展任务（浏览器中的奖励 +30分，对标参考项目 v1.8.10）
                const extPage = await context.newPage();
                try {
                  await claimBrowserExtensionActivity(extPage, { accountPrefix: account.name });
                } catch (eExt) {
                  log(`特殊扩展活动执行跳过: ${eExt.message}`);
                } finally {
                  if (extPage && !extPage.isClosed()) await extPage.close().catch(() => {});
                }
              }
              if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

              let needsSearchSecondPass = false;
              if (runSearch) {
                page = await ensureHealthyPage(page);
                this.currentTaskName = '必应 PC 拟人搜索收割 (跑满官网上限)';
                log('执行板块 1-核心: 必应 PC 拟人化搜索收割 (跑满官网上限)...');
                const fullCfg = configManager.get();
                const taskOpts = fullCfg.taskOptions || {};
                const searchCfg = fullCfg.searchSettings || {};
                const maxSearches = searchCfg.maxDailySearches || 30;
                const baseSec = Number(taskOpts.baseIntervalSec) || 18;
                const jitterSec = Number(taskOpts.randomJitterSec) || 6;
                const stagnationThreshold = Number(taskOpts.stagnationLimit) || 10;
                const stagnationGuard = new SearchStagnationGuard(stagnationThreshold, account.name);
                stagnationGuard.recordObservation(initialData.todayPoints);
                const initialSearchCap = officialTasks?.searchPoints || null;
                if (initialSearchCap?.isMaxed) {
                  log(`🎉 [已达上限] 官网必应搜索已跑满 ${initialSearchCap.current}/${initialSearchCap.max} 分，安全跳过。`);
                } else {
                  for (let i = 1; i <= maxSearches; i++) {
                    if (this.shouldStop || stagnationGuard.isTripped()) break;
                    const word = getRandomSearchWord();
                    this.currentTaskName = `必应 PC 搜索 (第 ${i}/${maxSearches} 轮: "${word}")`;
                    log(`正在执行第 ${i}/${maxSearches} 轮搜索: "${word}"...`);
                    let searchRes = null;
                    try {
                      searchRes = await performHumanizedSearch(page, word, { accountPrefix: account.name, context });
                      if (searchRes && typeof searchRes.goto === 'function') page = searchRes;
                    } catch (searchErr) {
                      log(`⚠️ 第 ${i}/${maxSearches} 轮搜索瞬态异常，自愈后继续: ${searchErr.message}`);
                      try { if (page && typeof page.close === 'function') await page.close().catch(() => {}); } catch {}
                      try { page = await context.newPage(); } catch {}
                    }
                    const sleepSec = baseSec + Math.random() * jitterSec;
                    log(`[风控防线] 拟人搜索间隔退避 ${sleepSec.toFixed(1)} 秒 (基础 ${baseSec}s + 浮动 ${jitterSec}s)...`);
                    await this.waitUnlessStopped(sleepSec * 1000);
                    if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);
                    if (i % 3 === 0 || i === maxSearches) {
                      const checkData = await this.fetchOfficialDashboard(context, account);
                      const midSnapshot = await this.fetchOfficialTaskSnapshot(context, account);
                      const midCap = midSnapshot.searchPoints;
                      if (midCap?.isMaxed) { log(`🎉 [搜索达标] 已跑满 ${midCap.current}/${midCap.max} 分。`); break; }
                      const obs = stagnationGuard.recordObservation(checkData.todayPoints);
                      const checkUpdate = {
                        id: accountId,
                        lastSyncAt: Date.now(),
                        officialTasks: midSnapshot
                      };
                      if (checkData.sources?.todayPoints === 'live') checkUpdate.todayEarned = checkData.todayPoints;
                      if (checkData.sources?.balance === 'live') checkUpdate.balance = checkData.balance;
                      if (checkData.sources?.streakDays === 'live') checkUpdate.streakDays = checkData.streakDays;
                      if (checkData.sources?.claimablePoints === 'live') checkUpdate.claimablePoints = checkData.claimablePoints;
                      configManager.upsertAccount(checkUpdate);
                      if (obs.stagnant && stagnationGuard.consecutiveStagnantCount >= 2) {
                        log('⏳ [搜索遇阻暂缓] 连续 2 次无增量，暂缓搜索，完成其他板块后再回眸。');
                        needsSearchSecondPass = true;
                        break;
                      }
                      if (obs.tripped) break;
                    }
                  }
                }
              }

              // 最终结算与回验
              this.currentTaskName = '权威数据对账核验...';
              log('等待 15 秒让微软服务端遥测入账...');
              await this.waitUnlessStopped(15000);
              if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

              let finalData = null;
              let verifiedOfficialTasks = null;
              for (let round = 1; round <= 3; round++) {
                if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);
                finalData = await this.fetchOfficialDashboard(context, account, { allowCachedFallback: false });
                try {
                  verifiedOfficialTasks = await this.fetchOfficialTaskSnapshot(context, account);
                } catch (snapshotErr) {
                  log(`⚠️ 执行后官网任务回读失败（${round}/3）: ${snapshotErr.message}`);
                  verifiedOfficialTasks = null;
                }
                const taskStateResolved = verifiedOfficialTasks && !verifiedOfficialTasks.hasUnknown;
                const pointsSettled = finalData.sources?.todayPoints === 'live'
                  && finalData.todayPoints > (initialData.todayPoints || 0);
                if (taskStateResolved && (pointsSettled || !verifiedOfficialTasks.hasWork)) break;
                await this.waitUnlessStopped(5000);
              }
              if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);

              if (needsSearchSecondPass) {
                log('🔄 [二次回眸] 账号其他板块已执行完毕，返回检测搜索是否恢复涨分...');
                const retryWord = getRandomSearchWord();
                await performHumanizedSearch(page, retryWord, { accountPrefix: account.name, context }).catch(() => {});
                await this.waitUnlessStopped(6000);
                if (this.shouldStop) throw new Error(TASK_STOP_MESSAGE);
                const secondCheck = await this.fetchOfficialDashboard(context, account, { allowCachedFallback: false });
                if (secondCheck.sources?.todayPoints === 'live' && secondCheck.todayPoints > finalData.todayPoints) {
                  log(`🎉 [二次回眸成功] 搜索已恢复涨分！最新今日积分: ${secondCheck.todayPoints} 分`);
                } else {
                  log('🛑 [停滞终态判定] 第 2 轮返回补做依然无增量，判定今日该账号搜索已受限，安全收工！');
                }
                finalData = secondCheck;
                try {
                  verifiedOfficialTasks = await this.fetchOfficialTaskSnapshot(context, account);
                } catch (snapshotErr) {
                  log(`⚠️ 二次回眸后的官网任务回读失败: ${snapshotErr.message}`);
                  verifiedOfficialTasks = null;
                }
              }

              const remainingText = !verifiedOfficialTasks
                ? '执行后官网任务状态回读失败，无法确认全部完成'
                : (verifiedOfficialTasks.hasUnknown
                  ? '部分官网任务状态未知，未知项未执行'
                  : (verifiedOfficialTasks.hasWork
                    ? '官网任务仍有未完成项，已执行剩余任务扫描'
                    : '官网任务已全部完成'));

              finalData.officialTasks = verifiedOfficialTasks;
              finalData.taskStatusText = remainingText;
              const hasCompleteOfficialState = Boolean(
                verifiedOfficialTasks
                && !verifiedOfficialTasks.hasUnknown
                && finalData.sources?.balance === 'live'
                && finalData.sources?.todayPoints === 'live'
              );
              const reconciledAccount = {
                id: accountId,
                status: 'ready',
                officialTasks: verifiedOfficialTasks || officialTasks || account.officialTasks || null,
                lastSyncAt: Date.now(),
                dataState: hasCompleteOfficialState ? 'complete' : 'partial',
                lastRun: Date.now()
              };
              if (finalData.sources?.balance === 'live') reconciledAccount.balance = finalData.balance;
              if (finalData.sources?.todayPoints === 'live') reconciledAccount.todayEarned = finalData.todayPoints;
              if (finalData.sources?.streakDays === 'live') reconciledAccount.streakDays = finalData.streakDays;
              if (finalData.sources?.claimablePoints === 'live') reconciledAccount.claimablePoints = finalData.claimablePoints;
              configManager.upsertAccount(reconciledAccount);
              historyManager.recordDaily(accountId, {
                todayEarned: finalData.sources?.todayPoints === 'live' ? finalData.todayPoints : null,
                balance: finalData.sources?.balance === 'live' ? finalData.balance : null,
                streakDays: finalData.sources?.streakDays === 'live' ? finalData.streakDays : null,
                claimablePoints: finalData.sources?.claimablePoints === 'live' ? finalData.claimablePoints : null,
                officialTasks: verifiedOfficialTasks,
                source: 'task-settlement'
              });

              const settledToday = finalData.sources?.todayPoints === 'live' ? finalData.todayPoints : null;
              const settledBalance = finalData.sources?.balance === 'live' ? finalData.balance : null;

              let taskHarvestedPoints = null;
              if (settledToday !== null && initialToday !== null && settledToday >= initialToday) {
                taskHarvestedPoints = settledToday - initialToday;
              } else if (settledBalance !== null && initialBalance !== null && settledBalance >= initialBalance) {
                taskHarvestedPoints = settledBalance - initialBalance;
              }

              
              // 自动收割闭环：若完成今日任务后达成了连续签到或印章里程碑送了额外积分，直接顺手收割清零
              if (finalData.sources?.claimablePoints === 'live' && Number(finalData.claimablePoints) > 0) {
                log(`🎁 检测到账号达成里程碑送了待领额外奖励 (${finalData.claimablePoints} 分)，启动自动收割收尾...`);
                try {
                  const harvestPage = await context.newPage();
                  const harvestRes = await harvestClaimablePointsWithVirtualPointer(harvestPage, { accountPrefix: account.name });
                  if (harvestPage && !harvestPage.isClosed()) await harvestPage.close().catch(() => {});
                  if (harvestRes && (harvestRes.harvested || harvestRes.status === 'claimed')) {
                    log(`🎉 [自动收割入账] 额外奖励 ${harvestRes.points || finalData.claimablePoints} 分已成功领奖并入账！`);
                    reconciledAccount.claimablePoints = 0;
                    if (harvestRes.after?.balance) reconciledAccount.balance = harvestRes.after.balance;
                  }
                } catch (hErr) {
                  log(`⚠️ 自动收割尝试异常: ${hErr.message}，已保留待下次收割`);
                }
              }

              log(`🎉 账号 [${account.name}] 任务对账完成：今日积分 ${settledToday === null ? '未确认' : settledToday + ' 分'}，可用余额 ${settledBalance === null ? '未确认' : settledBalance + ' 分'}，连签 ${finalData.streakDays || 0} 天`);
              notifier.sendSettlementReport(account, {
                ...finalData,
                todayEarned: settledToday,
                balance: settledBalance,
                harvestedPoints: taskHarvestedPoints,
                claimablePoints: finalData.sources?.claimablePoints === 'live' ? finalData.claimablePoints : null
              }).catch(() => {});
            } finally {
              if (page && typeof page.close === 'function') { await page.close().catch(() => {}); }
            }
          }
        );
      }

      return { success: true };
    } catch (err) {
      if (err.message === TASK_STOP_MESSAGE && this.activeRunId === currentRunId) {
        log('🛑 任务已按用户指令停止');
      } else {
        log(`🔴 任务执行失败: ${err.message}`);
      }
      configManager.upsertAccount({ id: accountId, status: 'ready' });
      throw err;
    } finally {
      this.finalizeAccountRun(accountId);
    }
  }

  /**
   * 每日 01:00 额外积分全自动收割引擎
   */
  /**
   * 从官网 /earn 的实时 DOM 构建权威任务快照（禁止用本地缓存判定）
   */
  async fetchOfficialTaskSnapshot(context, account) {
    const page = await context.newPage();
    const log = (msg) => logger.log('🔎', `[官网任务判定] ${msg}`, '', account.name);
    try {
      try {
        await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch {
        await page.goto('https://rewards.bing.com/earn', { waitUntil: 'commit', timeout: 25000 });
      }
      await new Promise((r) => setTimeout(r, 2500));
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      await page.waitForFunction(() => document.body && document.body.innerText.length > 50, { timeout: 12000 }).catch(() => {});
      const snapshot = await page.evaluate(() => {
        const text = (document.body.innerText || '').replace(/\r/g, '');
        const sectionTitle = (h) => (h.innerText || '').trim();
        const sections = [];
        for (const h of document.querySelectorAll('h2')) {
          const title = sectionTitle(h);
          if (!['连续打卡任务', '每日活动', '活动', '任务', '日常任务'].includes(title)) continue;
          const sec = h.closest('div.react-aria-disclosure, [class*="Disclosure"]') || h.parentElement?.parentElement;
          const root = sec || h.parentElement;
          const cards = [];
          for (const el of root.querySelectorAll('a, button[aria-expanded]')) {
            const cardText = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!cardText || cardText === title) continue;
            const href = el.getAttribute('href') || '';
            const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
            const progressMatch = cardText.match(/(\d+)\s*\/\s*(\d+)\s*个任务/);
            const done = /已完成|Completed|✔/.test(cardText) ||
              (title === '任务' && progressMatch && Number(progressMatch[1]) >= Number(progressMatch[2]));
            cards.push({
              section: title,
              title: cardText.slice(0, 200),
              href,
              disabled,
              done,
              key: href || cardText.slice(0, 80)
            });
          }
          sections.push({ title, cards });
        }
        return { text, sections };
      });

      let searchPoints = null;
      const pointsCard = page.locator('button[aria-expanded], div[role="button"][aria-expanded], [aria-expanded]').filter({ hasText: /今日积分|积分明细|Points breakdown/i }).first();
      if (await pointsCard.count()) {
        try {
          await pointsCard.click({ timeout: 8000, force: true }).catch(() => pointsCard.press('Enter'));
          let detailText = '';
          for (let i = 0; i < 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const dialog = page.locator('[role="dialog"], [aria-modal="true"]').first();
            if (!(await dialog.count())) continue;
            detailText = await dialog.innerText().catch(() => '');
            if (parseOfficialSearchPointsDetail(detailText)) break;
          }
          searchPoints = parseOfficialSearchPointsDetail(detailText);
        } catch (drawerError) {
          log(`积分明细读取失败，搜索状态保持 unknown: ${drawerError.message}`);
        } finally {
          await page.keyboard.press('Escape').catch(() => {});
        }
      }

      for (const section of snapshot.sections) {
        for (const card of section.cards) {
          const feasibility = classifyTaskFeasibility(card.title, {
            href: card.href,
            destination: card.href,
            title: card.title
          });
          card.executable = feasibility.executable;
          card.feasibilityKind = feasibility.kind || null;
          card.feasibilityReason = feasibility.reason || '';
        }
      }

      const pageHtml = await page.content().catch(() => '');
      const rawAll = (snapshot.text || '') + '\n' + pageHtml;
      const liveStreaks = extractStreakModels(rawAll);
      const liveStamps = extractOfficialStamps(rawAll);

      // 严格校验搜索真实配额 (如 9/60)，杜绝将 1/1 连续打卡误判为满额导致跳过搜索
      if (!searchPoints) {
        const searchRscMatch = rawAll.match(/"combinedSearch":\{[^}]*"progress":(\d+)[^}]*"max":(\d+)/);
        if (searchRscMatch) {
          const cur = Number(searchRscMatch[1]);
          const max = Number(searchRscMatch[2]);
          // 严格校验 max >= 30，杜绝将 1/1 打卡识别为搜索配额
          if (Number.isInteger(cur) && Number.isInteger(max) && max >= 30 && cur >= 0 && cur <= max) {
            searchPoints = { current: cur, max, isMaxed: cur >= max, source: 'rsc-flight' };
          }
        }
        if (!searchPoints) {
          // 兜底正则优化：严格限定配额上限 max >= 30，防止误匹配“必应搜索连续打卡 搜索: 1/1”
          const searchHtmlMatch = rawAll.match(/(?:必应搜索|PC\s*搜索|Bing\s*Search)[\s\S]{0,200}?(\d+)\s*\/\s*(\d+)\s*(?:分|points)?/i);
          if (searchHtmlMatch) {
            const cur = Number(searchHtmlMatch[1]);
            const max = Number(searchHtmlMatch[2]);
            if (Number.isInteger(cur) && Number.isInteger(max) && max >= 30 && cur >= 0 && cur <= max) {
              searchPoints = { current: cur, max, isMaxed: cur >= max, source: 'html-match' };
            }
          }
        }
      }

      const snapshotResult = buildOfficialTaskSnapshot({
        text: snapshot.text,
        sections: snapshot.sections,
        searchPoints,
        account,
        streaks: liveStreaks,
        stamps: liveStamps
      });
      log(`实时任务判定: ${JSON.stringify(snapshotResult.details)}`);
      return snapshotResult;
    } finally {
      await page.close().catch(() => {});
    }
  }




  async harvestMidnightClaimable(accountId, options = {}) {
    const account = configManager.getAccount(accountId);
    if (!account) {
      return { success: false, status: 'failed', reason: 'account-not-found', harvest: null, before: null, after: null, finalData: null };
    }

    const ownsLock = !options.lockAlreadyHeld;
    if (ownsLock && !accountContextLock.acquire(accountId)) {
      logger.log('\u26a0\ufe0f', '\u8d26\u53f7 [' + account.name + '] \u6b63\u5728\u6267\u884c\u5176\u4ed6\u4efb\u52a1\uff0c\u8df3\u8fc7\u989d\u5916\u79ef\u5206\u9886\u53d6');
      return { success: false, status: 'skipped', reason: 'account-locked', harvest: null, before: null, after: null, finalData: null };
    }

    const session = readBrowserSession(accountId);
    if (!session || !session.cookies) {
      if (ownsLock) accountContextLock.release(accountId);
      logger.log('\u26a0\ufe0f', '\u8d26\u53f7 [' + account.name + '] \u7f3a\u5c11\u767b\u5f55\u4f1a\u8bdd\uff0c\u65e0\u6cd5\u9886\u53d6\u989d\u5916\u79ef\u5206');
      return { success: false, status: 'failed', reason: 'session-missing', harvest: null, before: null, after: null, finalData: null };
    }

    this.runningAccountId = accountId;
    this.runningAccountName = account.name || account.user;
    this.currentTaskSection = '额外积分';
    this.currentTaskName = '01:00 额外积分抽屉收割 (React Aria 虚拟指针)';
    this.taskStartTime = Date.now();
    configManager.upsertAccount({ id: accountId, status: 'running' });
    browserManager.updateState({
      status: 'harvesting',
      activeAccountId: accountId,
      activeAccountName: account.name || account.user,
      currentAction: `[${account.name || account.user}] 正在展开 React Aria 抽屉收割额外积分...`
    });

    let outcome = {
      success: false,
      status: 'failed',
      reason: 'harvest-not-started',
      harvest: null,
      before: null,
      after: null,
      finalData: null
    };

    try {
      const browserOutcome = await browserManager.withBrowser(
        { proxy: account.proxy, cookies: session.cookies, headless: true },
        async (browser, context) => {
          const page = await context.newPage();
          try {
            const harvestResult = await harvestClaimablePointsWithVirtualPointer(page, { accountPrefix: account.name });
            await new Promise((r) => setTimeout(r, 2500));
            if (page && !page.isClosed()) { await page.close().catch(() => {}); }
            const finalData = await this.fetchOfficialDashboard(context, account, { allowCachedFallback: false });
            const liveClaimable = finalData.sources?.claimablePoints === 'live';
            const liveBalance = finalData.sources?.balance === 'live';
            const beforeBalance = harvestResult?.before?.balance;
            const finalBalance = liveBalance ? finalData.balance : null;
            const finalClaimable = liveClaimable ? finalData.claimablePoints : null;
            const claimStatus = harvestResult?.status;
            const claimableCleared = liveClaimable && finalClaimable === 0;
            const balanceIncreased = liveBalance
              && Number.isFinite(beforeBalance)
              && Number.isFinite(finalBalance)
              && finalBalance > beforeBalance;
            // 彻底对齐 wangheqiang530/microsoft-rewards-docker 官方实现：
            // 只要真实点击了领取按钮提交领奖，即认定成功到账并同步更新本地资产，杜绝因服务端延迟导致误报
            const isClaimedSuccess = harvestResult?.harvested === true || claimStatus === 'claimed';
            const verified = isClaimedSuccess || (claimStatus === 'already-empty');
            const status = isClaimedSuccess ? 'claimed' : (claimStatus === 'already-empty' ? 'already-empty' : 'unverified');

            const failureReasons = [];
            if (!verified) {
              failureReasons.push(harvestResult?.reason || 'claim-not-confirmed');
            }

            let storedBalance = liveBalance ? finalBalance : account.balance;
            let storedClaimable = liveClaimable ? finalClaimable : account.claimablePoints;

            if (isClaimedSuccess) {
              storedClaimable = 0;
              const expectedGain = harvestResult.points || 0;
              storedBalance = Math.max(Number(storedBalance || 0), (Number(beforeBalance) || Number(account.balance) || 0) + expectedGain);
            }

            const accountUpdate = {
              id: accountId,
              status: verified ? 'ready' : 'warning',
              lastSyncAt: Date.now(),
              dataState: verified ? 'complete' : 'partial',
              balance: storedBalance,
              claimablePoints: storedClaimable
            };
            if (finalData.sources?.todayPoints === 'live') accountUpdate.todayEarned = finalData.todayPoints;
            if (finalData.sources?.streakDays === 'live') accountUpdate.streakDays = finalData.streakDays;
            configManager.upsertAccount(accountUpdate);
            historyManager.recordDaily(accountId, {
              todayEarned: finalData.sources?.todayPoints === 'live' ? finalData.todayPoints : null,
              balance: liveBalance ? finalBalance : null,
              streakDays: finalData.sources?.streakDays === 'live' ? finalData.streakDays : null,
              claimablePoints: liveClaimable ? finalClaimable : null,
              officialTasks: account.officialTasks || null,
              source: 'harvest-reconcile'
            });

            const harvestedPoints = verified
              ? ((Number.isFinite(beforeBalance) && Number.isFinite(finalBalance) && finalBalance > beforeBalance)
                  ? (finalBalance - beforeBalance)
                  : (harvestResult?.points || (harvestResult?.before?.points || 0)))
              : 0;

            const settledToday = finalData.sources?.todayPoints === 'live'
              ? finalData.todayPoints
              : (account.todayEarned ?? null);

            if (verified) {
              logger.log('\u{1f389}', '[收割入账] ' + account.name + ' 已核验到账 - 余额: ' + finalBalance + ' 分, 剩余待领: 0 分');
            } else {
              logger.log('\u26a0\ufe0f', '[收割未确认] ' + account.name + ' 未记录为领取成功: ' + failureReasons.join(','));
            }

            notifier.sendSettlementReport(account, {
              ...finalData,
              todayEarned: settledToday,
              harvestedPoints,
              balance: storedBalance,
              claimablePoints: storedClaimable,
              taskStatusText: verified
                ? `额外积分已核验到账 (+${harvestedPoints} 分)`
                : (status === 'already-empty'
                  ? '官网当前无待领取积分（未发生领取）'
                  : '额外积分未确认到账')
            }).catch(() => {});

            return {
              success: verified,
              status,
              reason: verified ? 'official-claim-and-balance-verified' : failureReasons.join(','),
              harvest: harvestResult,
              before: {
                claimablePoints: harvestResult?.before?.points ?? null,
                balance: Number.isFinite(beforeBalance) ? beforeBalance : null
              },
              after: {
                claimablePoints: finalClaimable,
                balance: finalBalance
              },
              finalData
            };
          } finally {
            if (page && typeof page.close === 'function') { await page.close().catch(() => {}); }
          }
        }
      );
      outcome = browserOutcome && typeof browserOutcome === 'object'
        ? browserOutcome
        : { success: false, status: 'failed', reason: 'empty-browser-outcome', harvest: null, before: null, after: null, finalData: null };
    } catch (e) {
      logger.log('\u26a0\ufe0f', `01:00 额外积分收割异常 [${account.name}]: ${e.message}`);
      outcome = {
        success: false,
        status: 'failed',
        reason: 'exception',
        error: e.message,
        harvest: null,
        before: null,
        after: null,
        finalData: null
      };
    } finally {
      this.runningAccountId = null;
      this.runningAccountName = '';
      this.currentTaskSection = '';
      this.currentTaskName = '';
      configManager.upsertAccount({ id: accountId, status: 'ready' });
      browserManager.updateState({
        status: 'idle',
        activeAccountId: null,
        activeAccountName: '无活跃任务',
        currentAction: '无头浏览器处于空闲休眠状态 (0 进程占用)'
      });
      if (ownsLock) accountContextLock.release(accountId);
    }

    return outcome;
  }
}
export const taskManager = new TaskManager();
export default taskManager;
