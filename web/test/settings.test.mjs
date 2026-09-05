import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SettingsStore } from '../src/settings.mjs'
import { WeComNotifier, normalizeWeComBaseUrl } from '../src/wecom.mjs'

test('encrypts Web settings and preserves the configured WeCom reverse proxy paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-web-settings-'))
    const keyFile = path.join(dir, 'key')
    const dataFile = path.join(dir, 'settings.enc.json')
    fs.writeFileSync(keyFile, Buffer.alloc(32, 13))
    const requests = []
    const fetchImpl = async url => {
        requests.push(String(url))
        if (String(url).includes('/gettoken')) {
            return { ok: true, json: async () => ({ errcode: 0, access_token: 'synthetic-token', expires_in: 7200 }) }
        }
        return { ok: true, json: async () => ({ errcode: 0 }) }
    }
    try {
        const settings = new SettingsStore({ dataDir: dir, keyFile, dataFile })
        const notifier = new WeComNotifier({ settings, fetchImpl })
        notifier.update({
            enabled: true,
            mode: 'custom',
            baseUrl: 'https://proxy.example.com/gateway',
            corpId: 'synthetic-corp',
            agentId: '1000001',
            corpSecret: 'synthetic-secret',
            toUser: '@all'
        })
        notifier.update({
            enabled: true,
            mode: 'custom',
            baseUrl: '',
            corpId: '',
            agentId: '',
            corpSecret: '',
            toUser: ''
        })
        await notifier.sendTest()
        assert.equal(
            requests[0],
            'https://proxy.example.com/gateway/cgi-bin/gettoken?corpid=synthetic-corp&corpsecret=synthetic-secret'
        )
        assert.match(requests[1], /^https:\/\/proxy\.example\.com\/gateway\/cgi-bin\/message\/send\?access_token=/)
        assert.doesNotMatch(fs.readFileSync(dataFile, 'utf8'), /synthetic-secret|synthetic-corp/)
        assert.equal(notifier.status().hasSecret, true)
        assert.equal('corpSecret' in notifier.status(), false)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('rejects unsafe WeCom reverse proxy addresses', () => {
    assert.throws(() => normalizeWeComBaseUrl('custom', 'http://proxy.example.com'), /HTTPS/)
    assert.throws(() => normalizeWeComBaseUrl('custom', 'https://user@proxy.example.com?token=x'), /HTTPS/)
})
