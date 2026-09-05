export class RunNotifications {
    constructor({ history, notifier, now = Date.now }) {
        this.history = history
        this.notifier = notifier
        this.now = now
        this.pending = new Map()
        this.busy = false
        this.lastError = null
    }

    enqueue(keys) {
        for (const key of keys) {
            if (!this.pending.has(key) && !this.history.wasNotified('run:' + key))
                this.pending.set(key, { attempts: 0, nextAt: 0 })
        }
    }

    status() {
        return {
            pending: [...this.pending.values()].filter(item => item.attempts < 3).length,
            failed: [...this.pending.values()].filter(item => item.attempts >= 3).length,
            sending: this.busy,
            lastError: this.lastError
        }
    }

    async drain() {
        if (this.busy || !this.notifier.configured()) return
        this.busy = true
        try {
            for (const [key, item] of this.pending) {
                if (!this.notifier.configured()) break
                if (this.history.wasNotified('run:' + key)) {
                    this.pending.delete(key)
                    continue
                }
                if (item.attempts >= 3 || item.nextAt > this.now()) continue
                const run = this.history.getRun(key)
                if (!run) {
                    this.pending.delete(key)
                    continue
                }
                item.attempts++
                try {
                    const result = await this.notifier.sendRun(run)
                    if (!result?.sent) {
                        item.attempts--
                        break
                    }
                    this.history.recordNotification('run:' + key, 'run')
                    this.pending.delete(key)
                    this.lastError = null
                } catch {
                    item.nextAt = this.now() + (item.attempts === 1 ? 60000 : 300000)
                    this.lastError =
                        item.attempts >= 3 ? '运行通知发送失败，已停止自动重试' : '运行通知发送失败，稍后自动重试'
                }
            }
        } catch {
            this.lastError = '运行通知队列处理失败，稍后重试'
        } finally {
            this.busy = false
        }
    }
}
