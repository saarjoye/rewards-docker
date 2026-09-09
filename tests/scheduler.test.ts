import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Scheduler } from '../src/orchestration/Scheduler.js'

describe('daily scheduling', () => {
  it('defaults to Shanghai 07:00 and persists edits across recreation without running on save', () => {
    const db = new DatabaseSync(':memory:')
    const run = vi.fn(async () => {})
    const scheduler = new Scheduler(db)
    scheduler.start(run)
    try {
      expect(scheduler.status()).toMatchObject({ time: '07:00', timezone: 'Asia/Shanghai' })
      scheduler.save({ enabled: true, time: '23:45' })
      const next = new Date(scheduler.status().nextRunAt ?? '')
      expect(next.getUTCHours()).toBe(15)
      expect(next.getUTCMinutes()).toBe(45)
      expect(run).not.toHaveBeenCalled()
      scheduler.stop()
      const restored = new Scheduler(db, '0 1 * * *')
      expect(restored.status().time).toBe('23:45')
      restored.start(run)
      restored.save({ enabled: false, time: '23:45' })
      expect(restored.status().nextRunAt).toBeNull()
      restored.stop()
      expect(new Scheduler(db).status().enabled).toBe(false)
    } finally {
      scheduler.stop()
      db.close()
    }
  })
  it('rejects invalid settings without replacing the current schedule', () => {
    const db = new DatabaseSync(':memory:')
    const scheduler = new Scheduler(db)
    try {
      expect(() => scheduler.save({ enabled: true, time: '24:00' })).toThrow()
      expect(scheduler.status().time).toBe('07:00')
      db.exec('DROP TABLE schedule_settings')
      expect(() => scheduler.save({ enabled: false, time: '09:00' })).toThrow()
      expect(scheduler.status().enabled).toBe(true)
    } finally {
      scheduler.stop()
      db.close()
    }
  })
  it('coalesces simultaneous triggers and contains active-run and execution errors', async () => {
    const db = new DatabaseSync(':memory:')
    const scheduler = new Scheduler(db)
    let resolve!: () => void
    const run = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    scheduler.start(run)
    try {
      const first = scheduler.trigger()
      await scheduler.trigger()
      expect(run).toHaveBeenCalledTimes(1)
      resolve()
      await first
      scheduler.start(async () => {
        await Promise.resolve()
        throw Object.assign(new Error(), { name: 'RunAlreadyActiveError' })
      })
      await scheduler.trigger()
      expect(scheduler.status().lastResult).toBe('busy')
      scheduler.start(async () => {
        await Promise.resolve()
        throw new Error('synthetic')
      })
      await scheduler.trigger()
      expect(scheduler.status().lastResult).toBe('failed')
    } finally {
      scheduler.stop()
      db.close()
    }
  })
})
