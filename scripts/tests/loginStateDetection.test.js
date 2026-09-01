const assert = require('node:assert/strict')
const { LoginStateError, selectDetectedLoginState } = require('../../dist/browser/auth/Login')

assert.equal(selectDetectedLoginState(['PASSWORD_INPUT', 'ERROR_ALERT']), 'ERROR_ALERT')
assert.equal(selectDetectedLoginState(['2FA_TOTP', 'ERROR_ALERT']), 'ERROR_ALERT')
assert.equal(selectDetectedLoginState(['EMAIL_INPUT']), 'EMAIL_INPUT')
assert.equal(selectDetectedLoginState(['PASSKEY_ERROR', 'PASSWORD_INPUT']), 'PASSKEY_ERROR')

const passkeyError = new LoginStateError('PASSKEY_ERROR', '通行密钥失败')
assert.equal(passkeyError.loginState, 'PASSKEY_ERROR')
assert.equal(passkeyError.loginStage, 'login-passkey-error')
assert.match(passkeyError.message, /通行密钥失败/)

const timeoutError = new LoginStateError('EMAIL_INPUT', '登录超时', 'login-timeout')
assert.equal(timeoutError.loginState, 'EMAIL_INPUT')
assert.equal(timeoutError.loginStage, 'login-timeout')

console.log('loginStateDetection.test.js passed')
