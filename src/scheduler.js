import cron from 'node-cron';
import configManager, { getTodayDateString } from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';

class Scheduler {
  constructor() {
    this.jobs = [];
    this.running = false;
    // 正在错峰等待中的账号与目标启动时间戳
    this.staggerState = {
      isWaiting: false,
      accountId: null,
      accountName: '',
      targetTimestamp: null,
      slotLabel: ''
    };
  }

  start() {
    logger.log('⏰', '后台拟人化准点错峰调度与每日 01:00 额外积分收割引擎已就绪');

    // 1. 每日 01:00 额外积分全自动收割引擎
    const harvestJob = cron.schedule(
      '0 1 * * *',
      async () => {
        logger.log('🌙', '>>> 触发每日 01:00 额外积分全自动收割与对账闭环引擎 <<<');
        taskManager.beginRun('01:00 额外积分收割队列');
        taskManager.isQueueRunning = true;
        try {
          const accounts = configManager.getAccounts().filter((a) => a.enabled);
          for (const acc of accounts) {
            try {
              await taskManager.harvestMidnightClaimable(acc.id);
              if (!(await taskManager.waitUnlessStopped(15000))) break;
            } catch (e) {
              logger.log('⚠️', `01:00 额外积分收割流程异常 [${acc.name}]: ${e.message}`);
            }
          }
        } finally {
          taskManager.isQueueRunning = false;
        }
      },
      { timezone: 'Asia/Shanghai' }
    );
    this.jobs.push(harvestJob);

    // 2. 规定的 4 大错峰时间窗口 (09:00, 13:00, 17:00, 21:00 准点启动，绝不在时段开头盲目等待)
    const slotDefinitions = [
      { id: '09:00-13:00', label: '早间时段 (09:00 - 13:00)', cron: '0 9 * * *', time: '09:00', hour: 9, minute: 0, tag: '🌅 早间错峰' },
      { id: '13:00-17:00', label: '午间时段 (13:00 - 17:00)', cron: '0 13 * * *', time: '13:00', hour: 13, minute: 0, tag: '☀️ 午间错峰' },
      { id: '17:00-21:00', label: '晚间时段 (17:00 - 21:00)', cron: '0 17 * * *', time: '17:00', hour: 17, minute: 0, tag: '🌆 晚间错峰' },
      { id: '21:00-01:00', label: '夜间时段 (21:00 - 01:00)', cron: '0 21 * * *', time: '21:00', hour: 21, minute: 0, tag: '🌃 夜间错峰' }
    ];

    // 3. 每日未完成任务准点补做巡检 (默认 20:00)
    const cfg = configManager.get().scheduler;
    const retryTime = (cfg && cfg.remainingRetryTime) ? cfg.remainingRetryTime.trim() : '20:00';
    let retryCron = '0 20 * * *';

    if (/^\d{1,2}:\d{1,2}$/.test(retryTime)) {
      const [h, m] = retryTime.split(':').map(Number);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        retryCron = `${m} ${h} * * *`;
      }
    } else if (cron.validate(retryTime)) {
      retryCron = retryTime;
    }

    if (cron.validate(retryCron)) {
      logger.log('⏰', `未完成任务每日自动补做时段已设定: 每天 ${retryTime} 准点启动 (Cron: ${retryCron})`);
      const retryJob = cron.schedule(
        retryCron,
        async () => {
          const currentCfg = configManager.get().scheduler;
          if (!currentCfg || !currentCfg.enabled) return;

          const configuredMax = currentCfg.maxRemainingRetries !== undefined
            ? Number(currentCfg.maxRemainingRetries)
            : 2;
          if (configuredMax === 0) {
            logger.log('🛑', '[未完成任务准点补做] 重试次数配置为 0，跳过今日自动补做。');
            return;
          }

          if (taskManager.isQueueRunning || taskManager.runningAccountId) {
            logger.log('ℹ️', '[未完成任务准点补做] 当前有任务正在执行中，将在 5 分钟后自动重试触发');
            setTimeout(() => {
              if (!taskManager.isQueueRunning && !taskManager.runningAccountId) {
                taskManager.runAllAccountsTasks({ taskScope: 'remaining' }).catch(() => {});
              }
            }, 5 * 60 * 1000);
            return;
          }

          logger.log('⏰', `>>> 到达每日 ${retryTime} 未完成任务自动补做窗口，启动全账号剩余任务扫描流水线 <<<`);
          try {
            await taskManager.runAllAccountsTasks({ taskScope: 'remaining' });
          } catch (e) {
            logger.log('⚠️', `[未完成任务准点补做] 执行异常: ${e.message}`);
          }
        },
        { timezone: 'Asia/Shanghai' }
      );
      this.jobs.push(retryJob);
    }

