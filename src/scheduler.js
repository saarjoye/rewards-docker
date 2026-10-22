import cron from 'node-cron';
import configManager, { getTodayDateString } from './config.js';
import logger from './logger.js';
import taskManager from './core/taskManager.js';

class Scheduler {
  constructor() {
    this.jobs = [];
    this.running = false;
  }

  start() {
    logger.log('⏰', '后台拟人化错峰时段调度与每日 01:00 额外积分收割引擎已就绪');

    // 1. 每日 01:00 (Asia/Shanghai) 额外积分全自动收割引擎 (对标图 6 与 4.3 节)
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

    // 2. 拟人化 4 大错峰时间窗口 (09:15, 13:20, 17:15, 21:10)
    const slotDefinitions = [
      { id: '09:00-13:00', label: '早间时段 (09:00 - 13:00)', cron: '15 9 * * *', index: 0 },
      { id: '13:00-17:00', label: '午间时段 (13:00 - 17:00)', cron: '20 13 * * *', index: 1 },
      { id: '17:00-21:00', label: '晚间时段 (17:00 - 21:00)', cron: '15 17 * * *', index: 2 },
      { id: '21:00-01:00', label: '夜间时段 (21:00 - 01:00)', cron: '10 21 * * *', index: 3 }
    ];

    // 3. 每日未完成任务准点自动重试巡检（支持用户自定义时段，如 20:00，默认每天 20:00 准点触发）
    const cfg = configManager.get().scheduler;
    const retryTime = (cfg && cfg.remainingRetryTime) ? cfg.remainingRetryTime.trim() : '20:00';
    let retryCron = '0 20 * * *'; // 默认每天 20:00

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

    for (const slotDef of slotDefinitions) {
      const job = cron.schedule(
        slotDef.cron,
        async () => {
          const cfg = configManager.get().scheduler;
          if (!cfg || !cfg.enabled) return;

          // 随机浮动 0~30 分钟打散调度，防止规律性被检测
          const jitterMinutes = Math.floor(Math.random() * 30);
          logger.log('🎲', `[${slotDef.label}] 错峰时段触发，加入 ${jitterMinutes} 分钟拟人随机浮动延迟防关联...`);
          await new Promise((r) => setTimeout(r, jitterMinutes * 60 * 1000));

          const allAccounts = configManager.getAccounts().filter((a) => a.enabled);
          const todayStr = getTodayDateString();

          // 筛选本时段匹配的账号：
          // 1) 明确指定当前时段的账号：严格在指定时段触发
          // 2) 设为「智能错峰 (auto)」：在 4 大时段均自动轮巡未完成账号，已跑满则智能跳过，未跑满(如搜索中途冷冻未拿满)自动接力补满
          const targetAccounts = allAccounts.filter((acc, idx) => {
            if (acc.slot && acc.slot !== 'auto') {
              return acc.slot === slotDef.id;
            }
            // 智能错峰自动模式：
            const isToday = acc.todayDate === todayStr;
            const todayPts = isToday ? Number(acc.todayEarned || 0) : 0;
            const tasks = (isToday && acc.officialTasks && typeof acc.officialTasks === 'object') ? acc.officialTasks : null;
            // 若今日积分已达到 160 分以上且官网任务快照明确无待做项，则智能跳过，杜绝重复无效执行
            const isFullySatisfied = todayPts >= 160 && tasks && tasks.hasWork === false;
            if (isFullySatisfied) {
              logger.log('ℹ️', `[${acc.name || acc.user}] 今日官网积分与任务已全部达成 (+${todayPts} 分)，[${slotDef.label}] 智能跳过`);
              return false;
            }
            return true;
          });

          if (targetAccounts.length === 0) {
            logger.log('ℹ️', `[${slotDef.label}] 当前时段无待执行账号（其他账号已分配至其余错峰窗口）`);
            return;
          }

          logger.log('🚀', `[${slotDef.label}] 本时段启动执行，共 ${targetAccounts.length} 个账号待进入流水线`);

          taskManager.beginRun('错峰时段队列');
          taskManager.isQueueRunning = true;
          try {
            for (const acc of targetAccounts) {
              if (taskManager.shouldStop) break;
              try {
                await taskManager.runAccountTasks(acc.id, { preserveStopState: true });
                const cooldown = 15000 + Math.random() * 10000;
                logger.log('❄️', `账号切换物理隔离冷却 ${Math.round(cooldown / 1000)} 秒...`);
                if (!(await taskManager.waitUnlessStopped(cooldown))) break;
              } catch (err) {
                if (err.message !== '任务已被用户主动中断') {
                  logger.log('🔴', `调度任务异常 [${acc.name}]: ${err.message}`);
                }
              }
            }
          } finally {
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
   * 聚合全天 6 大定时时间窗口 (01:00 收割, 09:15 早间, 13:20 午间, 17:15 晚间, 20:00 补做, 21:10 夜间)
   */
  getNextScheduledTask() {
    const cfg = configManager.get()?.scheduler || {};
    if (!cfg.enabled) {
      return { enabled: false, text: '调度已暂停', next: null, targetTimestamp: null, allSlots: [] };
    }

    const retryTime = (cfg.remainingRetryTime && typeof cfg.remainingRetryTime === 'string') ? cfg.remainingRetryTime.trim() : '20:00';
    let retryHour = 20;
    let retryMin = 0;
    if (/^\d{1,2}:\d{1,2}$/.test(retryTime)) {
      const parts = retryTime.split(':').map(Number);
      if (parts[0] >= 0 && parts[0] <= 23 && parts[1] >= 0 && parts[1] <= 59) {
        retryHour = parts[0];
        retryMin = parts[1];
      }
    }

    const allSlots = [
      { id: 'harvest', name: '额外积分收割', time: '01:00', hour: 1, minute: 0, tag: '🌙 抽屉收割' },
      { id: 'slot-1', name: '早间错峰时段', time: '09:15', hour: 9, minute: 15, tag: '🌅 早间错峰' },
      { id: 'slot-2', name: '午间错峰时段', time: '13:20', hour: 13, minute: 20, tag: '☀️ 午间错峰' },
      { id: 'slot-3', name: '晚间错峰时段', time: '17:15', hour: 17, minute: 15, tag: '🌆 晚间错峰' },
      { id: 'retry', name: '剩余补做巡检', time: `${String(retryHour).padStart(2, '0')}:${String(retryMin).padStart(2, '0')}`, hour: retryHour, minute: retryMin, tag: '🎯 剩余补做' },
      { id: 'slot-4', name: '夜间错峰时段', time: '21:10', hour: 21, minute: 10, tag: '🌃 夜间错峰' }
    ];

    allSlots.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));

    const now = new Date();
    const shanghaiStr = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' });
    const localNow = new Date(shanghaiStr);
    const curYear = localNow.getFullYear();
    const curMonth = localNow.getMonth();
    const curDate = localNow.getDate();
    const curTotalSec = localNow.getHours() * 3600 + localNow.getMinutes() * 60 + localNow.getSeconds();

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
    const targetTimestamp = now.getTime() + diffSec * 1000;

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
  }
}

export const scheduler = new Scheduler();
export default scheduler;
