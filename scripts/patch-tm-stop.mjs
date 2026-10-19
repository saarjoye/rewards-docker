import fs from 'fs';

let content = fs.readFileSync('src/core/taskManager.js', 'utf8');

// 1. 在 constructor 增加 shouldStop 与 currentTaskName
const oldCtor = `  constructor() {
    this.runningAccountId = null;
    this.currentTaskSection = '';
    this.currentTaskDetail = '';
  }`;

const newCtor = `  constructor() {
    this.runningAccountId = null;
    this.currentTaskSection = '';
    this.currentTaskName = '';
    this.shouldStop = false;
  }`;

content = content.replace(oldCtor, newCtor);

// 2. 增加 stopCurrentTask 方法
const stopMethod = `
  /**
   * 用户主动中断/停止当前正在执行的任务流水线
   */
  stopCurrentTask() {
    if (!this.runningAccountId) {
      return { stopped: false, message: '当前没有正在执行中的任务' };
    }

    const accId = this.runningAccountId;
    this.shouldStop = true;
    logger.log('🛑', \`收到用户主动中断指令，正在安全回收无头浏览器并释放账号 [\${accId}] 上下文...\`);

    // 立即强行关闭浏览器以中断所有网络与等待
    if (browserManager.activeBrowser) {
      browserManager.close(browserManager.activeBrowser).catch(() => {});
    }

    return { stopped: true, accountId: accId, message: '已成功发送中断指令，正在安全退出' };
  }
`;

if (!content.includes('stopCurrentTask()')) {
  content = content.replace('  isAccountRunning(accountId) {', stopMethod + '\n  isAccountRunning(accountId) {');
}

// 3. 在 runAccountTasks 开头重置 shouldStop
content = content.replace(
  'this.runningAccountId = accountId;',
  'this.runningAccountId = accountId;\n    this.shouldStop = false;\n    this.currentTaskName = "正在准备初始化环境...";'
);

// 4. 在搜索循环与子任务中插入 shouldStop 检查
const stopCheckSearch = `              if (this.shouldStop) {
                log('检测到用户中断指令，退出搜索循环！');
                break;
              }`;

content = content.replace(
  'if (stagnationGuard.isTripped()) {\n                break;\n              }',
  'if (stagnationGuard.isTripped()) {\n                break;\n              }\n' + stopCheckSearch
);

// 5. 更新各子任务名称跟踪
content = content.replace(
  'this.currentTaskSection = \'移动端任务 (Streaks+阅读)\';',
  'this.currentTaskSection = \'移动端任务\';\n      this.currentTaskName = \'必应移动应用连续签到 (DAPI直连)\';'
);

content = content.replace(
  '// (2) 新闻资讯阅读 (30 分)',
  'this.currentTaskName = \'移动端新闻资讯阅读 (30 分)\';\n      if (this.shouldStop) return { success: false, stopped: true };\n      // (2) 新闻资讯阅读 (30 分)'
);

content = content.replace(
  'log(\'执行板块 1: 每日活动集 (Daily Set) 真实弹窗点击与答题...\');',
  'this.currentTaskName = \'每日活动集 (Daily Set 3/3 弹窗点击)\';\n              if (this.shouldStop) throw new Error(\'任务已被用户主动中断\');\n              log(\'执行板块 1: 每日活动集 (Daily Set) 真实弹窗点击与答题...\');'
);

content = content.replace(
  'log(\'执行板块 1-核心: 必应 PC 拟人化搜索收割 (跑满 60 分)...');',
  'this.currentTaskName = \'必应 PC 拟人化搜索收割 (跑满 60 分)\';\n              if (this.shouldStop) throw new Error(\'任务已被用户主动中断\');\n              log(\'执行板块 1-核心: 必应 PC 拟人化搜索收割 (跑满 60 分)...');'
);

// 6. 在 finally 块中复位
content = content.replace(
  'this.runningAccountId = null;\n      this.currentTaskSection = \'\';',
  'this.runningAccountId = null;\n      this.currentTaskSection = \'\';\n      this.currentTaskName = \'\';\n      this.shouldStop = false;'
);

fs.writeFileSync('src/core/taskManager.js', content, 'utf8');
console.log('taskManager.js updated with stop & task name tracking');
