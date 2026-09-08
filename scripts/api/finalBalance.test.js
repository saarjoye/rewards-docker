import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { readFinalBalance } = require('../../dist/util/FinalBalance.js')

test('final balance failures never substitute a cached balance or retry a task', async () => {
    let attempts = 0, failures = 0
    const result = await readFinalBalance(async () => { attempts++; throw new Error('fixture unavailable') }, () => failures++)
    assert.equal(result, null)
    assert.equal(attempts, 1)
    assert.equal(failures, 1)
    assert.equal(await readFinalBalance(async () => 0, () => {}), 0)
    assert.equal(await readFinalBalance(async () => NaN, () => {}), null)
})
