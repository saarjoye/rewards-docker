import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'patchright'
import { DashboardClient } from '../src/browser/DashboardClient.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'

describe('App dashboard balance observation', () => {
  it('does not publish missing balances and always disposes malformed responses', async () => {
    const dispose = vi.fn()
    const get = vi
      .fn()
      .mockResolvedValueOnce({ ok: () => true, text: () => Promise.resolve('{"response":{}}'), dispose })
      .mockResolvedValueOnce({ ok: () => true, text: () => Promise.resolve('invalid'), dispose })
    const observed = vi.fn()
    const client = new DashboardClient(
      { request: { get } } as unknown as BrowserContext,
      {} as Page,
      {} as StructuredLogger,
      'synthetic-run',
      'synthetic-account',
      observed
    )
    await client.fetchAppDashboard('synthetic-test-value')
    await expect(client.fetchAppDashboard('synthetic-test-value')).rejects.toThrow()
    expect(observed).not.toHaveBeenCalled()
    expect(client.latestObservation).toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(2)
  })
  it.each([0, 5088])(
    'publishes reliable balance %s using only the existing request',
    async (balance) => {
      const dispose = vi.fn()
      const get = vi.fn().mockResolvedValue({
        ok: () => true,
        text: () => Promise.resolve(JSON.stringify({ response: { balance } })),
        dispose
      })
      const observed = vi.fn()
      const client = new DashboardClient(
        { request: { get } } as unknown as BrowserContext,
        {} as Page,
        {} as StructuredLogger,
        'synthetic-run',
        'synthetic-account',
        observed
      )
      const result = await client.fetchAppDashboard('synthetic-test-value')
      expect(observed).toHaveBeenCalledExactlyOnceWith(result)
      expect(result.availablePoints.value).toBe(balance)
      expect(client.latestObservation).toBe(result)
      expect(get).toHaveBeenCalledTimes(1)
      expect(dispose).toHaveBeenCalledTimes(1)
    }
  )
})
