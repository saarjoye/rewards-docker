import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

// 导入 healthCheckService
if (!content.includes('healthCheckService')) {
  content = "import healthCheckService from '../core/healthCheck.js';\n" + content;
}

const healthAndConfigRoutes = `
  // 13. 账号健康体检接口 (对标图 8 四维诊断)
  app.post('/api/health/check', async (req, res) => {
    try {
      const { accountId, scope = 'single' } = req.body || {};
      if (scope === 'all') {
        const accounts = configManager.getAccounts();
        const results = [];
        for (const a of accounts) {
          const report = await healthCheckService.checkAccountHealth(a.id);
          results.push(report);
        }
        return res.json({ success: true, scope: 'all', reports: results });
      } else {
        const targetId = accountId || (configManager.getAccounts()[0] && configManager.getAccounts()[0].id);
        if (!targetId) return res.status(404).json({ success: false, message: '未找到待体检账号' });
        const report = await healthCheckService.checkAccountHealth(targetId);
        return res.json({ success: true, scope: 'single', report });
      }
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 14. 网络连通性与出口地区探测 (对标图 2)
  app.post('/api/network/test', async (req, res) => {
    try {
      const { proxy } = req.body || {};
      const result = await healthCheckService.checkNetworkEgress(proxy);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 15. 官网数据同步 (对标图 7)
  app.post('/api/sync/official', async (req, res) => {
    try {
      const { accountId } = req.body || {};
      const account = configManager.getAccount(accountId) || configManager.getAccounts()[0];
      if (!account) return res.status(404).json({ success: false, message: '未找到可用账号' });

      const session = readBrowserSession(account.id) || {};
      const cookies = session.cookies || [];

      // 异步触发同步并在后台回写
      browserManager.withBrowser({ proxy: account.proxy, cookies, headless: true }, async (browser, context) => {
        const data = await taskManager.fetchOfficialDashboard(context, account);
        configManager.upsertAccount({
          id: account.id,
          balance: data.balance,
          todayEarned: data.todayPoints,
          streakDays: data.streakDays,
          claimablePoints: data.claimablePoints
        });
      }).catch((e) => {
        logger.log('⚠️', \`官网数据同步异常: \${e.message}\`);
      });

      res.json({ success: true, message: '已在后台启动从微软官网同步真实完成度' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 16. 全局配置中心数据保存 (对标图 1-6)
  app.post('/api/config/global', (req, res) => {
    try {
      const updated = configManager.updateGlobalSettings(req.body || {});
      res.json({ success: true, config: updated, message: '全局配置已成功保存！' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });
`;

if (!content.includes('/api/health/check')) {
  content = content.replace('  // 1. 获取全盘状态与账号数据看板', healthAndConfigRoutes + '\n  // 1. 获取全盘状态与账号数据看板');
  fs.writeFileSync('src/web/server.js', content, 'utf8');
  console.log('server.js updated with health check and global config routes');
} else {
  console.log('routes already exist');
}
