import fs from 'fs';

let content = fs.readFileSync('src/core/taskManager.js', 'utf8');

// 在 runAccountTasks 中支持 taskScope 参数
const oldRunHead = 'async runAccountTasks(accountId) {';
const newRunHead = 'async runAccountTasks(accountId, options = {}) {\n    const taskScope = options.taskScope || "all"; // "all" | "search" | "dailySet" | "appSign" | "newsRead" | "puzzle" | "quests" | "harvest"';

content = content.replace(oldRunHead, newRunHead);

// 支持 harvest scope 直接重定向到收割
const harvestRedirect = `    if (taskScope === "harvest") {
      log('执行目标：[单任务] 仅执行额外积分抽屉收割');
      await this.harvestMidnightClaimable(accountId);
      this.runningAccountId = null;
      accountContextLock.release(accountId);
      return { success: true };
    }`;

content = content.replace(
  "log(`>>> 启动账号 [${account.name}] 全自动化流水线 <<<`);",
  "log(`>>> 启动账号 [\${account.name}] 自动化任务流水线 (范围: \${taskScope}) <<<`);\n" + harvestRedirect
);

// 条件执行 DAPI App 签到
content = content.replace(
  "// (1) 必应 App 签到 (Streaks: 签到: 1/1)\n      await dapi.performAppCheckIn();",
  `if (taskScope === "all" || taskScope === "appSign") {
        await dapi.performAppCheckIn();
      }`
);

// 条件执行 DAPI 新闻阅读
content = content.replace(
  "// (2) 新闻资讯阅读 (30 分)\n      await dapi.performNewsReading(10);",
  `if (taskScope === "all" || taskScope === "newsRead") {
        await dapi.performNewsReading(10);
      }`
);

// 条件执行 Daily Set
content = content.replace(
  "log('执行板块 1: 每日活动集 (Daily Set) 真实弹窗点击与答题...');\n            await penetrateDailySetActivities(page, { accountPrefix: account.name });",
  `if (taskScope === "all" || taskScope === "dailySet") {
              log('执行板块 1: 每日活动集 (Daily Set) 真实弹窗点击与答题...');
              await penetrateDailySetActivities(page, { accountPrefix: account.name });
            }`
);

// 条件执行 Quests
content = content.replace(
  "log('执行板块 3: 检查并推进多步打孔卡任务...');",
  `if (taskScope === "all" || taskScope === "quests") {
              log('执行板块 3: 检查并推进多步打孔卡任务...');`
);
content = content.replace(
  "            }\n\n            // (3) 板块 4: 日常任务",
  `            }
            }

            // (3) 板块 4: 日常任务`
);

// 条件执行 Puzzle
content = content.replace(
  "log('执行板块 4: 检查并推进日常拼图与热点探索...');",
  `if (taskScope === "all" || taskScope === "puzzle") {
              log('执行板块 4: 检查并推进日常拼图与热点探索...');`
);
content = content.replace(
  "            }\n\n            // (4) 必应 PC 拟人化搜索",
  `            }
            }

            // (4) 必应 PC 拟人化搜索`
);

// 条件执行 PC Search
content = content.replace(
  "log('执行板块 1-核心: 必应 PC 拟人化搜索收割 (跑满 60 分)...');",
  `if (taskScope === "all" || taskScope === "search") {
              log('执行板块 1-核心: 必应 PC 拟人化搜索收割 (跑满 60 分)...');`
);
content = content.replace(
  "            }\n\n            // (5) 最终权威数据结算",
  `            }
            }

            // (5) 最终权威数据结算`
);

// 增加 runAllAccountsTasks 方法
const allAccountsMethod = `
  /**
   * 批量顺序执行全部已启用账号的任务 (支持指定 taskScope，账号间带 15 秒物理隔离冷却)
   */
  async runAllAccountsTasks(options = {}) {
    const accounts = configManager.getAccounts().filter((a) => a.enabled);
    if (accounts.length === 0) {
      throw new Error('未检测到已启用的托管账号');
    }

    const taskScope = options.taskScope || 'all';
    logger.log('🚀', \`>>> 开始批量执行全账号队列流水线 (共 \${accounts.length} 户，任务范围: \${taskScope}) <<<\`);

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      try {
        await this.runAccountTasks(acc.id, { taskScope });
      } catch (err) {
        logger.log('🔴', \`账号 [\${acc.name}] 流水线异常: \${err.message}\`);
      }

      if (i < accounts.length - 1) {
        logger.log('❄️', '账号切换物理隔离冷却 15 秒...');
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
    logger.log('🎉', '>>> 批量全账号任务流水线执行完毕 <<<');
    return { success: true, count: accounts.length };
  }
`;

if (!content.includes('runAllAccountsTasks')) {
  content = content.replace('  async harvestMidnightClaimable(accountId) {', allAccountsMethod + '\n  async harvestMidnightClaimable(accountId) {');
}

fs.writeFileSync('src/core/taskManager.js', content, 'utf8');
console.log('taskManager.js updated with granular task scopes');
