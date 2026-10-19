import cron from 'node-cron';
import configManager from './config.js';
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
        const accounts = configManager.getAccounts().filter((a) => a.enabled);
        for (const acc of accounts) {
          try {
            await taskManager.harvestMidnightClaimable(acc.id);
            // 账号间 15 秒物理隔离冷却
            await new Promise((r) => setTimeout(r, 15000));
          } catch (e) {
            logger.log('⚠️', `01:00 额外积分收割流程异常 [${acc.name}]: ${e.message}`);
          }
        }
      },
      { timezone: 'Asia/Shanghai' }
    );
    this.jobs.push(harvestJob);

    // 2. 拟人化错峰时段调度：在四个时间窗口内随机启动
    // 09:15, 13:20, 17:15, 21:10
    const scheduleSlots = ['15 9 * * *', '20 13 * * *', '15 17 * * *', '10 21 * * *'];
    for (const slot of scheduleSlots) {
      const job = cron.schedule(
        slot,
        async () => {
          const cfg = configManager.get().scheduler;
          if (!cfg || !cfg.enabled) return;

          // 随机浮动 0~30 分钟打散调度，防止规律性被检测
          const jitterMinutes = Math.floor(Math.random() * 30);
          logger.log('🎲', `错峰时段触发，加入 ${jitterMinutes} 分钟随机睡眠防关联...`);
          await new Promise((r) => setTimeout(r, jitterMinutes * 60 * 1000));

          const accounts = configManager.getAccounts().filter((a) => a.enabled);
          for (const acc of accounts) {
            try {
              await taskManager.runAccountTasks(acc.id);
              // 账号间物理隔离与随机冷却 (15~25 秒)
              const cooldown = 15000 + Math.random() * 10000;
              logger.log('❄️', `账号切换物理隔离冷却 ${Math.round(cooldown / 1000)} 秒...`);
              await new Promise((r) => setTimeout(r, cooldown));
            } catch (err) {
              logger.log('🔴', `调度任务异常 [${acc.name}]: ${err.message}`);
            }
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
