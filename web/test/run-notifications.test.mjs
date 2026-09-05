import assert from 'node:assert/strict'
import test from 'node:test'
import { RunNotifications } from '../src/run-notifications.mjs'

function fixture(sendRun = async () => ({ sent: true })) {
    const sent = new Set()
    let now = 0
    const notifier = {
        enabled: true,
        configured() {
            return this.enabled
        },
        sendRun
    }
    const queue = new RunNotifications({
        notifier,
        now: () => now,
        history: {
            wasNotified: key => sent.has(key),
            getRun: id => ({ id }),
            recordNotification: key => sent.add(key)
        }
    })
    return {
        queue,
        notifier,
        sent,
        advance: milliseconds => {
            now += milliseconds
        }
    }
}

test('newly imported run waits for configuration and sends on a later refresh', async () => {
    const f = fixture()
    f.notifier.enabled = false
    f.queue.enqueue(['synthetic-run'])
    await f.queue.drain()
    assert.equal(f.sent.size, 0)
    assert.equal(f.queue.status().pending, 1)
    f.notifier.enabled = true
    await f.queue.drain()
    assert.equal(f.sent.size, 1)
    f.queue.enqueue(['synthetic-run'])
    await f.queue.drain()
    assert.equal(f.queue.status().pending, 0)
})

test('notification failures retry with a bound and expose failure instead of being discarded', async () => {
    let calls = 0
    const f = fixture(async () => {
        calls++
        throw new Error('synthetic send failure')
    })
    f.queue.enqueue(['synthetic-run'])
    await f.queue.drain()
    await f.queue.drain()
    assert.equal(calls, 1)
    f.advance(60000)
    await f.queue.drain()
    f.advance(300000)
    await f.queue.drain()
    f.advance(300000)
    await f.queue.drain()
    assert.equal(calls, 3)
    assert.equal(f.queue.status().failed, 1)
    assert.equal(f.sent.size, 0)
    assert.match(f.queue.status().lastError, /已停止/)
})

test('overlapping refreshes cannot send the same run concurrently', async () => {
    let release
    let calls = 0
    const f = fixture(async () => {
        calls++
        await new Promise(resolve => {
            release = resolve
        })
        return { sent: true }
    })
    f.queue.enqueue(['synthetic-run'])
    const running = f.queue.drain()
    await f.queue.drain()
    assert.equal(calls, 1)
    release()
    await running
    assert.equal(f.sent.size, 1)
})

test('not-sent result is never recorded as a successful delivery', async () => {
    const f = fixture(async () => ({ sent: false, reason: 'not-configured' }))
    f.queue.enqueue(['synthetic-run'])
    await f.queue.drain()
    assert.equal(f.sent.size, 0)
    assert.equal(f.queue.status().pending, 1)
})
