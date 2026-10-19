import networkClient from '../network.js';
import logger from '../logger.js';

export const AUTH_CONFIG = {
  clientId: '0000000040170455',
  scope: 'service::prod.rewardsplatform.microsoft.com::MBI_SSL',
  redirectUri: 'https://login.live.com/oauth20_desktop.srf',
  authorizeUrl: 'https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf',
  tokenUrl: 'https://login.live.com/oauth20_token.srf'
};

export const USER_AGENTS = {
  pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  app: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36 BingApp/32.6.2110003560'
};

export function normalizeCid(cid) {
  if (!cid) return '';
  return String(cid).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().replace(/^0+/, '');
}

export function normalizeRuid(ruid) {
  if (!ruid) return '';
  const text = String(ruid).trim().toUpperCase();
  return text.replace(/^(?:HK|USW|US|EU|SG|JP|AU|CN|IN|EA|CANARY)-/, '');
}

export function parseWlsInfo(cookies = []) {
  if (!Array.isArray(cookies)) return { cid: '', name: '' };
  const wlsCookie = cookies.find((c) => c.name === 'WLS');
  if (!wlsCookie || !wlsCookie.value) return { cid: '', name: '' };

  const val = decodeURIComponent(wlsCookie.value);
  let cid = '';
  let name = '';

  const cMatch = val.match(/(?:^|&)C=([^&]+)/i);
  if (cMatch) cid = cMatch[1];

  const nMatch = val.match(/(?:^|&)N=([^&]+)/i);
  if (nMatch) {
    try {
      name = decodeURIComponent(nMatch[1]);
    } catch {
      name = nMatch[1];
    }
  }

  return { cid, name };
}

export function verifyIdentityConsistency(cookieCid, oauthUserId) {
  const normCookie = normalizeCid(cookieCid);
  const normOauth = normalizeCid(oauthUserId);

  if (!normCookie || !normOauth) {
    return { match: true, partial: true, message: '单边凭据或未完全提取，跳过严格同源比对' };
  }

  if (normCookie === normOauth) {
    return { match: true, partial: false, cid: normCookie, message: '双通道凭据 CID 完美匹配' };
  }

  return {
    match: false,
    partial: false,
    cookieCid: normCookie,
    oauthUserId: normOauth,
    message: `双通道身份冲突！Cookie CID [${normCookie}] 与 Token UserID [${normOauth}] 不属于同一账号！`
  };
}

/**
 * 用授权码兑换访问令牌与刷新令牌
 */
export async function exchangeCodeForToken(codeOrUrl, proxy = '') {
  let code = codeOrUrl;
  if (code.includes('code=')) {
    const m = code.match(/[?&]code=([^&#]+)/);
    code = m ? decodeURIComponent(m[1]) : code;
  }

  const params = new URLSearchParams({
    client_id: AUTH_CONFIG.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: AUTH_CONFIG.redirectUri
  });

  const res = await networkClient.request({
    url: AUTH_CONFIG.tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: params.toString(),
    proxy
  });

  const data = typeof res === 'string' ? JSON.parse(res) : res;
  if (data.error) {
    throw new Error(`Token exchange failed: ${data.error} - ${data.error_description || ''}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    userId: data.user_id,
    obtainedAt: Date.now()
  };
}

/**
 * 用 refresh_token 刷新访问令牌
 */
export async function refreshAccessToken(refreshToken, proxy = '') {
  if (!refreshToken) throw new Error('Missing refresh token');

  const params = new URLSearchParams({
    client_id: AUTH_CONFIG.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: AUTH_CONFIG.scope
  });

  const res = await networkClient.request({
    url: AUTH_CONFIG.tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: params.toString(),
    proxy
  });

  const data = typeof res === 'string' ? JSON.parse(res) : res;
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error} - ${data.error_description || ''}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
    userId: data.user_id,
    obtainedAt: Date.now()
  };
}
