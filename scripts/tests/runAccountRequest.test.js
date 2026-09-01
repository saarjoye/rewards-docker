const assert = require('node:assert/strict')
const { buildRunAccountEnvironment, resolveRunAccountRequest } = require('../../dist/util/RunAccountRequest')

assert.deepEqual(resolveRunAccountRequest('continue', undefined, 3), {
    accountMode: 'continue',
    accountIndex: undefined
})
assert.deepEqual(resolveRunAccountRequest('continue', 2, 3), {
    accountMode: 'account',
    accountIndex: 2
})
assert.deepEqual(resolveRunAccountRequest('account', 1, 3), {
    accountMode: 'account',
    accountIndex: 1
})
assert.deepEqual(resolveRunAccountRequest('account', 3, 3), {
    accountMode: 'account',
    accountIndex: 3
})
for (const invalidIndex of [0, -1, 4]) {
    assert.throws(() => resolveRunAccountRequest('account', invalidIndex, 3), /1\.\.3/)
}

assert.deepEqual(buildRunAccountEnvironment('account', 2), {
    RUN_ACCOUNT_MODE: 'account',
    RUN_ACCOUNT_INDEX: '2'
})
assert.deepEqual(buildRunAccountEnvironment('continue', 2), {
    RUN_ACCOUNT_MODE: 'continue'
})

console.log('runAccountRequest.test.js passed')
