import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAdminCredentials,
  hashAdminPassword,
  verifyAdminPassword,
  createAdminSessionToken,
  verifyAdminSessionToken
} from '../src/identity/adminAuth.js';
import { createServer } from '../src/web/server.js';
import http from 'http';

test('adminAuth 密码哈希与会话签名验证', async () => {
  // 1. 凭据校验
  const validName = validateAdminCredentials('admin_test', '12345678', '12345678');
  assert.equal(validName, 'admin_test');

  // 密码不一致抛出异常
  assert.throws(() => validateAdminCredentials('admin', '12345678', '87654321'), /不一致/);

  // 2. 密码哈希与比对
  const { salt, passwordHash } = await hashAdminPassword('my_secret_pass');
  const ok = await verifyAdminPassword('my_secret_pass', salt, passwordHash);
  assert.equal(ok, true);

  const wrong = await verifyAdminPassword('wrong_pass', salt, passwordHash);
  assert.equal(wrong, false);

  // 3. 会话令牌签名与验签
  const secret = 'super_secret_key_123';
  const token = createAdminSessionToken('admin_user', secret);
  assert.ok(token.includes('.'));

  const payload = verifyAdminSessionToken(token, secret);
  assert.equal(payload.username, 'admin_user');

  // 篡改验签失败
  assert.equal(verifyAdminSessionToken(token + 'tamper', secret), null);
  assert.equal(verifyAdminSessionToken(token, 'different_secret'), null);
});

test('安全网关：未登录无法访问受保护 API', async () => {
  const app = createServer();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 状态接口属于公开端点，应返回 200
    const statusRes = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
    assert.equal(statusRes.status, 200);

    // 未携带会话 Cookie 访问受保护的 /api/status 应被硬拦截 (返回 401)
    const protectedRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(protectedRes.status, 401);
    const errData = await protectedRes.json();
    assert.equal(errData.success, false);
  } finally {
    server.close();
  }
});
