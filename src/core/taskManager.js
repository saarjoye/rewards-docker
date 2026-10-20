import path from 'path';
import { DATA_DIR } from '../fsUtil.js';
﻿import configManager from '../config.js';
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
  getRandomSearchWord
} from '../browser/actions.js';
import { SearchStagnationGuard } from './searchStagnation.js';
import {
  extractOfficialTodayPoints,
  extractOfficialBalance,
  extractOfficialStreakDays,
  extractOfficialClaimablePoints
} from '../contracts/validator.js';
import { concatFlightChunks, extractOfferObjects } from '../contracts/flightParse.js';
import { buildUnifiedTaskBoard } from '../contracts/streaks.js';
import historyManager from './history.js';
import notifier from './notifier.js';

export class TaskManager {
  constructor() {
    this.runningAccountId = null;
    this.runningAccountName = '';
    this.currentTaskSection = '';
    this.currentTaskName = '';
    this.shouldStop = false;
  }

  isAccountRunning(accountId) {
    return this.runningAccountId === accountId;
  }

  /**
   * 用户主动中断/停止当前任务流水线
   */
  stopCurrentTask() {
    if (!this.runningAccountId) {
      return { stopped: false, message: '当前没有正在执行中的任务' };
    }

    const accName = this.runningAccountName || this.runningAccountId;
    this.shouldStop = true;
    logger.log('🛑', `收到用户主动中断指令，正在安全回收浏览器并释放账号 [${accName}] 上下文...`);

    // 强行关闭浏览器中断所有导航与等待
    if (browserManager.activeBrowser) {
      browserManager.close(browserManager.activeBrowser).catch(() => {});
    }

    return { stopped: true, accountName: accName, message: `已中断账号 [${accName}] 的自动化任务流水线` };
  }

