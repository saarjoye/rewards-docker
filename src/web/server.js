import healthCheckService from '../core/healthCheck.js';
﻿import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import configManager from '../config.js';
import logger from '../logger.js';
import taskManager from '../core/taskManager.js';
import { executeAutonomousAccountLogin } from '../identity/adaptiveAuth.js';
import { deleteBrowserSession } from '../identity/browserSession.js';
import historyManager from '../core/history.js';
import scheduler from '../scheduler.js';
import notifier from '../core/notifier.js';
import browserManager from '../browser/browser.js';
import { DATA_DIR } from '../fsUtil.js';
import {
  validateAdminCredentials,
  hashAdminPassword,
  verifyAdminPassword,
  createAdminSessionToken,
  verifyAdminSessionToken,
  parseCookies,
  getAdminSessionCookieName,
  buildAdminSessionCookie,
  buildAdminLogoutCookie
} from '../identity/adminAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createServer() {
  const app = express();
  app.use(express.json());

  // === 安全网关：验证管理员登录状态 ===
  app.use((req, res, next) => {
    const publicPaths = ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/login.html', '/style.css'];
    if (publicPaths.includes(req.path) || req.path.startsWith('/assets/')) {
      return next();
    }

    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[getAdminSessionCookieName()];
    const secret = configManager.ensureAdminSessionSecret();
    const adminCfg = configManager.getAdminConfig();

    // 如果未初始化管理员，重定向到登录页让用户首次创建管理员
    if (!adminCfg.initialized) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: '请先初始化设置管理员账号' });
      }
      return res.redirect('/login.html');
    }

    const verified = verifyAdminSessionToken(sessionToken, secret);
    if (verified) {
      req.adminUser = verified.username;
      return next();
    }

    // 未经认证请求阻断
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, message: '请先登录管理员账号' });
    }
    return res.redirect('/login.html');
  });

  // 认证状态查询
  app.get('/api/auth/status', (req, res) => {
    const adminCfg = configManager.getAdminConfig();
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[getAdminSessionCookieName()];
    const secret = configManager.ensureAdminSessionSecret();
    const verified = verifyAdminSessionToken(sessionToken, secret);

    res.json({
      success: true,
      initialized: !!adminCfg.initialized,
      authenticated: !!verified,
      username: verified ? verified.username : (adminCfg.username || '')
    });
  });

  // 首次初始化创建管理员
  app.post('/api/auth/setup', async (req, res) => {
    try {
      const adminCfg = configManager.getAdminConfig();
      if (adminCfg.initialized) {
        return res.status(400).json({ success: false, message: '管理员账号已初始化，请直接登录' });
      }

      const { username, password, confirmPassword } = req.body || {};
      const validUser = validateAdminCredentials(username, password, confirmPassword);
      const { salt, passwordHash } = await hashAdminPassword(password);

      configManager.setAdminCredentials(validUser, salt, passwordHash);
      const secret = configManager.ensureAdminSessionSecret();
      const token = createAdminSessionToken(validUser, secret);

      res.setHeader('Set-Cookie', buildAdminSessionCookie(token, req));
      logger.log('🔐', `平台首次初始化完成，管理员 [${validUser}] 已成功设置并登录！`);
      res.json({ success: true, message: '初始化成功' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 管理员账号密码登录
  app.post('/api/auth/login', async (req, res) => {
    try {
      const adminCfg = configManager.getAdminConfig();
      if (!adminCfg.initialized) {
        return res.status(400).json({ success: false, message: '平台尚未初始化管理员，请先设置' });
      }

      const { username, password } = req.body || {};
      if (username !== adminCfg.username) {
        return res.status(401).json({ success: false, message: '管理员账号或密码错误' });
      }

      const passOk = await verifyAdminPassword(password, adminCfg.salt, adminCfg.passwordHash);
      if (!passOk) {
        return res.status(401).json({ success: false, message: '管理员账号或密码错误' });
      }

      const secret = configManager.ensureAdminSessionSecret();
      const token = createAdminSessionToken(username, secret);

      res.setHeader('Set-Cookie', buildAdminSessionCookie(token, req));
      logger.log('🔐', `管理员 [${username}] 成功登录系统`);
      res.json({ success: true, message: '登录成功' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 登出系统
  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', buildAdminLogoutCookie());
    res.json({ success: true, message: '已安全退出登录' });
  });

  app.use(express.static(path.join(__dirname, 'public')));


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
        logger.log('⚠️', `官网数据同步异常: ${e.message}`);
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

  // 1. 获取全盘状态与账号数据看板
  app.get('/api/status', (req, res) => {
    const cfg = configManager.getPublicConfig();
    const accounts = cfg.accounts || [];
    const browserState = browserManager.getState();
    res.json({
      success: true,
      schedulerRunning: scheduler.running,
      isBusy: !!taskManager.runningAccountId,
      runningAccountId: taskManager.runningAccountId,
      runningAccountName: taskManager.runningAccountName || '',
      currentTaskSection: taskManager.currentTaskSection || '',
      currentTaskName: taskManager.currentTaskName || '',
      browserState,
      notify: cfg.notify,
      accounts
    });
  });

  // 2. 账号管理：保存 / 更新账号
  app.post('/api/accounts', (req, res) => {
    try {
      const { id, name, user, pass, proxy, enabled } = req.body;
      if (!user) {
        return res.status(400).json({ success: false, message: '账号不能为空' });
      }

      const accId = id || `acc_${Date.now()}`;
      const saved = configManager.upsertAccount({
        id: accId,
        name: name || user,
        user,
        pass,
        proxy,
        enabled: enabled !== false
      });

      res.json({ success: true, account: saved });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 3. 删除账号与关联会话
  app.delete('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    configManager.deleteAccount(id);
    deleteBrowserSession(id);
    res.json({ success: true });
  });

  // 4. 一键自主登录托管
  app.post('/api/accounts/:id/login', async (req, res) => {
    const { id } = req.params;
    const account = configManager.getAccount(id);
    if (!account) return res.status(404).json({ success: false, message: '账号不存在' });

    executeAutonomousAccountLogin(account)
      .then((result) => {
        if (result.success) {
          configManager.upsertAccount({ id, status: 'ready' });
          logger.log('🎉', `账号 [${account.name}] 自主登录与双通道凭据收割大获全胜！`);
        } else if (result.status === 'needs_2fa') {
          configManager.upsertAccount({ id, status: 'needs_2fa' });
        }
      })
      .catch((err) => {
        configManager.upsertAccount({ id, status: 'error' });
        logger.log('🔴', `账号 [${account.name}] 自动登录失败: ${err.message}`);
      });

    res.json({ success: true, message: '已在后台启动自适应账号密码登录流程' });
  });

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
          logger.log('🔴', `单账号执行异常: ${err.message}`);
        });

        return res.json({
          success: true,
          message: `已启动账号 [${account.name}] 的任务 (范围: ${taskScope})`
        });
      } else {
        taskManager.runAllAccountsTasks({ taskScope }).catch((err) => {
          logger.log('🔴', `全账号批量执行异常: ${err.message}`);
        });

        return res.json({
          success: true,
          message: `已在后台启动全部已启用账号的任务队列 (范围: ${taskScope})`
        });
      }
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });


  // 6. 中断/停止当前正在执行的任务
  app.post('/api/tasks/stop', (req, res) => {
    try {
      const result = taskManager.stopCurrentTask();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 6. 载入宿主机本地 .env 配置
  app.post('/api/accounts/load-env', (req, res) => {
    const result = configManager.readLocalUserEnv();
    if (!result.found) {
      return res.status(404).json({ success: false, message: '未在工作区或数据目录检测到有效的 .env 凭据文件' });
    }

    const id = `acc_${Date.now()}`;
    const acc = configManager.upsertAccount({
      id,
      name: result.user.split('@')[0] || '默认账号',
      user: result.user,
      pass: result.pass
    });

    logger.log('📁', `成功从本地文件 [${result.path}] 载入账号凭据: ${result.user}`);
    res.json({ success: true, account: acc, sourcePath: result.path });
  });

  // 7. 手动触发午夜额外积分收割
  app.post('/api/system/harvest', async (req, res) => {
    const accounts = configManager.getAccounts().filter((a) => a.enabled);
    (async () => {
      for (const a of accounts) {
        await taskManager.harvestMidnightClaimable(a.id);
        await new Promise((r) => setTimeout(r, 5000));
      }
    })();
    res.json({ success: true, message: '已触发额外积分收割，正在后台穿透 React Aria 抽屉' });
  });

  // 8. 获取历史统计趋势
  app.get('/api/history', (req, res) => {
    const { accountId, days } = req.query;
    const list = historyManager.getHistory(accountId, Number(days) || 14);
    res.json({ success: true, history: list });
  });

  // 9. 保存企业微信应用推送配置 (含反代地址)
  app.post('/api/notify', (req, res) => {
    try {
      const saved = configManager.updateNotifyConfig(req.body || {});
      res.json({ success: true, notify: configManager.getPublicConfig().notify });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 10. 测试企业微信应用连通性
  app.post('/api/notify/test', async (req, res) => {
    try {
      await notifier.testChannel(req.body || {});
      res.json({ success: true, message: '企业微信应用测试消息已成功推送！' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 11. 获取无头浏览器实时视口微缩截屏
  app.get('/api/browser/screenshot', (req, res) => {
    const candidatePaths = [
      path.join(DATA_DIR, 'after_black_claim_clicked.png'),
      path.join(DATA_DIR, 'drawer_wait_4s.png'),
      path.join(DATA_DIR, 'puzzle_completed.png'),
      path.join(DATA_DIR, 'webui_with_memory_monitor.png')
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(p);
      }
    }
    res.status(404).send('No screenshot');
  });

  // 12. SSE 实时日志推流
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const recent = logger.getRecentLogs(80);
    for (const item of recent) {
      res.write(`data: ${JSON.stringify(item)}\n\n`);
    }

    const unsubscribe = logger.subscribe((item) => {
      res.write(`data: ${JSON.stringify(item)}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
    });
  });

  return app;
}

export default createServer;
