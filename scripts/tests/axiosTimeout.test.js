const assert = require('node:assert/strict')
const AxiosClient = require('../../dist/util/Axios').default

;(async () => {
    let attempts = 0
    const client = new AxiosClient({})
    await assert.rejects(() =>
        client.requestOnce(
            {
                url: 'https://example.invalid/dashboard',
                adapter: async config => {
                    attempts += 1
                    assert.equal(config.timeout, 25)
                    const error = new Error('synthetic timeout')
                    error.code = 'ECONNABORTED'
                    throw error
                }
            },
            25
        )
    )
    assert.equal(attempts, 1)
    console.log('axiosTimeout.test.js passed')
})().catch(error => {
    console.error(error)
    process.exit(1)
})
