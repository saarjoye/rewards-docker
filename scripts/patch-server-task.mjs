import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

const routeCode = `
  // 5. 灵活任务触发：支持多账号/单账号，全量任务/单项任务
  app.post('/api/tasks/run', async (req, res) => {
    try {
      const { accountScope = 'all', accountId, taskScope = 'all' } = req.body || {};

      if (accountScope === 'single') {
        if (!accountId) return res.status(400).json({ success: false, message: '必须指定执行的账号 ID' });
        const account = configManager.getAccount(accountId);
        if (!account) return res.status(404).json({ success: false, message: '账号不存在' });

        if (taskManager.isAccountRunning(accountId)) {
          return res.status(409).json({ success: false, message: '该账号已在执行中' });
        }

        taskManager.runAccountTasks(accountId, { taskScope }).catch((err) => {
          logger.log('🔴', \`单账号执行异常: \${err.message}\`);
        });

        return res.json({
          success: true,
          message: \`已启动账号 [\${account.name}] 的任务 (范围: \${taskScope})\`
        });
      } else {
        // 全量账号批量队列执行
        taskManager.runAllAccountsTasks({ taskScope }).catch((err) => {
          logger.log('🔴', \`全账号批量执行异常: \${err.message}\`);
        });

        return res.json({
          success: true,
          message: \`已在后台启动全部已启用账号的任务队列 (范围: \${taskScope})\`
        });
      }
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });
`;

if (!content.includes('/api/tasks/run')) {
  content = content.replace('  // 5. 立即执行全量任务流水线', routeCode + '\n  // 5. 立即执行全量任务流水线');
  fs.writeFileSync('src/web/server.js', content, 'utf8');
  console.log('server.js task route added');
} else {
  console.log('task route already exists');
}
