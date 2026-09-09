import { Cron } from 'croner'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

export const scheduleInput = z
  .object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
  .strict()

export class Scheduler {
  private job: Cron | undefined
  private running = false
  private run: (() => Promise<void>) | undefined
  private settings = { enabled: true, time: '07:00', pattern: '0 7 * * *' }
  private lastResult: 'started' | 'busy' | 'failed' | null = null

  constructor(
    private readonly db: DatabaseSync,
    fallback = '0 7 * * *'
  ) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS schedule_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL,
        time TEXT NOT NULL, pattern TEXT NOT NULL)`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    const saved = db
      .prepare('SELECT enabled,time,pattern FROM schedule_settings WHERE id=1')
      .get() as { enabled: number; time: string; pattern: string } | undefined
    if (saved) this.settings = { ...saved, enabled: Boolean(saved.enabled) }
    else {
      const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(fallback)
      this.settings = {
        enabled: true,
        pattern: fallback,
        time:
          match?.[2] && match[1] ? `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}` : ''
      }
    }
  }

  status() {
    return {
      ...this.settings,
      timezone: 'Asia/Shanghai',
      nextRunAt: this.job?.nextRun()?.toISOString() ?? null,
      lastResult: this.lastResult
    }
  }

  start(run: () => Promise<void>): void {
    this.run = run
    this.replace()
  }

  async trigger(): Promise<void> {
    if (this.running || !this.settings.enabled || !this.run) return
    this.running = true
    try {
      await this.run()
      this.lastResult = 'started'
    } catch (error) {
      this.lastResult =
        error instanceof Error && error.name === 'RunAlreadyActiveError' ? 'busy' : 'failed'
    } finally {
      this.running = false
    }
  }

  save(input: z.infer<typeof scheduleInput>) {
    const value = scheduleInput.parse(input)
    const [hour = 7, minute = 0] = value.time.split(':').map(Number)
    const next = { ...value, pattern: `${String(minute)} ${String(hour)} * * *` }
    this.db
      .prepare(
        `INSERT INTO schedule_settings (id,enabled,time,pattern) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,time=excluded.time,pattern=excluded.pattern`
      )
      .run(Number(next.enabled), next.time, next.pattern)
    this.settings = next
    this.replace()
    return this.status()
  }

  private replace(): void {
    const next =
      this.settings.enabled && this.run
        ? new Cron(this.settings.pattern, { timezone: 'Asia/Shanghai' }, () => this.trigger())
        : undefined
    this.job?.stop()
    this.job = next
  }

  stop(): void {
    this.job?.stop()
    this.job = undefined
    this.run = undefined
  }
}
