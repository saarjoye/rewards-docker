import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

// 1. 在 GET /api/status 返回 runningAccountName 与 currentTaskName
content = content.replace(
  'runningAccountId: taskManager.runningAccountId,\n      currentTaskSection: taskManager.currentTaskSection,',
  `isBusy: !!taskManager.runningAccountId,
      runningAccountId: taskManager.runningAccountId,
      runningAccountName: taskManager.runningAccountName || '',
      currentTaskSection: taskManager.currentTaskSection || '',
      currentTaskName: taskManager.currentTaskName || '',`
);

// 2. 增加 POST /api/tasks/stop 接口
const stopRoute = `
  // 6. 中断/停止当前正在执行的任务
  app.post('/api/tasks/stop', (req, res) => {
    try {
      const result = taskManager.stopCurrentTask();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });
`;

if (!content.includes('/api/tasks/stop')) {
  content = content.replace('  // 6. 载入宿主机本地 .env 配置', stopRoute + '\n  // 6. 载入宿主机本地 .env 配置');
  fs.writeFileSync('src/web/server.js', content, 'utf8');
  console.log('server.js updated with /api/tasks/stop and status fields');
} else {
  console.log('stop route already exists');
}
