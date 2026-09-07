import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readSchedule, writeSchedule, isValidCron } from './scheduleStore.js'
import { ScheduleController } from './scheduleController.js'
import { handleSchedule } from './scheduleRoutes.js'

test('Core schedule routes reject missing authentication and validate writes before changing state', async () => {
    let writes = 0,
        cancelled = 0,
        response
    const options = {
        pathname: '/schedule',
        method: 'PATCH',
        authorized: false,
        writable: true,
        body: async () => ({ cron: '0 8 * * *' }),
        write: patch => {
            writes++
            return patch
        },
        read: () => ({ cron: '0 7 * * *' }),
        controller: { status: () => ({}), cancel: () => cancelled++ },
        send: (code, data) => {
            response = { code, data }
        }
    }
    await handleSchedule(options)
    assert.equal(response.code, 401)
    assert.equal(writes, 0)
    await handleSchedule({ ...options, authorized: true, writable: false })
    assert.equal(response.code, 403)
    assert.equal(writes, 0)
    await handleSchedule({ ...options, authorized: true, body: async () => [] })
    assert.equal(response.code, 400)
    assert.equal(writes, 0)
    await handleSchedule({ ...options, authorized: true })
    assert.equal(response.code, 200)
    assert.equal(writes, 1)
    assert.equal(cancelled, 1)
    await handleSchedule({ ...options, authorized: true, method: 'GET' })
    assert.equal(response.data.cron, '0 7 * * *')
})

test('legacy schedule, validation, atomic persistence and reload rollback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-schedule-'))
    const saved = process.env.SCHEDULE_FILE
    process.env.SCHEDULE_FILE = path.join(dir, 'schedule.json')
    try {
        fs.writeFileSync(
            process.env.SCHEDULE_FILE,
            JSON.stringify({ schedule: '0 7 * * *', timezone: 'Asia/Shanghai' })
        )
        assert.equal(readSchedule(dir).enabled, true)
        assert.equal(readSchedule(dir).cron, '0 7 * * *')
        for (const cron of ['60 7 * * *', '* * *', '0 7 * * *\nsh', '*/0 * * * *'])
            assert.equal(isValidCron(cron), false)
        assert.throws(() => writeSchedule(dir, { timezone: 'UTC' }), /Asia/)
        let applied
        const result = writeSchedule(
            dir,
            { cron: '5 8 * * *', skipIfRunning: false },
            {
                apply: value => {
                    applied = value
                }
            }
        )
        assert.equal(applied.cron, '5 8 * * *')
        assert.equal(result.cron, readSchedule(dir).cron)
        assert.ok(result.updatedAt)
        const original = fs.readFileSync(process.env.SCHEDULE_FILE, 'utf8')
        assert.throws(
            () =>
                writeSchedule(
                    dir,
                    { cron: '6 8 * * *' },
                    {
                        apply: value => {
                            if (value.cron === '6 8 * * *') throw new Error('synthetic')
                        }
                    }
                ),
            /恢复/
        )
        assert.equal(fs.readFileSync(process.env.SCHEDULE_FILE, 'utf8'), original)
        assert.equal(fs.readdirSync(dir).length, 1)
    } finally {
        if (saved === undefined) delete process.env.SCHEDULE_FILE
        else process.env.SCHEDULE_FILE = saved
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('busy triggers merge once, deduplicate, cancel and never start concurrently', () => {
    let running = true,
        starts = 0,
        minute = 0
    const config = { enabled: true, skipIfRunning: false }
    const options = {
        read: () => config,
        busy: () => running,
        start: () => {
            assert.equal(running, false)
            starts++
            running = true
        },
        now: () => new Date(minute * 60000)
    }
    const controller = new ScheduleController(options)
    controller.trigger()
    controller.trigger()
    minute++
    controller.trigger()
    assert.equal(controller.queued, true)
    running = false
    controller.drain()
    controller.drain()
    assert.equal(starts, 1)
    minute++
    controller.trigger()
    controller.cancel()
    running = false
    controller.drain()
    assert.equal(starts, 1)
    assert.equal(new ScheduleController(options).queued, false)
    running = true
    config.skipIfRunning = true
    minute++
    assert.equal(controller.trigger().lastTrigger.result, 'skipped')
    config.enabled = false
    minute++
    assert.equal(controller.trigger().lastTrigger.result, 'disabled')
})

test('schedule completion uses structured account outcomes and ignores unrelated runs', () => {
    const controller = new ScheduleController({
        read: () => ({ enabled: true }),
        busy: () => false,
        start: () => ({ runId: 'synthetic-run' })
    })
    controller.trigger()
    controller.finished({ id: 'different-run', exit: { code: 0 }, run: { accounts: [{ status: 'completed' }] } })
    assert.equal(controller.lastRun, null)
    controller.finished({
        id: 'synthetic-run',
        endedAt: '2026-09-07T00:00:00Z',
        exit: { code: 0 },
        run: { accounts: [{ status: 'failed' }] }
    })
    assert.equal(controller.lastRun.result, 'failed')
})
