import assert from 'node:assert/strict'
import test from 'node:test'

import { maskEmail, sanitizeLog, sanitizeText } from '../src/security.mjs'

test('masks email and common authentication material', () => {
    assert.equal(maskEmail('person@example.com'), 'p***@e***.com')
    const value = sanitizeText(
        'person@example.com Authorization: Bearer abcdefghijklmnop token=abcdefghijklmnop cookie=sessionvalue 192.168.1.10'
    )
    assert.doesNotMatch(value, /person@example\.com/)
    assert.doesNotMatch(value, /abcdefghijklmnop/)
    assert.doesNotMatch(value, /192\.168\.1\.10/)
    assert.match(value, /\[REDACTED\]/)
})

test('returns a constrained structured log without raw content', () => {
    const log = sanitizeLog({
        id: 3,
        level: 'error',
        title: 'ACCOUNT-ERROR',
        platform: 'DESKTOP',
        message: 'person@example.com failed token=abcdefghijklmnop',
        raw: 'raw secret',
        extra: 'ignored'
    })
    assert.equal(log.id, 3)
    assert.equal(log.level, 'error')
    assert.equal('raw' in log, false)
    assert.equal('extra' in log, false)
    assert.doesNotMatch(log.message, /person@example\.com|abcdefghijklmnop/)
})