    // 4. 注册 4 大错峰时段调度：准点触发，账号间平缓错开
    for (const slotDef of slotDefinitions) {
      const job = cron.schedule(
        slotDef.cron,
        async () => {
          const currentCfg = configManager.get().scheduler;
          if (!currentCfg || !currentCfg.enabled) return;

          const allAccounts = configManager.getAccounts().filter((a) => a.enabled);
          const todayStr = getTodayDateString();

          // 筛选本时段目标账号：
          // 1) 明确指定本时段的账号；
          // 2) 智能错峰 (auto)：全天 4 大时段轮巡，未拿满的账号按序推进
          const targetAccounts = allAccounts.filter((acc) => {
            if (acc.slot && acc.slot !== 'auto') {
              return acc.slot === slotDef.id;
            }
            const isToday = acc.todayDate === todayStr;
            const todayPts = isToday ? Number(acc.todayEarned || 0) : 0;
            const tasks = (isToday && acc.officialTasks && typeof acc.officialTasks === 'object') ? acc.officialTasks : null;
            // 今日积分达到 160 以上且官网快照明确无待做项，则跳过
            const isFullySatisfied = todayPts >= 160 && tasks && tasks.hasWork === false;
            if (isFullySatisfied) {
              logger.log('ℹ️', `[${acc.name || acc.user}] 今日官网积分与任务已全部达成 (+${todayPts} 分)，[${slotDef.label}] 智能跳过`);
              return false;
            }
            return true;
          });

          if (targetAccounts.length === 0) {
            logger.log('ℹ️', `[${slotDef.label}] 准点触发，当前时段无待执行账号（所有账号今日已拿满或未启用）`);
            return;
          }

          logger.log('🚀', `>>> [${slotDef.label}] 准点启动！共 ${targetAccounts.length} 个账号进入错峰流水线 <<<`);

          taskManager.beginRun(`错峰时段 [${slotDef.time}]`);
          taskManager.isQueueRunning = true;
          try {
            for (let i = 0; i < targetAccounts.length; i++) {
              if (taskManager.shouldStop) break;
              const acc = targetAccounts[i];

              // 清理错峰等待状态
              this.staggerState.isWaiting = false;
              this.staggerState.accountId = null;

              try {
                logger.log('🚀', `[${slotDef.label}] [${i + 1}/${targetAccounts.length}] 启动账号 [${acc.name}] 自动化作业`);
                await taskManager.runAccountTasks(acc.id, { preserveStopState: true });
              } catch (err) {
                if (err.message !== '任务已被用户主动中断') {
                  logger.log('🔴', `调度任务异常 [${acc.name}]: ${err.message}`);
                }
              }

              // 核心机制：账号间拟人化错开！(仅在还有下一个账号时进行平缓错开)
              if (i < targetAccounts.length - 1 && !taskManager.shouldStop) {
                const nextAcc = targetAccounts[i + 1];
                // 账号间错开 3 ~ 6 分钟随机浮动 (180 ~ 360 秒)，彻底模拟多人在不同时刻真实上网作息
                const staggerSec = 180 + Math.floor(Math.random() * 180);
                const targetTimestamp = Date.now() + staggerSec * 1000;
                const estDate = new Date(targetTimestamp);
                const estTimeStr = `${String(estDate.getHours()).padStart(2, '0')}:${String(estDate.getMinutes()).padStart(2, '0')}`;

                this.staggerState = {
                  isWaiting: true,
                  accountId: nextAcc.id,
                  accountName: nextAcc.name,
                  targetTimestamp,
                  slotLabel: slotDef.label
                };

                logger.log('☕', `账号 [${acc.name}] 完成作业，账号间拟人化错开 ${Math.round(staggerSec / 60)} 分钟；下一个账号 [${nextAcc.name}] 预计在 ${estTimeStr} 启动接力...`);

                const waited = await taskManager.waitUnlessStopped(staggerSec * 1000);
                this.staggerState.isWaiting = false;
                if (!waited) break;
              }
            }
          } finally {
            this.staggerState.isWaiting = false;
            taskManager.isQueueRunning = false;
          }
        },
        { timezone: 'Asia/Shanghai' }
      );
      this.jobs.push(job);
    }

