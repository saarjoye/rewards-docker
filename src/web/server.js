import healthCheckService from '../core/healthCheck.js';
﻿import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import configManager from '../config.js';
import logger from '../logger.js';
import taskManager from '../core/taskManager.js';
import { executeAutonomousAccountLogin } from '../identity/adaptiveAuth.js';
import { readBrowserSession, writeBrowserSession, deleteBrowserSession } from '../identity/browserSession.js';
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
    const publicPaths = ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/login.html', '/style.css', '/app.js', '/favicon.ico'];
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
  // 13.1 账号健康/登录凭据快速探测 GET 接口 (供模态框快速检测与单账号状态感知)
  app.get('/api/health', async (req, res) => {
    try {
      const { accountId } = req.query || {};
      const targetId = accountId || (configManager.getAccounts()[0] && configManager.getAccounts()[0].id);
      if (!targetId) {
        return res.status(404).json({ success: false, message: '未找到待体检账号，请先添加账号' });
      }

      const account = configManager.getAccount(targetId);
      if (!account) {
        return res.status(404).json({ success: false, message: '未找到指定账号: ' + targetId });
      }

      const report = await healthCheckService.checkAccountHealth(targetId);
      const isOk = Boolean(report.allSatisfied || report.cookieHealth?.healthy);
      const status = report.allSatisfied ? 'ready' : (report.cookieHealth?.hasU ? 'warning' : 'needs_login');
      configManager.upsertAccount({
        id: report.accountId,
        status,
        allSatisfied: report.allSatisfied
      });

      const detail = report.cookieHealth?.detail || (isOk ? '登录凭据正常且有效' : '登录凭据待补齐或异常');
      const itemResult = {
        accountId: targetId,
        accountName: report.accountName,
        status: isOk ? 'ok' : status,
        rawStatus: status,
        allSatisfied: report.allSatisfied,
        detail,
        report
      };

      return res.json({
        success: true,
        report,
        results: [itemResult]
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 13.2 账号健康体检接口 (对标图 8 四维诊断)
  app.post('/api/health/check', async (req, res) => {
    try {
      const { accountId, scope = 'single' } = req.body || {};
      if (scope === 'all') {
        const accounts = configManager.getAccounts();
        const results = [];
        for (const a of accounts) {
          const report = await healthCheckService.checkAccountHealth(a.id);
          configManager.upsertAccount({
            id: report.accountId,
            status: report.allSatisfied ? 'ready' : (report.cookieHealth.hasU ? 'warning' : 'needs_login'),
            allSatisfied: report.allSatisfied
          });
          results.push(report);
        }
        return res.json({
          success: true,
          scope: 'all',
          reports: results,
          results: results.map((r) => {
            const isOk = Boolean(r.allSatisfied || r.cookieHealth?.healthy);
            const status = r.allSatisfied ? 'ready' : (r.cookieHealth?.hasU ? 'warning' : 'needs_login');
            return {
              accountId: r.accountId,
              accountName: r.accountName,
              status: isOk ? 'ok' : status,
              rawStatus: status,
              allSatisfied: r.allSatisfied,
              detail: r.cookieHealth?.detail || (isOk ? '登录凭据正常且有效' : '登录凭据待补齐'),
              report: r
            };
          })
        });
      } else {
        const targetId = accountId || (configManager.getAccounts()[0] && configManager.getAccounts()[0].id);
        if (!targetId) return res.status(404).json({ success: false, message: '未找到待体检账号' });
        const report = await healthCheckService.checkAccountHealth(targetId);
        configManager.upsertAccount({
          id: report.accountId,
          status: report.allSatisfied ? 'ready' : (report.cookieHealth.hasU ? 'warning' : 'needs_login'),
          allSatisfied: report.allSatisfied
        });
        const isOk = Boolean(report.allSatisfied || report.cookieHealth?.healthy);
        const status = report.allSatisfied ? 'ready' : (report.cookieHealth?.hasU ? 'warning' : 'needs_login');
        return res.json({
          success: true,
          scope: 'single',
          report,
          results: [{
            accountId: targetId,
            accountName: report.accountName,
            status: isOk ? 'ok' : status,
            rawStatus: status,
            allSatisfied: report.allSatisfied,
            detail: report.cookieHealth?.detail || (isOk ? '登录凭据正常且有效' : '登录凭据待补齐'),
            report
          }]
        });
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
      const allAccounts = configManager.getAccounts().filter((a) => a.enabled);
      if (allAccounts.length === 0) return res.status(404).json({ success: false, message: '未找到可用账号' });

      const targetAccounts = (accountId && accountId !== 'all')
        ? [configManager.getAccount(accountId)].filter(Boolean)
        : allAccounts;
      if (targetAccounts.length === 0) {
        return res.status(404).json({ success: false, message: '未找到指定的可用账号' });
      }

      const startedAt = Date.now();
      const targetAccountIds = targetAccounts.map((account) => account.id);

      // 异步在后台依序同步每一个账号，支持未登录账号自动自愈登录
      (async () => {
        logger.log('⏳', `[官网同步] 启动全量官方账本同步流水线，共 ${targetAccounts.length} 个账号待采集...`);
        for (let i = 0; i < targetAccounts.length; i++) {
          const account = targetAccounts[i];
          try {
            logger.log('🔍', `[官网同步] (${i + 1}/${targetAccounts.length}) 正在连接微软权威账本: [${account.name}]...`);
            let session = readBrowserSession(account.id) || {};
            let cookies = session.cookies || [];

            // 关键机制：若账号缺少必应 Cookie 且有密码，自动自适应登录换取凭据
            const hasU = cookies.some((c) => c.name === '_U' && (c.domain.includes('bing.com') || c.domain.includes('msn.cn')));
            if (!hasU && account.user && account.pass) {
              logger.log('🔑', `[官网同步] 账号 [${account.name}] 缺少必应凭据，自动启动自适应登录自愈...`);
              const authRes = await executeAutonomousAccountLogin(account).catch(() => ({ success: false }));
              if (authRes && authRes.success) {
                session = readBrowserSession(account.id) || {};
                cookies = session.cookies || [];
              }
            }

            const hasUAfter = (cookies || []).some((c) => c.name === '_U' && (c.domain.includes('bing.com') || c.domain.includes('msn.cn')));
            if (!hasUAfter) {
              logger.log('⚠️', `[官网同步] 账号 [${account.name}] 缺少有效登录会话 (_U)，跳过官网抓取以避免覆盖现有数据`);
              configManager.upsertAccount({ id: account.id, status: 'needs_login' });
              continue;
            }

            await browserManager.withBrowser({ proxy: account.proxy, cookies, headless: true }, async (browser, context) => {
              const data = await taskManager.fetchOfficialDashboard(context, account);
              let officialTasks = null;
              try {
                officialTasks = await taskManager.fetchOfficialTaskSnapshot(context, account);
              } catch (snapshotErr) {
                logger.log('⚠️', `[官网同步] 任务状态读取失败 [${account.name}]: ${snapshotErr.message}`);
              }
              const syncedAt = Date.now();
              const hasLiveBalance = data.sources?.balance === 'live';
              const hasLiveToday = data.sources?.todayPoints === 'live';
              const hasLiveDashboard = hasLiveBalance && hasLiveToday;
              const hasOfficialTasks = !!officialTasks && typeof officialTasks === 'object';
              const dataState = hasLiveDashboard && hasOfficialTasks
                ? (officialTasks.hasUnknown ? 'partial' : 'complete')
                : (hasLiveDashboard ? 'partial' : (account.dataState || 'unknown'));

              const updatePayload = {
                id: account.id,
                name: account.name,
                user: account.user,
                officialTasks: officialTasks || account.officialTasks || null,
                lastSyncAt: hasLiveDashboard ? syncedAt : (account.lastSyncAt || null),
                dataState,
                status: 'ready'
              };
              if (hasLiveBalance) updatePayload.balance = data.balance;
              if (hasLiveToday) updatePayload.todayEarned = data.todayPoints;
              if (data.sources?.streakDays === 'live') updatePayload.streakDays = data.streakDays;
              if (data.sources?.claimablePoints === 'live') updatePayload.claimablePoints = data.claimablePoints;

              configManager.upsertAccount(updatePayload);

              if (hasLiveToday || hasLiveBalance) {
                historyManager.recordDaily(account.id, {
                  todayEarned: hasLiveToday ? data.todayPoints : null,
                  balance: hasLiveBalance ? data.balance : null,
                  streakDays: data.sources?.streakDays === 'live' ? data.streakDays : null,
                  claimablePoints: data.sources?.claimablePoints === 'live' ? data.claimablePoints : null,
                  officialTasks,
                  source: 'official-sync'
                });
                logger.log('✅', `[官网同步] 账号 [${account.name}] 真实数据回写成功: 今日 ${hasLiveToday ? data.todayPoints + '分' : '未更新'}, 总额 ${hasLiveBalance ? data.balance + '分' : '未更新'}, 连签 ${data.streakDays || 0}天`);
              } else {
                logger.log('⚠️', `[官网同步] 账号 [${account.name}] 未能从微软官网采集到有效资产数据，保留原数据未覆盖`);
              }
            });
            await new Promise((r) => setTimeout(r, 1500));
          } catch (err) {
            logger.log('⚠️', `账号 [${account.name}] 官网数据同步异常: ${err.message}`);
          }
        }
        logger.log('🎉', `[官网同步] 全部 ${targetAccounts.length} 个账号的官方权威数据全部采集入账完毕！`);
      })();

      res.json({
        success: true,
        startedAt,
        targetAccountIds,
        message: targetAccounts.length > 1
          ? `已在后台启动全部 ${targetAccounts.length} 个账号的官方数据同步`
          : `已在后台启动账号 [${targetAccounts[0].name}] 的官方数据同步`
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 0. 最近30天官网快照（用于积分日历与账号卡片的统一口径）
  app.get('/api/history/recent', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, snapshots: historyManager.getRecentAll(30) });
  });

  // 1. 获取全盘状态与账号数据看板
  app.get('/api/status', (req, res) => {
    const cfg = configManager.getPublicConfig();
    const accounts = cfg.accounts || [];
    const browserState = browserManager.getState();
    const nextScheduledTask = typeof scheduler.getNextScheduledTask === 'function'
      ? scheduler.getNextScheduledTask()
      : null;
    res.json({
      success: true,
      schedulerRunning: scheduler.running,
      nextScheduledTask,
      isBusy: !!taskManager.runningAccountId || !!taskManager.isQueueRunning,
      runningAccountId: taskManager.runningAccountId,
      runningAccountName: taskManager.runningAccountName || '',
      currentTaskSection: taskManager.currentTaskSection || '',
      currentTaskName: taskManager.currentTaskName || '',
      taskStartTime: taskManager.taskStartTime || null,
      browserState,
      network: cfg.network || {},
      taskOptions: cfg.taskOptions || {},
      scheduler: cfg.scheduler || {},
      searchSettings: cfg.searchSettings || {},
      notify: cfg.notify,
      accounts: accounts.map((a) => ({
        ...a,
        hasOfficialData: Number(a.lastSyncAt || 0) > 0 && a.todayEarned != null && a.balance != null,
        dataState: a.dataState || (Number(a.lastSyncAt || 0) > 0 ? 'complete' : 'unknown')
      }))
    });
  });

  // 2. 账号管理：保存 / 更新账号
  app.post('/api/accounts', (req, res) => {
    try {
      const { id, name, user, pass, proxy, enabled, slot } = req.body;
      if (!user) {
        return res.status(400).json({ success: false, message: '账号不能为空' });
      }

      const accId = id || `acc_${Date.now()}`;
      const saved = configManager.upsertAccount({
        id: accId,
        name: (name && name !== '默认账号') ? name : (user.includes('@') ? user.split('@')[0] : user),
        user,
        pass,
        proxy,
        enabled: enabled !== false,
        slot: slot || 'auto'
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

  // 7. 手动触发额外积分收割 (支持指定单账号或全量多账号)
  app.post('/api/system/harvest', async (req, res) => {
    const { accountId } = req.body || {};
    if (accountId && accountId !== 'all') {
      const account = configManager.getAccount(accountId);
      if (!account) return res.status(404).json({ success: false, message: '账号不存在' });
      (async () => {
        await taskManager.harvestMidnightClaimable(accountId);
      })();
      return res.json({ success: true, message: `已启动账号 [${account.name || account.user}] 的专属额外积分收割` });
    }

    const accounts = configManager.getAccounts().filter((a) => a.enabled);
    (async () => {
      taskManager.beginRun('全量额外积分收割队列');
      taskManager.isQueueRunning = true;
      try {
        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i];
          if (taskManager.shouldStop) break;
          await taskManager.harvestMidnightClaimable(a.id);
          if (i < accounts.length - 1) {
            const cooldown = 15000 + Math.random() * 5000;
            logger.log('❄️', `账号切换物理隔离冷却 ${Math.round(cooldown / 1000)} 秒...`);
            if (!(await taskManager.waitUnlessStopped(cooldown))) break;
          }
        }
      } finally {
        taskManager.isQueueRunning = false;
      }
    })();
    res.json({ success: true, message: `已启动全量 ${accounts.length} 个账号的额外积分收割` });
  });

  // 8. 获取历史统计趋势
  app.get('/api/history', (req, res) => {
    const { accountId, days, month } = req.query;
    if (month) {
      const list = historyManager.getMonthHistory(accountId, month);
      return res.json({ success: true, history: list, month });
    }
    const list = historyManager.getHistory(accountId, Number(days) || 14);
    res.json({ success: true, history: list });
  });

  // 全局配置中心数据全量保存 (对标图 1-6)
  app.post('/api/config/global', (req, res) => {
    try {
      const updated = configManager.updateGlobalSettings(req.body || {});
      logger.log('⚙️', '全局配置中心参数已成功更新生效！');
      res.json({ success: true, config: updated, message: '全局配置已成功保存生效！' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
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

  // 测试机器人 Webhook 连通性
  app.post('/api/notify/test-bot', async (req, res) => {
    try {
      const { type, target } = req.body || {};
      if (type === 'wework') {
        await notifier.sendWeWorkBot(target, '企业微信群机器人连通性测试', '如果你收到此条消息，说明企业微信机器人 Webhook 已经 100% 连通生效！');
      } else if (type === 'dingtalk') {
        await notifier.sendDingTalkBot(target, '钉钉群机器人连通性测试', '如果你收到此条消息，说明钉钉群机器人 Webhook 已经 100% 连通生效！');
      } else {
        throw new Error('未知机器人类型');
      }
      res.json({ success: true, message: '测试消息已成功推送送达！' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
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

  // 11. 获取无头浏览器实时视口微缩截屏 (动态 SVG 优雅兜底，杜绝 404 碎图)
  app.get('/api/browser/screenshot', (req, res) => {
    const latestShot = path.join(DATA_DIR, 'latest_screencast.png');
    if (fs.existsSync(latestShot)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(latestShot);
    }

    // 检查历史候选截屏
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

    // 动态生成高清暗黑视口占位图 (SVG，绝对不碎图)
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0b1120"/>
          <stop offset="100%" stop-color="#020617"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bgGrad)"/>
      <rect x="0" y="0" width="100%" height="48" fill="#1e293b"/>
      <circle cx="30" cy="24" r="6" fill="#ef4444"/>
      <circle cx="48" cy="24" r="6" fill="#f59e0b"/>
      <circle cx="66" cy="24" r="6" fill="#10b981"/>
      <rect x="120" y="10" width="1200" height="28" rx="6" fill="#0f172a"/>
      <text x="720" y="29" font-family="-apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif" font-size="12" fill="#64748b" text-anchor="middle">
        🔒 https://rewards.bing.com/dashboard (微软官方实时控制台)
      </text>
      <text x="720" y="440" font-family="-apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif" font-size="28" font-weight="700" fill="#94a3b8" text-anchor="middle">
        🖥️ 无头浏览器处于空闲休眠状态 (0 进程占用)
      </text>
      <text x="720" y="485" font-family="-apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif" font-size="15" fill="#475569" text-anchor="middle">
        点击右上角「立即执行任务」或开启定时巡检，将在此处以 1440×900 实时投影执行视口
      </text>
    </svg>`;
    return res.send(svg.trim());
  });

  // 12.a 日志轮询兜底（用于反向代理缓冲 SSE 的场景）
  app.get('/api/logs/recent', (req, res) => {
    const since = Number(req.query.since || 0);
    const limit = Math.min(Number(req.query.limit) || 200, 600);
    const list = logger.getRecentLogs(limit).filter((item) => {
      const ts = Number(item.ts) || Number(String(item.id).split('.')[0]) || 0;
      return ts > since;
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, logs: list, serverTime: Date.now() });
  });

  // 12. SSE 实时日志推流
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 15000);

    const recent = logger.getRecentLogs(80);
    for (const item of recent) {
      res.write(`data: ${JSON.stringify(item)}\n\n`);
    }

    const unsubscribe = logger.subscribe((item) => {
      res.write(`data: ${JSON.stringify(item)}\n\n`);
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // API 404 兜底保护，杜绝任何未匹配 /api/* 请求返回 HTML 导致前端 JSON 解析崩溃
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      success: false,
      message: '未找到 API 路由: ' + req.method + ' ' + req.path
    });
  });

  // 全局 API 错误捕获中间件，确保 API 报错始终返回规范 JSON
  app.use((err, req, res, next) => {
    logger.error('[WebAPI] 未捕获异常: ' + err.message, { stack: err.stack, path: req.path });
    if (res.headersSent) {
      return next(err);
    }
    if (req.path && req.path.startsWith('/api/')) {
      return res.status(err.status || 500).json({
        success: false,
        message: err.message || '内部服务异常'
      });
    }
    next(err);
  });

  return app;
}

export default createServer;
