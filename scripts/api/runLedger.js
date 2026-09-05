import { CryptoVault } from './cryptoVault.js'
import { interruptTasks } from './taskEvents.js'

export class RunLedger {
    constructor({ keyFile, dataFile, limit = 100 }) {
        this.vault = new CryptoVault({ keyFile, dataFile })
        this.limit = limit
        this.data = { version: 1, active: null, runs: [] }
        if (!this.vault.available()) return
        this.data = this.vault.read(this.data)
        if (this.data?.version !== 1 || !Array.isArray(this.data.runs)) {
            throw new Error('Encrypted run ledger is invalid.')
        }
        if (this.data.active) {
            const endedAt = new Date().toISOString()
            this.data.runs.unshift({
                ...interruptTasks(this.data.active),
                endedAt,
                exit: { code: null, signal: null, at: endedAt, error: 'Core service restarted before run completion.' }
            })
            this.data.active = null
            this.data.runs = this.data.runs.slice(0, this.limit)
            this.save()
        }
    }

    available() {
        return this.vault.available()
    }

    save() {
        if (this.available()) this.vault.write(this.data)
    }

    begin(run) {
        if (!this.available()) return
        this.data.active = structuredClone(run)
        this.save()
    }

    update(run) {
        if (!this.available()) return
        this.data.active = structuredClone(run)
        this.save()
    }

    finish(run) {
        if (!this.available()) return
        this.data.active = null
        this.data.runs.unshift(structuredClone(run))
        this.data.runs = this.data.runs.slice(0, this.limit)
        this.save()
    }

    history() {
        return this.available() ? structuredClone(this.data.runs) : []
    }
}