    this.running = true;
  }

  /**
   * 计算距离下一次定时调度任务的最近执行时段与精确倒计时
   * 严密保证：当处于批次内账号间错开等待时，直接展示下一个接力账号与接力倒计时，绝不盲目跳到数小时后的下一个大时段！
   */
  getNextScheduledTask() {
    const cfg = configManager.get()?.scheduler || {};
    if (!cfg.enabled) {
      return { enabled: false, text: '调度已暂停', next: null, targetTimestamp: null, allSlots: [] };
    }

    const now = new Date();
    const shanghaiStr = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' });
    const localNow = new Date(shanghaiStr);
    const curYear = localNow.getFullYear();
    const curMonth = localNow.getMonth();
    const curDate = localNow.getDate();
    const curTotalSec = localNow.getHours() * 3600 + localNow.getMinutes() * 60 + localNow.getSeconds();

    // 1. 如果当前流水线正在执行，或正在账号间拟人化错开等待中：
    // 优先返回当前错开批次中的下一个接力账号与接力时刻！
    if (this.staggerState.isWaiting && this.staggerState.targetTimestamp > Date.now()) {
      const diffSec = Math.max(0, Math.round((this.staggerState.targetTimestamp - Date.now()) / 1000));
      const estDate = new Date(this.staggerState.targetTimestamp);
      const estTime = `${String(estDate.getHours()).padStart(2, '0')}:${String(estDate.getMinutes()).padStart(2, '0')}`;
      return {
        enabled: true,
        isStaggerWaiting: true,
        name: '账号错开接力',
        tag: '☕ 错开接力',
        time: estTime,
        targetAccountName: this.staggerState.accountName,
        targetTimestamp: this.staggerState.targetTimestamp,
        diffSec,
        isTomorrow: false
      };
    }

    // 2. 正常状态：计算下一个准点触发的时段 (01:00 额外收割, 09:00 早间, 13:00 午间, 17:00 晚间, 20:00 补做, 21:00 夜间)
    const retryTime = (cfg.remainingRetryTime && typeof cfg.remainingRetryTime === 'string') ? cfg.remainingRetryTime.trim() : '20:00';
    let retryHour = 20, retryMin = 0;
    if (/^\d{1,2}:\d{1,2}$/.test(retryTime)) {
      const parts = retryTime.split(':').map(Number);
      if (parts[0] >= 0 && parts[0] <= 23 && parts[1] >= 0 && parts[1] <= 59) {
        retryHour = parts[0];
        retryMin = parts[1];
      }
    }

    const allSlots = [
      { id: 'harvest', name: '额外积分收割', time: '01:00', hour: 1, minute: 0, tag: '🌙 抽屉收割' },
      { id: 'slot-1', name: '早间错峰时段', time: '09:00', hour: 9, minute: 0, tag: '🌅 早间错峰' },
      { id: 'slot-2', name: '午间错峰时段', time: '13:00', hour: 13, minute: 0, tag: '☀️ 午间错峰' },
      { id: 'slot-3', name: '晚间错峰时段', time: '17:00', hour: 17, minute: 0, tag: '🌆 晚间错峰' },
      { id: 'retry', name: '剩余补做巡检', time: `${String(retryHour).padStart(2, '0')}:${String(retryMin).padStart(2, '0')}`, hour: retryHour, minute: retryMin, tag: '🎯 剩余补做' },
      { id: 'slot-4', name: '夜间错峰时段', time: '21:00', hour: 21, minute: 0, tag: '🌃 夜间错峰' }
    ];

    allSlots.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));

    let nextSlot = null;
    let targetTime = null;
    let isTomorrow = false;

    for (const slot of allSlots) {
      const slotTotalSec = slot.hour * 3600 + slot.minute * 60;
      if (slotTotalSec > curTotalSec) {
        nextSlot = slot;
        targetTime = new Date(curYear, curMonth, curDate, slot.hour, slot.minute, 0);
        break;
      }
    }

    if (!nextSlot) {
      nextSlot = allSlots[0];
      targetTime = new Date(curYear, curMonth, curDate + 1, nextSlot.hour, nextSlot.minute, 0);
      isTomorrow = true;
    }

    const diffSec = Math.max(0, Math.round((targetTime.getTime() - localNow.getTime()) / 1000));
    const targetTimestamp = Date.now() + diffSec * 1000;

    return {
      enabled: true,
      name: nextSlot.name,
      tag: nextSlot.tag,
      time: nextSlot.time,
      isTomorrow,
      targetTimestamp,
      diffSec,
      allSlots: allSlots.map((s) => ({ name: s.name, time: s.time, tag: s.tag }))
    };
  }

  stop() {
    for (const j of this.jobs) {
      try { j.stop(); } catch {}
    }
    this.jobs = [];
    this.running = false;
    this.staggerState.isWaiting = false;
  }
}

export const scheduler = new Scheduler();
export default scheduler;
