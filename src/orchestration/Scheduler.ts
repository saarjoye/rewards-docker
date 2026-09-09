import { Cron } from 'croner'

export class Scheduler {
  private job: Cron | undefined
  private running = false

  start(input: { pattern: string; timezone: string; run: () => Promise<void> }): void {
    if (this.job) throw new Error('Scheduler is already started')
    this.job = new Cron(input.pattern, { timezone: input.timezone }, async () => {
      if (this.running) return
      this.running = true
      try {
        await input.run()
      } finally {
        this.running = false
      }
    })
  }

  stop(): void {
    this.job?.stop()
    this.job = undefined
  }
}
