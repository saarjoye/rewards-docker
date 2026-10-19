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
      throw new Error('未配置移动端 Access Token');
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

    return res;
  }

  /**
   * 移动端每日 App 签入 (Streaks 板块: 签到: 1/1)
   */
  async performAppCheckIn() {
    logger.log('📱', '正在执行必应应用连续打卡 (DAPI 网关直连签入)...', '', this.account.name);
    try {
      const res = await this.submitActivity('Gamification_Sapphire_DailyCheckIn');
      logger.log('✅', '必应移动端签到成功，已在官网点亮 [签到: 1/1]！', '', this.account.name);
      return { success: true, res };
    } catch (e) {
      // 容错备用 offerId
      try {
        const resFallback = await this.submitActivity('Gamification_DailyCheckIn');
        logger.log('✅', '必应移动端备用签到成功！', '', this.account.name);
        return { success: true, res: resFallback };
      } catch (err2) {
        logger.log('⚠️', `移动端签到请求异常: ${err2.message}`, '', this.account.name);
        return { success: false, error: err2.message };
      }
    }
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
        // 拟人化抖动间隔 (2.5 ~ 4.5 秒)
        await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2000));
      } catch (e) {
        logger.log('⚠️', `第 ${i} 篇新闻上报异常: ${e.message}`, '', this.account.name);
      }
    }

    logger.log('✅', `新闻资讯阅读任务结束，共成功上报 ${successCount}/${targetArticles} 篇`, '', this.account.name);
    return { success: true, count: successCount };
  }
}
