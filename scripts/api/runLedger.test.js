import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { RunLedger } from './runLedger.js'

test('recovers an interrupted encrypted run after a core restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-run-ledger-'))
    const keyFile = path.join(dir, 'key')
    const dataFile = path.join(dir, 'runs.enc.json')
    fs.writeFileSync(keyFile, Buffer.alloc(32, 11))
    try {
        const ledger = new RunLedger({ keyFile, dataFile })
        ledger.begin({ id: 'run-1', startedAt: '2026-09-05T01:00:00.000Z', run: { collected: 8, accounts: [] } })
        assert.doesNotMatch(fs.readFileSync(dataFile, 'utf8'), /run-1|collected/)

        const recovered = new RunLedger({ keyFile, dataFile })
        const history = recovered.history()
        assert.equal(history.length, 1)
        assert.equal(history[0].id, 'run-1')
        assert.match(history[0].exit.error, /restarted/)
        assert.ok(history[0].endedAt)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
