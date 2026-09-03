import assert from 'node:assert/strict'
import test from 'node:test'

import { ControlApiClient, ControlApiError, parseSseFrame } from '../src/control-client.mjs'

test('parses named SSE frames', () => {
    assert.deepEqual(parseSseFrame('id: 7\nevent: log\ndata: {"message":"ok"}'), {
        event: 'log',
        id: '7',
        data: { message: 'ok' }
    })
    assert.equal(parseSseFrame(': ping'), null)
})

test('keeps bearer token server-side and serializes JSON', async () => {
    let seen
    const client = new ControlApiClient({
        baseUrl: 'http://core:3010',
        token: 'server-only-token',
        fetchImpl: async (url, options) => {
            seen = { url, options }
            return new Response('{"started":true}', { status: 202, headers: { 'Content-Type': 'application/json' } })
        }
    })
    const result = await client.post('/start', { accountIndex: 2 })
    assert.equal(result.started, true)
    assert.equal(seen.options.headers.Authorization, 'Bearer server-only-token')
    assert.deepEqual(JSON.parse(seen.options.body), { accountIndex: 2 })
})

test('normalizes upstream errors', async () => {
    const client = new ControlApiClient({
        baseUrl: 'http://core:3010',
        token: 'token',
        fetchImpl: async () => new Response('{"error":"busy","code":"ALREADY_RUNNING"}', { status: 409 })
    })
    await assert.rejects(client.post('/start', {}), error => {
        assert.ok(error instanceof ControlApiError)
        assert.equal(error.code, 'ALREADY_RUNNING')
        assert.equal(error.status, 409)
        return true
    })
})
