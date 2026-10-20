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

    // 3. 用户自定义 Cron 自动定时巡检（若开启并配置了有效表达式）
    const cfg = configManager.get().scheduler;
    const customCron = (cfg && cfg.cron) ? cfg.cron.trim() : '*/25 * * * *';
    if (cron.validate(customCron)) {
      const inspectJob = cron.schedule(
        customCron,
        async () => {
          const currentCfg = configManager.get().scheduler;
          if (!currentCfg || !currentCfg.enabled) return;
          if (taskManager.isQueueRunning || taskManager.runningAccountId) {
            logger.log('ℹ️', '[定时自动巡检] 当前有任务正在执行中，跳过本次巡检');
            return;
          }
          logger.log('⏰', '>>> 触发后台自动定时巡检流水线 (模式: 补全剩余未完成任务) <<<');
          try {
            await taskManager.runAllAccountsTasks({ taskScope: 'remaining' });
          } catch (e) {
            logger.log('⚠️', `[定时自动巡检] 执行异常: ${e.message}`);
          }
        },
        { timezone: 'Asia/Shanghai' }
      );
      this.jobs.push(inspectJob);
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
          // 1) 明确指定当前时段的账号 (acc.slot === slotDef.id)
          // 2) 设为「智能错峰 (auto)」并按账号序列哈希轮转到本时段、或今日尚未跑满的账号
          const targetAccounts = allAccounts.filter((acc, idx) => {
            if (acc.slot && acc.slot === slotDef.id) return true;
            if (!acc.slot || acc.slot === 'auto') {
              // 自动模式：将账号均匀分配至 4 个时段，避免全部挤在同一时间
              return (idx % 4) === slotDef.index;
            }
            return false;
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
