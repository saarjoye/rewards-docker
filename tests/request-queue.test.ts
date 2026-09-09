import { describe, expect, it } from 'vitest'
import { createRequestQueue } from '../src/web/ui/requestQueue.js'

describe('single-flight state refresh', () => {
  it('coalesces requests and drops a superseded response', async () => {
    const pending: Array<(value: number) => void> = []
    const applied: number[] = []
    let calls = 0
    const refresh = createRequestQueue(
      () => {
        calls += 1
        return new Promise<number>((resolve) => {
          pending.push(resolve)
        })
      },
      (value) => {
        applied.push(value)
      },
      () => {
        throw new Error('unexpected failure')
      }
    )
    const first = refresh()
    void refresh()
    void refresh()
    expect(calls).toBe(1)
    pending[0]?.(1)
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(applied).toEqual([])
    pending[1]?.(2)
    await first
    expect(applied).toEqual([2])
  })
  it('recovers from a failed read without inventing a value', async () => {
    let fail = true
    let errors = 0
    const applied: number[] = []
    const refresh = createRequestQueue(
      () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve(0)),
      (value) => {
        applied.push(value)
      },
      () => {
        errors += 1
      }
    )
    await refresh()
    expect(applied).toEqual([])
    expect(errors).toBe(1)
    fail = false
    await refresh()
    expect(applied).toEqual([0])
  })
})
