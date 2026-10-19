import fs from 'fs';

let content = fs.readFileSync('src/web/server.js', 'utf8');

// 导入 adminAuth 模块
const adminImport = `import {
  validateAdminCredentials,
  hashAdminPassword,
  verifyAdminPassword,
  createAdminSessionToken,
  verifyAdminSessionToken,
  parseCookies,
  getAdminSessionCookieName,
  buildAdminSessionCookie,
  buildAdminLogoutCookie
} from '../identity/adminAuth.js';`;

if (!content.includes('adminAuth.js')) {
  content = adminImport + '\n' + content;
}

// 编写权限验证中间件与认证路由
const authGateMiddleware = `
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
`;

if (!content.includes('buildAdminSessionCookie')) {
  content = content.replace('  app.use(express.static(path.join(__dirname, \'public\')));', authGateMiddleware + '\n  app.use(express.static(path.join(__dirname, \'public\')));');
  fs.writeFileSync('src/web/server.js', content, 'utf8');
  console.log('server.js updated with auth gate middleware');
} else {
  console.log('auth gate already exists');
}
