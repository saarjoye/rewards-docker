import networkClient from '../network.js';
import configManager from '../config.js';
import { readBrowserSession } from '../identity/browserSession.js';
import { parseWlsInfo } from '../identity/auth.js';
import { DapiClient } from '../identity/dapi.js';
import logger from '../logger.js';

export class HealthCheckService {
  /**
   * 诊断当前网络出口 IP 与国区防风控状态
   */
  async checkNetworkEgress(proxy = '') {
    try {
      const t0 = Date.now();
      // 使用快速权威的 IP 归属地探测接口
      const res = await networkClient.request({
        url: 'https://ipwho.is/',
        method: 'GET',
        timeout: 10000,
        proxy
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      const latency = Date.now() - t0;
      const countryCode = data.country_code || 'UNKNOWN';
      const isCN = countryCode === 'CN';

      return {
        success: true,
        ip: data.ip || '未知',
        country: data.country || '未知',
        countryCode,
        isCN,
        latency,
        message: isCN ? `中国大陆 IP (${data.region || ''} ${data.city || ''} · ${latency}ms)` : `非 CN 出口 (${data.country} · ${latency}ms)`
      };
    } catch (e) {
      return {
        success: false,
        ip: '探测超时',
        country: '未知',
        countryCode: 'UNKNOWN',
        isCN: false,
        latency: 0,
        message: `网络连通探测异常: ${e.message}`
      };
    }
  }

  /**
   * 单账号四维健康体检
   */
  async checkAccountHealth(accountId) {
    const account = configManager.getAccount(accountId);
    if (!account) throw new Error(`未找到账号 ID: ${accountId}`);

    const session = readBrowserSession(accountId) || {};
    const cookies = session.cookies || [];
    const tokens = session.tokens || {};

    // 1. 必应网页端 Cookie 体检
    const hasU = cookies.some((c) => c.name === '_U' && (c.domain.includes('bing.com') || c.domain.includes('msn.cn')));
    const wls = parseWlsInfo(cookies);
    const hasLiveAuth = cookies.some((c) => c.name === '.MSA.Auth' || c.name === 'RPSTAuth' || c.domain.includes('live.com'));

    const cookieHealth = {
      healthy: hasU,
      hasU,
      hasWls: !!wls.cid,
      cid: wls.cid || '未捕获',
      name: wls.name || account.name,
      totalCookies: cookies.length,
      detail: hasU
        ? `Cookie 完备 (含必应 _U，CID: ${wls.cid || '匹配'})`
        : `缺少必应 _U 计分凭据 (共 ${cookies.length} 项，任务前将自动触发单点登录自愈)`
    };

    // 2. 移动端 App 授权 (DAPI) 体检
    let oauthHealth = {
      healthy: false,
      hasToken: false,
      userId: '',
      expiresInMin: 0,
      detail: ''
    };

    if (tokens.accessToken) {
      const now = Date.now();
      const remainSec = Math.max(0, Math.floor(((tokens.obtainedAt || now) + (tokens.expiresIn || 86400) * 1000 - now) / 1000));
      const remainMin = Math.round(remainSec / 60);

      oauthHealth = {
        healthy: remainSec > 60,
        hasToken: true,
        userId: tokens.userId || wls.cid || '',
        expiresInMin: remainMin,
        detail: `Token 有效 (剩余约 ${remainMin} 分钟，支持自愈无感续期)`
      };
    } else {
      oauthHealth.detail = '尚未换取移动端 Token (首次登录将自动截获授权码补齐)';
    }

    // 3. 容器出口 IP 与国区防风控体检
    const netHealth = await this.checkNetworkEgress(account.proxy);

    // 4. 平台实时总额与配额体检
    const quotaHealth = {
      balance: account.balance || 0,
      todayEarned: account.todayEarned || 0,
      streakDays: account.streakDays || 0,
      claimablePoints: account.claimablePoints || 0,
      detail: `官网实时可用: ${account.balance || 0} 分 · 今日已增: ${account.todayEarned || 0} 分 · 连签: ${account.streakDays || 0} 天`
    };

    // 综合判定
    const allSatisfied = cookieHealth.healthy && oauthHealth.healthy && (netHealth.isCN || !configManager.get().network?.lockChinaIp);

    return {
      accountId,
      accountName: account.name || account.user,
      allSatisfied,
      cookieHealth,
      oauthHealth,
      netHealth,
      quotaHealth,
      timestamp: Date.now()
    };
  }
}

export const healthCheckService = new HealthCheckService();
export default healthCheckService;
