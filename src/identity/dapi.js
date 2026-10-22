import crypto from 'crypto';
import networkClient from '../network.js';
import { USER_AGENTS, refreshAccessToken } from './auth.js';
import logger from '../logger.js';

export const DAPI_CONFIG = {
  rewardsAppId: 'SAAndroid/32.6.2110003560',
  channel: 'SAAndroid',
  endpoint: 'https://prod.rewardsplatform.microsoft.com/dapi/me'
};

export function generateDapiActivityId() {
  const u1 = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  const u2 = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  return (u1 + u2).slice(0, 56);
}

export class DapiClient {
  constructor(account, tokens, onTokenRefresh) {
    this.account = account;
    this.tokens = tokens;
    this.onTokenRefresh = onTokenRefresh;
  }

  async getValidToken() {
    if (!this.tokens || !this.tokens.accessToken) {
      throw new Error('未配置移动端 Access Token，需先执行自主登录换取');
    }

    // 检查 Token 是否在 5 分钟内过期
    const isExpired = this.tokens.obtainedAt && this.tokens.expiresIn &&
      (Date.now() - this.tokens.obtainedAt > (this.tokens.expiresIn - 300) * 1000);

    if (isExpired && this.tokens.refreshToken) {
      logger.log('🔄', `Access Token 即将过期，使用 Refresh Token 自动续期...`, '', this.account.name);
      try {
        const refreshed = await refreshAccessToken(this.tokens.refreshToken, this.account.proxy);
        this.tokens = refreshed;
        if (this.onTokenRefresh) this.onTokenRefresh(refreshed);
      } catch (e) {
        logger.log('⚠️', `Token 续期失败，尝试使用当前 Token 继续: ${e.message}`, '', this.account.name);
      }
    }

    return this.tokens.accessToken;
  }

  /**
   * 提交 DAPI 任务活动
   */
  async submitActivity(offerId, amount = 1) {
    const token = await this.getValidToken();
    const activityId = generateDapiActivityId();

    const payload = {
      amount,
      country: 'CN',
      id: activityId,
      type: 101,
      attributes: {
        offerid: offerId
      }
    };

    const res = await networkClient.request({
      url: `${DAPI_CONFIG.endpoint}/activities`,
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'user-agent': USER_AGENTS.app,
        'authorization': `Bearer ${token}`,
        'x-rewards-appid': DAPI_CONFIG.rewardsAppId
      },
      data: JSON.stringify(payload),
      proxy: this.account.proxy
    });

    if (res && (res.error || res.status === 'error')) {
      throw new Error(res.error?.message || res.message || 'DAPI 返回业务错误');
    }

    return res;
  }

  /**
   * 移动端每日 App 签入 (Streaks 板块: 签到: 1/1 - 对标 Sapphire type 103 协议规范)
   */
  async performAppCheckIn() {
    logger.log('📱', '正在执行必应应用连续打卡 (DAPI Sapphire 网关直连签入)...', '', this.account.name);
    try {
      const token = await this.getValidToken();
      const activityId = generateDapiActivityId();

      const payload = {
        risk_context: {},
        type: 103, // 核心：Sapphire Daily Check-In 类型代码为 103
        channel: 'SAIOS',
        attributes: {},
        id: activityId,
        amount: 1,
        country: 'CN'
      };

      const res = await networkClient.request({
        url: `${DAPI_CONFIG.endpoint}/activities`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (iPad; CPU iPad OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/605.1.15 BingSapphire/33.4.440603001',
          'X-Rewards-AppId': 'SAIOS/33.4.440603001',
          'X-Rewards-PartnerId': 'startapp',
          'X-Rewards-Country': 'CN',
          'X-Rewards-Language': 'zh-hans',
          'X-Rewards-Flights': 'rwgobig',
          'X-Rewards-IsMobile': 'true'
        },
        data: JSON.stringify(payload),
        proxy: this.account.proxy
      });

      if (res && res.code === 0) {
        const gained = res.response?.activity?.p ?? res.response?.creditedPoints ?? 0;
        const newBalance = res.response?.balance ?? null;
        logger.log('✅', `必应移动端签到成功！本次入账: +${gained} 分${newBalance ? `，最新余额: ${newBalance} 分` : ''}，官网已点亮 [签到: 1/1]！`, '', this.account.name);
        return { success: true, gained, balance: newBalance };
      }
    } catch (e) {
      logger.log('⚠️', `Sapphire 移动端直连签到异常: ${e.message}，尝试备用候选通道...`, '', this.account.name);
    }

    // 备用通道回退
    const offerCandidates = [
      'Gamification_DailyCheckIn',
      'Gamification_Sapphire_DailyCheckIn',
      'Sapphire_DailyCheckIn'
    ];
    for (const offerId of offerCandidates) {
      try {
        const res = await this.submitActivity(offerId);
        logger.log('✅', `必应移动端签到备用通道成功 (${offerId})！`, '', this.account.name);
        return { success: true };
      } catch (e) {}
    }

    logger.log('⚠️', '必应移动端签到未能在当前轮次点亮 (可等待稍后重试或确认移动 Token)', '', this.account.name);
    return { success: false };
  }

  /**
   * 移动端新闻资讯阅读 (每篇加 3 分，上限 30 分)
   */
  async performNewsReading(targetArticles = 10) {
    logger.log('📖', `开始执行移动端新闻资讯阅读 (目标 ${targetArticles} 篇，共 30 分)...`, '', this.account.name);
    let successCount = 0;

    for (let i = 1; i <= targetArticles; i++) {
      try {
        await this.submitActivity('ENUS_readarticle3_30points');
        successCount++;
        logger.log('📰', `已完成第 ${i}/${targetArticles} 篇新闻阅读打卡`, '', this.account.name);
        await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2000));
      } catch (e) {
        logger.log('⚠️', `第 ${i} 篇新闻上报异常: ${e.message}`, '', this.account.name);
      }
    }

    if (successCount > 0) {
      logger.log('✅', `新闻资讯阅读任务结束，共成功上报 ${successCount}/${targetArticles} 篇`, '', this.account.name);
    } else {
      logger.log('⚠️', `新闻资讯阅读任务未上报成功 (需确认移动端 Token 授权是否有效)`, '', this.account.name);
    }
    return { success: successCount > 0, count: successCount };
  }
}
