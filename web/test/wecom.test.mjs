import assert from 'node:assert/strict'
import test from 'node:test'

import { WeComNotifier } from '../src/wecom.mjs'

test('sends a redacted Chinese run summary', async () => {
    const previous = { ...process.env }
    process.env.WEB_WECOM_ENABLED = 'true'
    process.env.WEB_WECOM_CORP_ID = 'corp'
    process.env.WEB_WECOM_AGENT_ID = '100001'
    process.env.WEB_WECOM_CORP_SECRET = 'secret'
    process.env.WEB_WECOM_TO_USER = '@all'
    const calls = []
    try {
        const notifier = new WeComNotifier({
            fetchImpl: async (url, options = {}) => {
                calls.push({ url: String(url), body: options.body })
                if (String(url).includes('gettoken')) {
                    return new Response('{"errcode":0,"access_token":"access","expires_in":7200}', { status: 200 })
                }
                return new Response('{"errcode":0,"errmsg":"ok"}', { status: 200 })
            }
        })
        await notifier.sendRun({
            status: 'completed',
            endedAt: '2026-09-03T02:00:00.000Z',
            collected: 10,
            accounts: [{ label: 'p***@e***.com', collected: 10, success: true }]
        })
        const body = JSON.parse(calls[1].body)
        assert.match(body.text.content, /任务完成/)
        assert.doesNotMatch(body.text.content, /corp|secret|access/)
    } finally {
        process.env = previous
    }
})

test('a zero error code with rejected recipients does not report a successful delivery', async () => {
    const notifier = new WeComNotifier({
        settings: {
            getWeCom: () => ({
                enabled: true,
                mode: 'direct',
                corpId: 'synthetic-corp',
                agentId: '100001',
                corpSecret: 'synthetic-secret',
                toUser: '@all'
            }),
            status: () => ({ writable: true })
        },
        wait: async () => {},
        fetchImpl: async url =>
            String(url).includes('gettoken')
                ? new Response('{"errcode":0,"access_token":"synthetic-token"}')
                : new Response('{"errcode":0,"invaliduser":"synthetic-member"}')
    })
    await assert.rejects(() => notifier.sendTest(), /接收成员/)
    assert.equal(notifier.status().lastSuccessAt, null)
    assert.match(notifier.status().lastError, /接收成员/)
    assert.doesNotMatch(JSON.stringify(notifier.status()), /synthetic-member|synthetic-secret/)
})
