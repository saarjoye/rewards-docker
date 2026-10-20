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
  extractOfficialClaimablePoints,
  extractOfficialSearchPoints
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
    this.isQueueRunning = false;
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
      if (claimablePoints === null && account.claimablePoints !== undefined) {
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
      parsedCards,
      combinedRawText: (flightChunks || "") + "\n" + (earnHtml || "") + "\n" + (dashHtml || "")
    };
  }

  /**
   * 顺序执行全账号批量任务
   */
  async runAllAccountsTasks(options = {}) {
    this.isQueueRunning = true;
    const accounts = configManager.getAccounts().filter((a) => a.enabled);
    if (accounts.length === 0) throw new Error('未检测到已启用的托管账号');

    const taskScope = options.taskScope || 'all';
    try {
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
    this.isQueueRunning = false;
    return { success: true };
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
      try {
        this.currentTaskName = '\u989d\u5916\u79ef\u5206\u9886\u53d6\u4e0e\u5b98\u7f51\u5bf9\u8d26';
        return await this.harvestMidnightClaimable(accountId, { lockAlreadyHeld: true });
      } finally {
        this.runningAccountId = null;
        this.runningAccountName = '';
        this.currentTaskSection = '';
        this.currentTaskName = '';
        accountContextLock.release(accountId);
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

      if (this.shouldStop) throw new Error('任务已被用户主动中断');

      // 2. 移动端 DAPI 任务
      if (taskScope === 'all' || taskScope === 'remaining' || taskScope === 'appSign' || taskScope === 'newsRead') {
        const dapi = new DapiClient(account, tokens, (refreshedTokens) => {
          session.tokens = refreshedTokens;
          writeBrowserSession(accountId, session);
        });

        this.currentTaskSection = '移动端任务';
        if (taskScope === 'all' || taskScope === 'remaining' || taskScope === 'appSign') {
          this.currentTaskName = '必应移动应用连续签到 (DAPI直连)';
          await dapi.performAppCheckIn();
        }

        if (this.shouldStop) throw new Error('任务已被用户主动中断');

        if (taskScope === 'all' || taskScope === 'remaining' || taskScope === 'newsRead') {
          this.currentTaskName = '移动端新闻资讯阅读 (30 积分)';
          await dapi.performNewsReading(10);
        }
      }

      if (this.shouldStop) throw new Error('任务已被用户主动中断');

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
              log(`⚠️ 官网实时任务判定失败，将安全回退到完整执行: ${snapshotErr.message}`);
            }
            const initialData = await this.fetchOfficialDashboard(context, account);
            configManager.upsertAccount({
              id: accountId,
              balance: initialData.balance,
              todayEarned: initialData.todayPoints,
              streakDays: initialData.streakDays,
              claimablePoints: initialData.claimablePoints,
              lastSyncAt: Date.now(),
              dataState: 'complete'
            });
            historyManager.recordDaily(accountId, {
              todayEarned: initialData.todayPoints,
              balance: initialData.balance,
              streakDays: initialData.streakDays,
              claimablePoints: initialData.claimablePoints,
              officialTasks,
              source: 'official-sync'
            });

            let page = await context.newPage();

            try {
              // 官网任务快照已在上方获取。remaining 模式只执行官网明确未完成的项目。
              if (taskScope === 'remaining' && officialTasks) {
                log(`🎯 [官网实时判定] 剩余: 搜索=${officialTasks.needSearch ? '待做' : '已完成'}, App=${officialTasks.needAppSign ? '待做' : '已完成'}, DailySet=${officialTasks.needDailySet ? '待做' : '已完成'}, 日常任务=${officialTasks.needDailyActivities ? '待做' : '已完成'}, 打孔卡=${officialTasks.needQuests ? '待做' : '已完成'}`);
                if (!officialTasks.hasWork) {
                  log('✅ [剩余任务] 官网实时状态显示今日可执行任务已全部完成。');
                  const cleanData = await this.fetchOfficialDashboard(context, account);
                  configManager.upsertAccount({ id: accountId, status: 'ready', balance: cleanData.balance, todayEarned: cleanData.todayPoints, streakDays: cleanData.streakDays, claimablePoints: cleanData.claimablePoints, officialTasks, lastSyncAt: Date.now(), dataState: 'complete', lastRun: Date.now() });
                  historyManager.recordDaily(accountId, { todayEarned: cleanData.todayPoints, balance: cleanData.balance, streakDays: cleanData.streakDays, claimablePoints: cleanData.claimablePoints, officialTasks, source: 'official-sync' });
                  return;
                }
              }

              const runDailySet = taskScope === 'all' || taskScope === 'dailySet' || (taskScope === 'remaining' && officialTasks?.needDailySet);
              const runQuests = taskScope === 'all' || taskScope === 'quests' || (taskScope === 'remaining' && officialTasks?.needQuests);
              const runDailyActs = taskScope === 'all' || taskScope === 'puzzle' || taskScope === 'dailyActivities' || (taskScope === 'remaining' && officialTasks?.needDailyActivities);
              const runSearch = taskScope === 'all' || taskScope === 'search' || (taskScope === 'remaining' && officialTasks?.needSearch);

              if (runDailySet) {
                this.currentTaskSection = '板块 1: 连续打卡';
                this.currentTaskName = '每日活动集 (Daily Set 3/3 弹窗点击)';
                log('>>> 执行【板块 1: 连续打卡任务 (Streaks)】每日活动集 (Daily Set 3/3)...');
                await penetrateDailySetActivities(page, { accountPrefix: account.name });
              }
              if (this.shouldStop) throw new Error('任务已被用户主动中断');

              log('>>> 检查【板块 2: 升级活动 (Level Up)】(随日常打卡与搜索自动驱动累积)...');

              if (runQuests) {
                this.currentTaskSection = '板块 3: 打孔卡任务';
                this.currentTaskName = '多步任务打孔卡 (Punch Cards)';
                log('>>> 执行【板块 3: 任务 (Punch Cards / Quests)】多步打孔卡...');
                const pending = officialTasks?.questPending || [];
                const questHrefs = pending.length
                  ? pending.map((q) => q.href).filter(Boolean)
                  : await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/quest/"]')].map((a) => a.getAttribute('href')).filter(Boolean))]).catch(() => []);
                log(`检索到 ${questHrefs.length} 个待推进打孔卡任务`);
                for (const qUrl of questHrefs) {
                  if (this.shouldStop) break;
                  if (qUrl) await penetratePunchCardQuest(page, qUrl, { accountPrefix: account.name });
                }
              }
              if (this.shouldStop) throw new Error('任务已被用户主动中断');

              if (runDailyActs) {
                this.currentTaskSection = '板块 4: 日常任务';
                this.currentTaskName = '日常任务穿透打卡 (Daily Activities)';
                log('>>> 执行【板块 4: 日常任务 (Daily Activities)】日常活动与拼图全量穿透...');
                await penetrateDailyActivities(page, {
                  accountPrefix: account.name,
                  pendingKeys: officialTasks?.dailyPending?.map((x) => x.key || x.href || x.title) || null
                });
              }
              if (this.shouldStop) throw new Error('任务已被用户主动中断');

              let needsSearchSecondPass = false;
              if (runSearch) {
                this.currentTaskName = '必应 PC 拟人搜索收割 (跑满 60 分)';
                log('执行板块 1-核心: 必应 PC 拟人化搜索收割 (跑满 60 分)...');
                const fullCfg = configManager.get();
                const taskOpts = fullCfg.taskOptions || {};
                const searchCfg = fullCfg.searchSettings || {};
                const maxSearches = searchCfg.maxDailySearches || 30;
                const baseSec = Number(taskOpts.baseIntervalSec) || 18;
                const jitterSec = Number(taskOpts.randomJitterSec) || 6;
                const stagnationThreshold = Number(taskOpts.stagnationLimit) || 10;
                const stagnationGuard = new SearchStagnationGuard(stagnationThreshold, account.name);
                stagnationGuard.recordObservation(initialData.todayPoints);
                const initialSearchCap = officialTasks?.searchPoints || extractOfficialSearchPoints(initialData.combinedRawText);
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
                    await new Promise((r) => setTimeout(r, sleepSec * 1000));
                    if (i % 3 === 0 || i === maxSearches) {
                      const checkData = await this.fetchOfficialDashboard(context, account);
                      const midCap = extractOfficialSearchPoints(checkData.combinedRawText);
                      if (midCap?.isMaxed) { log(`🎉 [搜索达标] 已跑满 ${midCap.current}/${midCap.max} 分。`); break; }
                      const obs = stagnationGuard.recordObservation(checkData.todayPoints);
                      configManager.upsertAccount({ id: accountId, todayEarned: checkData.todayPoints, balance: checkData.balance });
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
              await new Promise((r) => setTimeout(r, 15000));

              let finalData = null;
              for (let round = 1; round <= 3; round++) {
                finalData = await this.fetchOfficialDashboard(context, account);
                finalData.officialTasks = officialTasks;
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
                lastRun: Date.now(),
                lastSyncAt: Date.now(),
                dataState: 'complete'
              });

              historyManager.recordDaily(accountId, {
                todayEarned: finalData.todayPoints,
                balance: finalData.balance,
                streakDays: finalData.streakDays,
                claimablePoints: finalData.claimablePoints,
                officialTasks: finalData.officialTasks || officialTasks || null,
                source: 'official-sync'
              });

              // 二次回眸：若此前搜索遭遇停滞，在所有板块结束后进行一次验证性补测
              if (needsSearchSecondPass && !this.shouldStop) {
                log('🔄 [二次回眸] 账号其他板块已执行完毕，返回检测搜索是否恢复涨分...');
                const retryWord = getRandomSearchWord();
                await performHumanizedSearch(page, retryWord, { accountPrefix: account.name, context }).catch(() => {});
                await new Promise((r) => setTimeout(r, 6000));
                const secondCheck = await this.fetchOfficialDashboard(context, account);
                if (secondCheck.todayPoints > finalData.todayPoints) {
                  log(`🎉 [二次回眸成功] 搜索已恢复涨分！最新今日积分: ${secondCheck.todayPoints} 分`);
                  finalData = secondCheck;
                } else {
                  log('🛑 [停滞终态判定] 第 2 轮返回补做依然无增量，判定今日该账号搜索已受限，安全收工！');
                }
              }

              log(`🎉 账号 [${account.name}] 任务执行完成！今日积分: ${finalData.todayPoints} 分, 可用余额: ${finalData.balance} 分, 连签: ${finalData.streakDays} 天`);
              notifier.sendSettlementReport(account, { ...finalData, taskStatusText: officialTasks?.hasWork ? '官网任务仍有未完成项，已执行剩余任务扫描' : '官网任务已全部完成' }).catch(() => {});
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
  /**
   * 从官网 /earn 的实时 DOM 构建权威任务快照（禁止用本地缓存判定）
   */
  async fetchOfficialTaskSnapshot(context, account) {
    const page = await context.newPage();
    const log = (msg) => logger.log('🔎', `[官网任务判定] ${msg}`, '', account.name);
    try {
      await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 35000 });
      await new Promise((r) => setTimeout(r, 3000));
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

      const lines = snapshot.text.split('\n').map((x) => x.trim());
      const counter = (re) => {
        for (const line of lines) {
          const m = line.match(re);
          if (m) return { current: Number(m[1]), max: Number(m[2]) };
        }
        return null;
      };
      const searchStreak = counter(/搜索:\s*(\d+)\s*\/\s*(\d+)/);
      const dailySet = counter(/活动:\s*(\d+)\s*\/\s*(\d+)/);
      const appCheckIn = counter(/签到:\s*(\d+)\s*\/\s*(\d+)/);

      const sections = snapshot.sections;
      const dailyCards = sections.find((x) => x.title === '日常任务')?.cards || [];
      const questCards = sections.find((x) => x.title === '任务')?.cards || [];
      const dailyPending = dailyCards.filter((c) => !c.done && !c.disabled);
      const questPending = questCards.filter((c) => !c.done && !c.disabled);

      const snapshotResult = {
        searchStreak,
        dailySet,
        appCheckIn,
        dailyPending,
        questPending,
        needSearch: false,
        needDailySet: !dailySet || dailySet.current < dailySet.max,
        needAppSign: !appCheckIn || appCheckIn.current < appCheckIn.max,
        needDailyActivities: dailyPending.length > 0,
        needQuests: questPending.length > 0,
        hasWork: false,
        details: {
          searchStreak,
          dailySet,
          appCheckIn,
          dailyPending: dailyPending.map((x) => x.title),
          questPending: questPending.map((x) => x.title)
        }
      };
      // PC 搜索是否满 60/60，必须从“积分明细”抽屉读取，而不是把连续打卡“搜索:1/1”误认为上限
      const pointsCard = page.locator('button').filter({ hasText: '今日积分' }).first();
      if (await pointsCard.count()) {
        const box = await pointsCard.boundingBox();
        if (box) {
          // React Aria 在无头 Chromium 下对普通 click 偶发不展开，使用完整按压事件链。
          await pointsCard.evaluate((el) => {
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
            }
          }).catch(() => {});
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
          // React Aria 抽屉存在异步渲染，不能只等固定 1.2 秒
          let detailText = '';
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 500));
            detailText = await page.evaluate(() => {
              const d = document.querySelector('[role="dialog"], [aria-modal="true"]');
              return d ? (d.innerText || '').replace(/\r/g, '') : '';
            });
            if (/必应搜索\s*[0-9]+\s*\/\s*[0-9]+/i.test(detailText)) break;
          }
          const m = detailText.match(/必应搜索\s*([0-9]+)\s*\/\s*([0-9]+)/i);
          if (m) {
            const current = Number(m[1]);
            const max = Number(m[2]);
            snapshotResult.searchPoints = { current, max, isMaxed: max > 0 && current >= max };
            snapshotResult.needSearch = !snapshotResult.searchPoints.isMaxed;
            snapshotResult.details.searchPoints = snapshotResult.searchPoints;
          }
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
      if (!snapshotResult.searchPoints) {
        // points drawer occasionally loads slower; retry with a fresh page before assuming search remains.
        snapshotResult.needSearch = true;
        snapshotResult.details.searchPoints = { unknown: true };
      }
      snapshotResult.hasWork = snapshotResult.needSearch || snapshotResult.needDailySet || snapshotResult.needAppSign || snapshotResult.needDailyActivities || snapshotResult.needQuests;
      log(`实时任务判定: ${JSON.stringify(snapshotResult.details)}`);
      return snapshotResult;
    } finally {
      await page.close().catch(() => {});
    }
  }

  async harvestMidnightClaimable(accountId, options = {}) {
    const account = configManager.getAccount(accountId);
    if (!account) return { success: false, reason: 'account-not-found' };

    const ownsLock = !options.lockAlreadyHeld;
    if (ownsLock && !accountContextLock.acquire(accountId)) {
      logger.log('\u26a0\ufe0f', '\u8d26\u53f7 [' + account.name + '] \u6b63\u5728\u6267\u884c\u5176\u4ed6\u4efb\u52a1\uff0c\u8df3\u8fc7\u989d\u5916\u79ef\u5206\u9886\u53d6');
      return { success: false, reason: 'account-locked' };
    }

    const session = readBrowserSession(accountId);
    if (!session || !session.cookies) {
      if (ownsLock) accountContextLock.release(accountId);
      logger.log('\u26a0\ufe0f', '\u8d26\u53f7 [' + account.name + '] \u7f3a\u5c11\u767b\u5f55\u4f1a\u8bdd\uff0c\u65e0\u6cd5\u9886\u53d6\u989d\u5916\u79ef\u5206');
      return { success: false, reason: 'session-missing' };
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
            const harvestResult = await harvestClaimablePointsWithVirtualPointer(page, { accountPrefix: account.name });
            const finalData = await this.fetchOfficialDashboard(context, account);
            const authoritativeClaimable = finalData.claimablePoints;
            const verifiedBalance = harvestResult?.after?.balance ?? finalData.balance;

            configManager.upsertAccount({
              id: accountId,
              status: harvestResult?.harvested || harvestResult?.reason === 'already-zero' ? 'ready' : 'warning',
              balance: verifiedBalance,
              claimablePoints: authoritativeClaimable,
              lastSyncAt: Date.now(),
              dataState: authoritativeClaimable === null ? 'partial' : 'complete'
            });
            historyManager.recordDaily(accountId, {
              todayEarned: finalData.todayPoints,
              balance: verifiedBalance,
              streakDays: finalData.streakDays,
              claimablePoints: authoritativeClaimable,
              source: 'harvest-reconcile'
            });

            if (harvestResult?.harvested) {
              logger.log('\u{1f389}', '[\u6536\u5272\u5165\u8d26] \u8d26\u53f7 [' + account.name + '] \u5df2\u6838\u9a8c\u5230\u8d26 - \u4f59\u989d: ' + verifiedBalance + ' \u5206, \u5269\u4f59\u5f85\u9886: ' + authoritativeClaimable + ' \u5206');
            } else {
              logger.log('\u26a0\ufe0f', '[\u6536\u5272\u672a\u786e\u8ba4] \u8d26\u53f7 [' + account.name + '] \u4f59\u989d: ' + verifiedBalance + ' \u5206, \u5b98\u7f51\u5f85\u9886: ' + (authoritativeClaimable ?? '\u672a\u6355\u83b7') + ' \u5206\u3002\u672a\u8bb0\u5f55\u4e3a\u9886\u53d6\u6210\u529f\u3002');
            }
            notifier.sendSettlementReport(account, {
              ...finalData,
              balance: verifiedBalance,
              claimablePoints: authoritativeClaimable,
              taskStatusText: harvestResult?.harvested ? '\u989d\u5916\u79ef\u5206\u5df2\u5230\u8d26' : '\u989d\u5916\u79ef\u5206\u672a\u786e\u8ba4\u5230\u8d26'
            }).catch(() => {});
            return { success: !!harvestResult?.harvested, harvest: harvestResult, finalData: { ...finalData, balance: verifiedBalance, claimablePoints: authoritativeClaimable } };
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
      if (ownsLock) accountContextLock.release(accountId);
    }
  }
}

export const taskManager = new TaskManager();
export default taskManager;
