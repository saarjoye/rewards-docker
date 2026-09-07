export class ScheduleController {
    constructor({ read, start, busy, now = () => new Date() }) {
        Object.assign(this, { read, start, busy, now })
        this.queued = false
        this.last = null
        this.lastMinute = null
        this.activeRunId = null
        this.lastRun = null
    }

    status() {
        return { queued: this.queued, lastTrigger: this.last, lastRun: this.lastRun }
    }

    record(result, code = null) {
        this.last = { at: this.now().toISOString(), result, code }
        return this.status()
    }

    cancel() {
        this.queued = false
    }

    trigger() {
        const config = this.read()
        if (!config.enabled) return this.record('disabled')
        const minute = Math.floor(this.now().getTime() / 60000)
        if (minute === this.lastMinute) return this.status()
        this.lastMinute = minute
        if (this.busy()) {
            if (config.skipIfRunning) return this.record('skipped')
            this.queued = true
            return this.record('queued')
        }
        return this.execute(config)
    }

    execute(config) {
        try {
            this.activeRunId = this.start(config)?.runId ?? null
            return this.record('started')
        } catch {
            return this.record('failed', 'SCHEDULE_START_FAILED')
        }
    }

    drain() {
        if (!this.queued || this.busy()) return
        this.queued = false
        try {
            const config = this.read()
            if (config.enabled) this.execute(config)
        } catch {
            this.record('failed', 'SCHEDULE_READ_FAILED')
        }
    }

    finished(record) {
        if (!this.activeRunId || record?.id !== this.activeRunId) return
        const accounts = record.run?.accounts || []
        const statuses = accounts.map(account => account.status)
        const result = statuses.includes('failed')
            ? 'failed'
            : statuses.includes('interrupted')
              ? 'interrupted'
              : statuses.length && statuses.every(status => status === 'completed')
                ? 'completed'
                : 'partial'
        this.lastRun = { at: record.endedAt, result }
        this.activeRunId = null
    }
}
