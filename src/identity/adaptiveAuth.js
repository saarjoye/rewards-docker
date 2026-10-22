import browserManager from '../browser/browser.js';
import { AUTH_CONFIG, exchangeCodeForToken, parseWlsInfo, verifyIdentityConsistency } from './auth.js';
import { writeBrowserSession } from './browserSession.js';
import logger from '../logger.js';
import path from 'path';
import { DATA_DIR } from '../fsUtil.js';

export async function loginWithAdaptiveStateMachine(page, credentials, options = {}) {
  const { user, pass } = credentials;
  const timeoutMs = options.timeoutMs || 70000;
  const startTime = Date.now();
  const log = (msg) => logger.log('🔑', `[自适应登录] ${msg}`, '', user);

  log(`启动全形态自适应登录引擎: ${user}`);

  let interceptedCode = null;
  const checkCodeInUrl = (u) => {
    if (!u) return;
    if (u.includes('desktop.srf') && u.includes('code=')) {
      const match = u.match(/[?&]code=([^&#]+)/);
      if (match) {
        interceptedCode = decodeURIComponent(match[1]);
        log('网络流精准捕获到 OAuth 授权码！');
      }
    } else if (u.includes('code=M.')) {
      const match = u.match(/[?&]code=([^&#]+)/);
      if (match) {
        interceptedCode = decodeURIComponent(match[1]);
        log('网络流捕获到移动端授权 Code！');
      }
    }
  };

  page.on('framenavigated', (frame) => {
    try {
      if (frame === page.mainFrame()) checkCodeInUrl(frame.url());
    } catch {}
  });
  page.on('response', (res) => {
    try {
      checkCodeInUrl(res.url());
      const loc = res.headers()['location'];
      if (loc) checkCodeInUrl(loc);
    } catch {}
  });
  page.on('request', (req) => {
    try {
      checkCodeInUrl(req.url());
    } catch {}
  });

  // 1. 打开 OAuth 授权引导入口
  try {
    await page.goto(AUTH_CONFIG.authorizeUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
  } catch (e) {
    log(`访问授权入口超时，继续监测页面状态: ${e.message}`);
  }

  let usernameFilled = false;
  let passwordFilled = false;

  while (Date.now() - startTime < timeoutMs) {
    if (interceptedCode) {
      log('已成功截获授权码，终态判定成功！');
      return { success: true, code: interceptedCode };
    }

    let url = '';
    try { url = page.url(); } catch {}
    checkCodeInUrl(url);
    if (interceptedCode) {
      return { success: true, code: interceptedCode };
    }

    // 检测页面死锁 / 账号冻结
    const pageText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (pageText.includes('账户已被锁定') || pageText.includes('Account has been locked')) {
      await page.screenshot({ path: path.join(DATA_DIR, 'account_locked.png') }).catch(() => {});
      throw new Error('微软提示：此账户已被锁定，请前往微软官网手动解除锁定');
    }

    // 2. 用户名阶段
    if (!usernameFilled) {
      const userSelector = await page.$('input[name="loginfmt"], #usernameEntry, input[type="email"]');
      if (userSelector && await userSelector.isVisible()) {
        log('输入账号邮箱...');
        await userSelector.fill(user);
        await new Promise((r) => setTimeout(r, 400));
        const nextBtn = await page.$('#idSIButton9, input[type="submit"], button[type="submit"]');
        if (nextBtn && await nextBtn.isVisible()) {
          await nextBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        usernameFilled = true;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
    }

    // 3. 无密码拦截 / 尝试切换到密码模式
    const switchPasswordBtn = await page.$(
      ':text("使用密码"), #idA_PWD_SwitchToPassword, :text("使用你的密码"), :text("使用密码登录"), :text("其他登录方式"), #otherWays'
    );
    if (switchPasswordBtn && await switchPasswordBtn.isVisible()) {
      log('发现无密码拦截或多种登录方式，自动切入「密码模式」...');
      await switchPasswordBtn.click();
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    // 4. 密码输入阶段
    if (!passwordFilled) {
      const passSelector = await page.$('input[name="passwd"], #passwordEntry, input[type="password"]');
      if (passSelector && await passSelector.isVisible()) {
        log('输入登录密码...');
        if (typeof passSelector.type === "function") { await passSelector.type(pass, { delay: 35 }); } else { await passSelector.fill(pass); }
        await new Promise((r) => setTimeout(r, 500));
        const submitBtn = await page.$('#idSIButton9, input[type="submit"], button[type="submit"]');
        if (submitBtn && await submitBtn.isVisible()) {
          await submitBtn.click();
        } else {
          await page.keyboard.press('Enter');
        }
        passwordFilled = true;
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
    }

    // 5. 密码错误阻断检测
    if (passwordFilled) {
      if (pageText.includes('密码不正确') || pageText.includes('此密码不是你的')) {
        await page.screenshot({ path: path.join(DATA_DIR, 'bad_password.png') }).catch(() => {});
        throw new Error('微软提示：账号密码不正确，请核对配置');
      }
    }

    // 6. 强制 2FA 阻断检测 (方案 A 决策：安全熔断与预警)
    if (
      pageText.includes('在应用中批准') ||
      pageText.includes('在 Authenticator 应用中') ||
      pageText.includes('输入代码') ||
      pageText.includes('检查你的短信') ||
      pageText.includes('验证你的身份')
    ) {
      // 再次确认页面上是否有备用“使用密码”
      const altPwd = await page.$(':text("使用密码"), #idA_PWD_SwitchToPassword');
      if (!altPwd) {
        log('检测到账号启用强制 2FA 多因子验证，触发快速失败守护熔断...');
        await page.screenshot({ path: path.join(DATA_DIR, 'needs_2fa.png') }).catch(() => {});
        return { success: false, status: 'needs_2fa', message: '账号需要手机 Authenticator 批准或双因子验证码' };
      }
    }

    // 7. 保持登录 (KMSI) 自动穿透
    const kmsiBtn = await page.$('#idSIButton9, #acceptButton, :text("保持登录状态?")');
    if (kmsiBtn && await kmsiBtn.isVisible()) {
      const dontShow = await page.$('input[name="DontShowAgain"]');
      if (dontShow && await dontShow.isVisible()) {
        try { await dontShow.check(); } catch {}
      }
      log('自动确认保持登录 (KMSI)...');
      await kmsiBtn.click();
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    // 8. 条款或安全跳过
    const skipNotice = await page.$(':text("稍后提醒我"), #iShowSkip, :text("继续"), :text("接受")');
    if (skipNotice && await skipNotice.isVisible()) {
      log('跳过安全提示或接受条款...');
      await skipNotice.click();
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (interceptedCode) {
    return { success: true, code: interceptedCode };
  }

  await page.screenshot({ path: path.join(DATA_DIR, 'login_timeout.png') }).catch(() => {});
  throw new Error('自适应登录超时，未能在规定时间内完成微软鉴权流程');
}

/**
 * 完整账号全自动托管登录流 (一键集齐 Web Cookie 与 Mobile OAuth Token)
 */
export async function executeAutonomousAccountLogin(account, options = {}) {
  const { id, user, pass, proxy } = account;
  if (!user || !pass) {
    throw new Error('缺少账号或密码，无法执行自动登录');
  }

  return await browserManager.withBrowser({ proxy, headless: true }, async (browser, context) => {
    const page = await context.newPage();

    // 步骤 1：执行全自适应登录，拦截 OAuth 授权码
    const loginResult = await loginWithAdaptiveStateMachine(page, { user, pass }, options);
    if (!loginResult.success) {
      return loginResult;
    }

    const { code } = loginResult;
    logger.log('🔑', `账号 [${account.name || user}] 授权码拦截成功，换取移动端 Token...`);

    // 步骤 2：换取移动端 OAuth Token
    const tokens = await exchangeCodeForToken(code, proxy);
    logger.log('📱', `移动端 OAuth Token 换取成功！UserId: ${tokens.userId}`);

    // 步骤 3：必应单点登录自愈 (获取 .bing.com 的关键凭据 _U & WLS)
    logger.log('🌐', '正在执行必应单点登录自愈 (Bing SSO)...');
    try {
      await page.goto('https://cn.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fcn.bing.com%2F', {
        waitUntil: 'networkidle',
        timeout: 25000
      });
    } catch {}

    // 提取全部跨域 Cookies
    const cookies = await context.cookies();
    const hasU = cookies.some((c) => c.name === '_U' && c.domain.includes('bing.com'));
    const wlsInfo = parseWlsInfo(cookies);

    logger.log('🍪', `Cookies 收割完成，共 ${cookies.length} 项 (必应 _U: ${hasU ? '已具备 ✅' : '未生成 ⚠️'}, CID: ${wlsInfo.cid || '未捕获'})`);

    // 步骤 4：先行持久化落盘（确保账号凭据绝对不丢失）
    const sessionData = {
      tokens,
      cookies,
      identity: {
        userId: tokens?.userId || wlsInfo?.cid || '',
        cid: wlsInfo?.cid || tokens?.userId || '',
        name: wlsInfo?.name || account.name || user
      }
    };
    writeBrowserSession(id, sessionData);
    logger.log('💾', `账号 [${account.name || user}] 独立会话持久化落盘成功 (共 ${cookies.length} 项 Cookies, 移动端 Token: ${tokens?.accessToken ? '已签发' : '待生成'})！`);

    // 步骤 5：双通道同源性比对
    const identityCheck = verifyIdentityConsistency(wlsInfo.cid, tokens.userId);
    if (!identityCheck.match) {
      logger.log('⚠️', `[同源比对提示] 账号 [${account.name || user}]: ${identityCheck.message} (已先行持久化可用凭据)`);
    }

    return {
      success: true,
      status: 'ready',
      identity: sessionData.identity,
      tokens,
      hasU
    };
  });
}