  /**
   * 抓取官网权威数据看板
   */
  async fetchOfficialDashboard(context, account) {
    let page = await context.newPage();
    const log = (msg) => logger.log('📊', `[官网同步] ${msg}`, '', account.name);

    let todayPoints = null;
    let balance = null;
    let streakDays = 0;
    let claimablePoints = 0;
    let flightChunks = '';
    let earnHtml = '';
    let earnText = '';
    let dashHtml = '';
    let dashText = '';

    const safeGoto = async (url, name) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (page.isClosed()) {
            page = await context.newPage();
          }
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
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
          await new Promise((r) => setTimeout(r, 2000));
          earnHtml = await page.content();
          earnText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
          flightChunks = concatFlightChunks(earnHtml);

          todayPoints = extractOfficialTodayPoints(flightChunks, `${earnHtml}\n${earnText}`);
          streakDays = extractOfficialStreakDays(flightChunks, `${earnHtml}\n${earnText}`);
          balance = extractOfficialBalance(flightChunks, `${earnHtml}\n${earnText}`);

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
          await new Promise((r) => setTimeout(r, 2000));
          dashHtml = await page.content();
          dashText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
          const dashFlight = concatFlightChunks(dashHtml);
          const combinedDash = `${dashFlight}\n${dashHtml}\n${dashText}`;

          if (balance === null) {
            balance = extractOfficialBalance(dashFlight, combinedDash);
          }
          if (todayPoints === null) {
            todayPoints = extractOfficialTodayPoints(dashFlight, combinedDash);
          }
          if (!streakDays) {
            streakDays = extractOfficialStreakDays(dashFlight, combinedDash);
          }
          claimablePoints = extractOfficialClaimablePoints(dashFlight, combinedDash);

          try {
            const shotPath = path.join(DATA_DIR, 'latest_screencast.png');
            await page.screenshot({ path: shotPath }).catch(() => {});
          } catch {}
        }
      } catch (e) {
        log(`访问 /dashboard 异常: ${e.message}`);
      }

      // 绝不将已有历史数据清零！
      if (balance === null && account.balance !== undefined) {
        balance = account.balance;
      }
      if (todayPoints === null && account.todayEarned !== undefined) {
        todayPoints = account.todayEarned;
      }
      if (!streakDays && account.streakDays !== undefined) {
        streakDays = account.streakDays;
      }
      if (!claimablePoints && account.claimablePoints !== undefined) {
        claimablePoints = account.claimablePoints;
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

    return {
      todayPoints: todayPoints !== null ? todayPoints : 0,
      balance: balance !== null ? balance : 0,
      streakDays,
      claimablePoints,
      taskBoard,
      parsedCards
    };
  }

  /**
   * 顺序执行全账号批量任务
   */
  async runAllAccountsTasks(options = {}) {
    const accounts = configManager.getAccounts().filter((a) => a.enabled);
    if (accounts.length === 0) throw new Error('未检测到已启用的托管账号');

    const taskScope = options.taskScope || 'all';
    logger.log('🚀', `>>> 开始批量执行全账号队列流水线 (共 ${accounts.length} 户，任务范围: ${taskScope}) <<<`);

    for (let i = 0; i < accounts.length; i++) {
      if (this.shouldStop) {
        logger.log('🛑', '检测到中断指令，批量队列提前终止');
        break;
      }

      const acc = accounts[i];
      try {
        await this.runAccountTasks(acc.id, { taskScope });
      } catch (err) {
        logger.log('🔴', `账号 [${acc.name}] 流水线异常: ${err.message}`);
      }

      if (i < accounts.length - 1 && !this.shouldStop) {
        logger.log('❄️', '账号切换物理隔离冷却 15 秒...');
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
    logger.log('🎉', '>>> 批量全账号任务流水线执行完毕 <<<');
    return { success: true };
  }

  /**
   * 执行单账号全生命周期任务流水线
   */
  async runAccountTasks(accountId, options = {}) {
    const account = configManager.getAccount(accountId);
    if (!account) throw new Error(`找不到账号 ID: ${accountId}`);

    if (!accountContextLock.acquire(accountId)) {
      throw new Error(`账号 [${account.name}] 正在执行任务中，锁定互斥！`);
    }

    const taskScope = options.taskScope || 'all';
    this.runningAccountId = accountId;
    this.runningAccountName = account.name || account.user;
    this.shouldStop = false;
    this.currentTaskSection = '环境准备';
    this.currentTaskName = '正在准备执行环境...'; this.taskStartTime = Date.now();

    configManager.upsertAccount({ id: accountId, status: 'running' });
    const log = (msg) => logger.log('🚀', msg, '', account.name);

    log(`>>> 启动账号 [${account.name}] 自动化流水线 (范围: ${taskScope}) <<<`);

    if (taskScope === 'harvest') {
      this.currentTaskName = '01:00 额外积分抽屉收割';
      await this.harvestMidnightClaimable(accountId);
      this.runningAccountId = null;
      this.runningAccountName = '';
      this.currentTaskName = '';
      accountContextLock.release(accountId);
      return { success: true };
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

      if (this.shouldStop) throw new Error('任务已被用户主动中断');

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

        if (this.shouldStop) throw new Error('任务已被用户主动中断');

        if (taskScope === 'all' || taskScope === 'newsRead') {
          this.currentTaskName = '移动端新闻资讯阅读 (30 积分)';
          await dapi.performNewsReading(10);
        }
      }

      if (this.shouldStop) throw new Error('任务已被用户主动中断');

      // 3. PC 端任务
      const needBrowser = taskScope === 'all' || ['dailySet', 'search', 'puzzle', 'quests'].includes(taskScope);
      if (needBrowser) {
        this.currentTaskSection = '桌面端任务';
        await browserManager.withBrowser(
          { proxy: account.proxy, cookies, headless: true },
          async (browser, context) => {
            log('同步初始官网成效看板...');
            this.currentTaskName = '同步官网初始真实看板...';
            const initialData = await this.fetchOfficialDashboard(context, account);
            configManager.upsertAccount({
              id: accountId,
              balance: initialData.balance,
              todayEarned: initialData.todayPoints,
              streakDays: initialData.streakDays,
              claimablePoints: initialData.claimablePoints
            });

            let page = await context.newPage();

            try {
              // 【板块 1: 连续打卡任务 (Streaks)】
              if (taskScope === 'all' || taskScope === 'dailySet') {
                this.currentTaskSection = '板块 1: 连续打卡';
                this.currentTaskName = '每日活动集 (Daily Set 3/3 弹窗点击)';
                log('>>> 执行【板块 1: 连续打卡任务 (Streaks)】每日活动集 (Daily Set 3/3)...');
                await penetrateDailySetActivities(page, { accountPrefix: account.name });
              }

              if (this.shouldStop) throw new Error('任务已被用户主动中断');

              // 【板块 2: 升级活动 (Level Up)】随日常打卡与搜索自动达成
              log('>>> 检查【板块 2: 升级活动 (Level Up)】(随日常打卡与搜索自动驱动累积)...');

              // 【板块 3: 任务 (Punch Cards / Quests)】
              if (taskScope === 'all' || taskScope === 'quests') {
                this.currentTaskSection = '板块 3: 打孔卡任务';
                this.currentTaskName = '多步任务打孔卡 (Punch Cards)';
                log('>>> 执行【板块 3: 任务 (Punch Cards / Quests)】多步打孔卡...');
                const questCards = (initialData.parsedCards || []).filter(
                  (c) => c.isPunchCard || c.isQuest || (c.destination && c.destination.includes('/quest/'))
                );
                for (const q of questCards) {
                  if (this.shouldStop) break;
                  if (q.destination) {
                    await penetratePunchCardQuest(page, q.destination, { accountPrefix: account.name });
                  }
                }
              }

              if (this.shouldStop) throw new Error('任务已被用户主动中断');

              // 【板块 4: 日常任务 (Daily Activities)】(含 Veggie burgers, Fossil favorites, 完成此拼图等全量活动)
              if (taskScope === 'all' || taskScope === 'puzzle' || taskScope === 'dailyActivities') {
                this.currentTaskSection = '板块 4: 日常任务';
                this.currentTaskName = '日常任务穿透打卡 (Daily Activities)';
                log('>>> 执行【板块 4: 日常任务 (Daily Activities)】日常活动与拼图全量穿透...');
                await penetrateDailyActivities(page, { accountPrefix: account.name });
              }

              if (this.shouldStop) throw new Error('任务已被用户主动中断');

              // PC Search
              if (taskScope === 'all' || taskScope === 'search') {
                this.currentTaskName = '必应 PC 拟人搜索收割 (跑满 60 分)';
                log('执行板块 1-核心: 必应 PC 拟人化搜索收割 (跑满 60 分)...');

                const fullCfg = configManager.get();
                const taskOpts = fullCfg.taskOptions || {};
                const searchCfg = fullCfg.searchSettings || {};
                const maxSearches = searchCfg.maxDailySearches || 30;

                // 严格以用户在配置中心设定的节奏为准 (例如 18s + 6s，停滞 10 次)
                const baseSec = Number(taskOpts.baseIntervalSec) || 18;
                const jitterSec = Number(taskOpts.randomJitterSec) || 6;
                const stagnationThreshold = Number(taskOpts.stagnationLimit) || 10;

                const stagnationGuard = new SearchStagnationGuard(stagnationThreshold, account.name);
                stagnationGuard.recordObservation(initialData.todayPoints);

                for (let i = 1; i <= maxSearches; i++) {
                  if (this.shouldStop) {
                    log('检测到用户中断指令，退出搜索循环！');
                    break;
                  }
                  if (stagnationGuard.isTripped()) break;

                  const word = getRandomSearchWord();
                  this.currentTaskName = `必应 PC 搜索 (第 ${i}/${maxSearches} 轮: "${word}")`;
                  log(`正在执行第 ${i}/${maxSearches} 轮搜索: "${word}"...`);

                  browserManager.updateState({
                    status: 'typing',
                    activeAccountId: accountId,
                    activeAccountName: account.name || account.user,
                    currentKeyword: word,
                    searchRounds: `${i} / ${maxSearches}`,
                    nextIntervalSec: 0,
                    currentAction: `[${account.name || account.user}] 正在拟人键入并搜索: "${word}" (${i}/${maxSearches})`
                  });
                  let searchRes = null;
                  try {
                    searchRes = await performHumanizedSearch(page, word, { accountPrefix: account.name, context });
                    if (searchRes && typeof searchRes.goto === 'function') {
                      page = searchRes;
                    }
                  } catch (searchErr) {
                    log(`⚠️ 第 ${i}/${maxSearches} 轮搜索遭遇瞬态异常 (${searchErr.message})，自愈视口并继续下一轮...`);
                    try { if (page && typeof page.close === 'function') await page.close().catch(() => {}); } catch {}
                    try { page = await context.newPage(); } catch {}
                  }

                  // 精准拟人睡眠：基础秒数 + [0, 随机浮动秒数]，杜绝硬编码 168 秒
                  const sleepSec = baseSec + Math.random() * jitterSec;
                  log(`[风控防线] 拟人搜索间隔退避 ${sleepSec.toFixed(1)} 秒 (基础 ${baseSec}s + 浮动 ${jitterSec}s)...`);
                  
                  browserManager.updateState({
                    status: 'dwelling',
                    activeAccountId: accountId,
                    activeAccountName: account.name || account.user,
                    currentKeyword: word,
                    searchRounds: `${i} / ${maxSearches}`,
                    nextIntervalSec: Math.round(sleepSec),
                    currentAction: `[${account.name || account.user}] 风控退避拟人休眠 ${sleepSec.toFixed(1)}s，防频控冷冻...`
                  });

                  await new Promise((r) => setTimeout(r, sleepSec * 1000));

                  if (i % 3 === 0 || i === maxSearches) {
                    const checkData = await this.fetchOfficialDashboard(context, account);
                    const obs = stagnationGuard.recordObservation(checkData.todayPoints);
                    configManager.upsertAccount({
                      id: accountId,
                      todayEarned: checkData.todayPoints,
                      balance: checkData.balance
                    });
                    if (obs.tripped) break;
                  }
                }
              }

              // 最终结算与回验
              this.currentTaskName = '权威数据对账核验...';
              log('等待 15 秒让微软服务端遥测入账...');
              await new Promise((r) => setTimeout(r, 15000));

              let finalData = null;
              for (let round = 1; round <= 3; round++) {
                finalData = await this.fetchOfficialDashboard(context, account);
                if (finalData.todayPoints > (initialData.todayPoints || 0)) break;
                await new Promise((r) => setTimeout(r, 5000));
              }

              configManager.upsertAccount({
                id: accountId,
                status: 'ready',
                balance: finalData.balance,
                todayEarned: finalData.todayPoints,
                streakDays: finalData.streakDays,
                claimablePoints: finalData.claimablePoints,
                lastRun: Date.now()
              });

              historyManager.recordDaily(accountId, {
                todayEarned: finalData.todayPoints,
                balance: finalData.balance,
                streakDays: finalData.streakDays
              });

              log(`🎉 账号 [${account.name}] 任务执行完成！今日积分: ${finalData.todayPoints} 分, 可用余额: ${finalData.balance} 分, 连签: ${finalData.streakDays} 天`);
              notifier.sendSettlementReport(account, finalData).catch(() => {});
            } finally {
              if (page && typeof page.close === 'function') { await page.close().catch(() => {}); }
            }
          }
        );
      }

      return { success: true };
    } catch (err) {
      log(`🔴 任务执行失败: ${err.message}`);
      configManager.upsertAccount({ id: accountId, status: 'ready' });
      throw err;
    } finally {
      this.runningAccountId = null;
      this.runningAccountName = '';
      this.currentTaskSection = '';
      this.currentTaskName = '';
      this.shouldStop = false;
      accountContextLock.release(accountId);
    }
  }

  /**
   * 每日 01:00 额外积分全自动收割引擎
   */
  async harvestMidnightClaimable(accountId) {
    const account = configManager.getAccount(accountId);
    if (!account) return;

    if (!accountContextLock.acquire(accountId)) {
      logger.log('⚠️', `账号 [${account.name}] 正在执行其他任务，跳过 01:00 额外积分收割`);
      return;
    }

    const session = readBrowserSession(accountId);
    if (!session || !session.cookies) {
      accountContextLock.release(accountId);
      return;
    }

    // 全量上报当前运行状态与活动账号，驱动大盘、账号池变绿与无头监控
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

    try {
      await browserManager.withBrowser(
        { proxy: account.proxy, cookies: session.cookies, headless: true },
        async (browser, context) => {
          const page = await context.newPage();
          try {
            await harvestClaimablePointsWithVirtualPointer(page, { accountPrefix: account.name });
            const finalData = await this.fetchOfficialDashboard(context, account);
            
            // 实时将最新官方待领分值和余额安全深度合并回写
            configManager.upsertAccount({
              id: accountId,
              status: 'ready',
              balance: finalData.balance,
              claimablePoints: finalData.claimablePoints !== null ? finalData.claimablePoints : 0
            });
            logger.log('🎉', `[收割入账] 账号 [${account.name}] 权威对账完毕 - 可用余额: ${finalData.balance} 分, 待领额外积分已同步更新为: ${finalData.claimablePoints} 分`);
            notifier.sendSettlementReport(account, finalData).catch(() => {});
          } finally {
            if (page && typeof page.close === 'function') { await page.close().catch(() => {}); }
          }
        }
      );
    } catch (e) {
      logger.log('⚠️', `01:00 额外积分收割异常 [${account.name}]: ${e.message}`);
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
      accountContextLock.release(accountId);
    }
  }
}

export const taskManager = new TaskManager();
export default taskManager;
