import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLoginChallenge,
  describeLoginChallenge,
  isManualLoginChallenge
} from '../src/contracts/loginChallenge.js';

test('邮箱验证码页 → needs_email_code（不是 2FA）', () => {
  const c = classifyLoginChallenge('验证你的电子邮件 我们已向 putian163@qq.com 发送代码 请输入代码');
  assert.equal(c.status, 'needs_email_code');
  assert.match(c.message, /邮箱/);
  assert.equal(describeLoginChallenge(c), '需邮箱验证码');
});

test('Authenticator / 双因素 → needs_2fa', () => {
  const c = classifyLoginChallenge('在 Authenticator 应用中批准登录请求');
  assert.equal(c.status, 'needs_2fa');
  assert.equal(describeLoginChallenge(c), '需 Authenticator（2FA）');
});

test('短信验证码 → needs_sms_code', () => {
  const c = classifyLoginChallenge('检查你的短信，输入我们发送的验证码');
  assert.equal(c.status, 'needs_sms_code');
});

test('密码错误 → password_wrong', () => {
  const c = classifyLoginChallenge('此密码不是你的帐户密码');
  assert.equal(c.status, 'password_wrong');
});

test('普通页面不误判', () => {
  assert.equal(classifyLoginChallenge('保持登录状态?'), null);
  assert.equal(classifyLoginChallenge(''), null);
  assert.equal(isManualLoginChallenge(null), false);
  assert.equal(isManualLoginChallenge({ status: 'needs_email_code' }), true);
});

test('同时出现邮箱与输入代码时优先判定为邮箱验证码', () => {
  const c = classifyLoginChallenge('输入代码 我们已向邮箱发送验证码');
  assert.equal(c.status, 'needs_email_code');
});
