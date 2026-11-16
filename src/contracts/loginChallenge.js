/**
 * 登录拦截页分类。
 *
 * 微软登录在密码之后可能出现的「拦路虎」不止一种，之前统一报成 needs_2fa，
 * 导致排查时误判。实测（2026-11-16，putian163@qq.com）：
 *   账号并没有开 2FA，只是要求「邮箱验证码」。
 *
 * 这里按页面文案区分：
 *   - email_code：需要邮箱验证码（可人工输入，或后续接 IMAP 自动读取）
 *   - authenticator：需要 Authenticator 批准/输入动态码（真 2FA）
 *   - sms：需要短信验证码
 *   - password_wrong：密码错误
 */

const EMAIL_HINTS = [
  '验证你的电子邮件',
  '验证你的邮箱',
  '电子邮件验证',
  '邮箱验证',
  '验证码已发送至',
  '我们已向',
  '发送代码到',
  '发送验证码',
  '获取验证码',
  '查看你的电子邮件',
  '检查你的电子邮件',
  'verify your email',
  'email code',
  'enter the code we sent',
  'code sent to'
];

const AUTHENTICATOR_HINTS = [
  '在应用中批准',
  '在 authenticator 应用中',
  'authenticator',
  '双重验证',
  '双因素',
  'two-step verification'
];

const SMS_HINTS = ['检查你的短信', '短信验证码', 'text message', 'sms code'];

const PASSWORD_HINTS = ['密码不正确', '此密码不是你的', 'incorrect password', "that password isn't right"];

function hit(text, hints) {
  const lower = String(text || '').toLowerCase();
  return hints.some((h) => lower.includes(String(h).toLowerCase()));
}

export function classifyLoginChallenge(pageText = '') {
  const text = String(pageText || '');
  if (hit(text, PASSWORD_HINTS)) {
    return { status: 'password_wrong', message: '微软提示：账号密码不正确，请核对配置' };
  }
  if (hit(text, EMAIL_HINTS)) {
    return {
      status: 'needs_email_code',
      message: '需要邮箱验证码：微软已把验证码发到该账号邮箱，请在邮箱收取后手动填入（或在设置里配置邮箱 IMAP 以自动读取）'
    };
  }
  if (hit(text, AUTHENTICATOR_HINTS)) {
    return { status: 'needs_2fa', message: '账号需要 Authenticator 批准或动态验证码（真 2FA）' };
  }
  if (hit(text, SMS_HINTS)) {
    return { status: 'needs_sms_code', message: '账号需要短信验证码' };
  }
  return null;
}

/** 是否为需要人工介入的登录拦截 */
export function isManualLoginChallenge(challenge) {
  return Boolean(challenge && challenge.status);
}

/** 给界面/日志用的中文短标签 */
export function describeLoginChallenge(challenge) {
  if (!challenge) return '';
  const map = {
    password_wrong: '密码错误',
    needs_email_code: '需邮箱验证码',
    needs_2fa: '需 Authenticator（2FA）',
    needs_sms_code: '需短信验证码'
  };
  return map[challenge.status] || challenge.status;
}
