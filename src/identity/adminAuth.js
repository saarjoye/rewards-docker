import crypto from 'crypto';

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天保持登录
const COOKIE_NAME = 'msr_admin_session';

export function normalizeAdminUsername(value) {
  return String(value || '').trim();
}

export function validateAdminCredentials(username, password, confirmPassword = password) {
  const name = normalizeAdminUsername(username);
  if (name.length < 3 || name.length > 64) {
    throw new Error('管理员账号长度需为 3-64 个字符');
  }
  if (!/^[\w.@-]+$/.test(name)) {
    throw new Error('账号仅支持字母、数字、下划线、点、@ 和短横线');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    throw new Error('管理员密码长度需为 6-128 个字符');
  }
  if (password !== confirmPassword) {
    throw new Error('两次输入的管理员密码不一致');
  }
  return name;
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashAdminPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(String(password), salt);
  return { salt, passwordHash: derived.toString('hex') };
}

export async function verifyAdminPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  try {
    const actual = await scryptAsync(String(password), salt);
    const expected = Buffer.from(String(expectedHash), 'hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function signSessionPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createAdminSessionToken(username, secret) {
  if (!secret) throw new Error('缺少会话签名密钥');
  const payload = Buffer.from(
    JSON.stringify({
      username,
      exp: Date.now() + SESSION_TTL_MS,
      nonce: crypto.randomBytes(16).toString('hex')
    })
  ).toString('base64url');
  return `${payload}.${signSessionPayload(payload, secret)}`;
}

export function verifyAdminSessionToken(token, secret) {
  if (!secret || !token) return null;
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = signSessionPayload(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  });
  return cookies;
}

export function getAdminSessionCookieName() {
  return COOKIE_NAME;
}

export function buildAdminSessionCookie(token, req = null) {
  const secure = req?.secure || req?.headers?.['x-forwarded-proto'] === 'https';
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildAdminLogoutCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
