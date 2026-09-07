import assert from 'node:assert/strict'
import test from 'node:test'
import { SearchProgress } from '../../dist/functions/activities/search/SearchProgress.js'

const progress = () => new SearchProgress({})

test('mobile quota accepts dashboard aliases and preserves a valid zero separately from missing data', () => {
    const tool = progress()
    const missing = tool.calculateQuotas({}).mobile
    assert.equal(missing.known, false)
    assert.equal(missing.reason, 'missing')
    assert.equal(missing.source, 'dashboard-counter')

    const alias = tool.calculateQuotas({ MobileSearch: [{ pointProgress: 0, pointProgressMax: 0 }] }).mobile
    assert.equal(alias.known, true)
    assert.equal(alias.remaining, 0)
    assert.equal(alias.reason, 'valid')
})

test('invalid mobile counters never become a completed 0/0', () => {
    const quota = progress().calculateQuotas({ mobileSearch: [{ pointProgress: 'bad', pointProgressMax: 60 }] }).mobile
    assert.equal(quota.known, false)
    assert.equal(quota.reason, 'invalid')
    assert.equal(quota.remaining, 0)
})
