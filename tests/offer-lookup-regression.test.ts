import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'patchright'
import { DashboardClient } from '../src/browser/DashboardClient.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import {
  MutationExecutor,
  OfferUnavailableError,
  OfferActivationError
} from '../src/orchestration/MutationExecutor.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'
import { publicText, taskFailure } from '../src/domain/Presentation.js'
import type { TaskRecord } from '../src/domain/Task.js'

const target = 'https://www.bing.com/search?q=synthetic&filters=offer'
const task: TaskRecord = {
  taskId: 'task',
  accountId: 'account',
  sourceTaskId: 'offer',
  localDate: '2026-09-10',
  source: 'rsc',
  type: 'daily-set',
  displayName: 'Synthetic',
  executable: true,
  required: true,
  status: 'running',
  progress: { completed: 0, total: 1 },
  updatedAt: '2026-09-10T00:00:00Z'
}
function fixture() {
  let url = 'https://rewards.bing.com/earn'
  const click = vi.fn().mockResolvedValue(undefined)
  const anchor = {
    evaluate: vi.fn().mockResolvedValue({ href: target }),
    getAttribute: vi.fn().mockResolvedValue(null),
    click,
    dispose: vi.fn().mockResolvedValue(undefined)
  }
  const links = {
    evaluateAll: vi.fn().mockResolvedValue([{ href: target }]),
    nth: vi.fn().mockReturnValue({ elementHandle: vi.fn().mockResolvedValue(anchor) })
  }
  const trigger = { first: vi.fn().mockReturnThis(), count: vi.fn().mockResolvedValue(0) }
  const page = {
    url: vi.fn(() => url),
    goto: vi.fn((next: string) => {
      url = next
      return Promise.resolve(null)
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    frames: vi.fn().mockReturnValue([]),
    locator: vi.fn((selector: string) => (selector === 'a[href]' ? links : trigger))
  }
  const write = vi.fn().mockResolvedValue(undefined)
  const client = new DashboardClient(
    {} as BrowserContext,
    page as unknown as Page,
    { write } as unknown as StructuredLogger,
    'run',
    'account-1'
  )
  return { client, page, links, anchor, click, write }
}

describe('bounded pre-activation lookup', () => {
  it('waits for late cards and activates exactly once', async () => {
    const f = fixture()
    f.links.evaluateAll.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await f.client.navigateOffer(target)
    expect(f.links.evaluateAll).toHaveBeenCalledTimes(3)
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(f.page.waitForTimeout).toHaveBeenCalledWith(250)
  })
  it('rediscovers all surfaces at most twice, without navigating directly to the destination', async () => {
    const f = fixture()
    f.links.evaluateAll.mockResolvedValue([])
    await expect(f.client.openOfferForInteraction(target)).rejects.toMatchObject({
      errorCode: 'offer-not-found-before-activation'
    })
    expect(f.click).not.toHaveBeenCalled()
    expect(f.page.goto).toHaveBeenCalledTimes(5)
    expect(f.page.goto.mock.calls.every(([url]) => url !== target)).toBe(true)
    expect(JSON.stringify(f.write.mock.calls)).not.toContain('q=synthetic')
  })
  it('rejects a node replaced between indexing and binding, then binds the right node', async () => {
    const f = fixture()
    f.anchor.evaluate.mockResolvedValueOnce({ href: 'https://www.bing.com/search?q=unrelated' })
    await f.client.openOfferForInteraction(target)
    expect(f.links.evaluateAll).toHaveBeenCalledTimes(2)
    expect(f.anchor.dispose).toHaveBeenCalledTimes(2)
    expect(f.click).toHaveBeenCalledTimes(1)
  })
  it('never retries activation with an unknown click result', async () => {
    const f = fixture()
    f.click.mockRejectedValue(new Error('timeout'))
    await expect(f.client.openOfferForInteraction(target)).rejects.toBeInstanceOf(
      OfferActivationError
    )
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(f.page.goto).not.toHaveBeenCalled()
  })
  it('retains the pre-activation classification if binding preparation fails before clicking', async () => {
    const f = fixture()
    f.anchor.getAttribute.mockRejectedValue(new Error('page closed'))
    await expect(f.client.openOfferForInteraction(target)).rejects.toMatchObject({
      errorCode: 'offer-browser-failed'
    })
    expect(f.click).not.toHaveBeenCalled()
  })
  it('keeps network and authentication failures distinct from missing offers', async () => {
    const f = fixture()
    f.links.evaluateAll.mockResolvedValue([])
    f.page.goto.mockRejectedValue(new Error('network timeout'))
    await expect(f.client.openOfferForInteraction(target)).rejects.toMatchObject({
      errorCode: 'offer-network-failed'
    })
    const auth = fixture()
    auth.page.url.mockReturnValue('https://login.live.com/')
    await expect(auth.client.openOfferForInteraction(target)).rejects.toMatchObject({
      errorCode: 'offer-authentication-failed'
    })
    expect(auth.click).not.toHaveBeenCalled()
  })
  it('cancels discovery before clicking', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort(new Error('synthetic cancelled'))
    await expect(f.client.openOfferForInteraction(target, {}, controller.signal)).rejects.toThrow(
      'synthetic cancelled'
    )
    expect(f.click).not.toHaveBeenCalled()
  })
  it('recovers a transient navigation failure on rediscovery instead of marking the account failed', async () => {
    const f = fixture()
    f.links.evaluateAll.mockResolvedValue([])
    f.page.goto.mockRejectedValueOnce(new Error('network timeout'))
    await expect(f.client.openOfferForInteraction(target)).rejects.toMatchObject({
      errorCode: 'offer-not-found-before-activation'
    })
    expect(f.click).not.toHaveBeenCalled()
  })
})

describe('classification and completion evidence', () => {
  it('separates missing offers, explicit rejection and uncertain activation in the mutation ledger', async () => {
    for (const [error, code, status] of [
      [new OfferUnavailableError(), 'offer-not-found-before-activation', 'verification-pending'],
      [new OfferActivationError(), 'offer-activation-failed', 'verification-pending'],
      [null, 'offer-submission-rejected', 'failed']
    ] as const) {
      const ledger = {
        beginMutation: vi.fn().mockReturnValue(true),
        cancelMutation: vi.fn(),
        updateMutation: vi.fn()
      }
      const execute = error
        ? vi.fn().mockRejectedValue(error)
        : vi.fn().mockResolvedValue({ accepted: false, rejected: true })
      const outcome = await new MutationExecutor(ledger).execute(
        task,
        { execute, verify: vi.fn() },
        new AbortController().signal
      )
      expect(outcome).toMatchObject({ errorCode: code, status })
      expect(ledger.cancelMutation).toHaveBeenCalledTimes(
        error instanceof OfferUnavailableError ? 1 : 0
      )
    }
  })
  it('requires completed required tasks before lifecycle, view or notification can claim completion', () => {
    const store = new SqliteStore(':memory:')
    try {
      store.createRun({
        runId: 'run',
        localDate: task.localDate,
        selectedAccountIndexes: [1],
        executionMode: 'mutating',
        startedAt: task.updatedAt
      })
      store.upsertTask(
        { ...task, reason: 'offer-not-found-before-activation', status: 'verification-pending' },
        'run'
      )
      store.ledger.lifecycle({
        runId: 'run',
        accountId: task.accountId,
        accountLabel: 'Synthetic',
        accountIndex: 1,
        startedAt: task.updatedAt,
        endedAt: '2026-09-10T00:01:00Z',
        updatedAt: '2026-09-10T00:01:00Z',
        executionState: 'completed'
      })
      store.updateRun('run', 'completed', '2026-09-10T00:01:00Z')
      const view = new RunViews(store).run('run')
      expect(view).toMatchObject({ status: 'partial', accountsCompleted: 0, accountsPartial: 1 })
      expect(view?.tasks[0]).toMatchObject({
        failureLabel: '链接不可用',
        activationStarted: false,
        taskEarnedPoints: null
      })
      expect(store.getRun('run')?.status).toBe('completed')
      expect(store.ledger.accounts('run')[0]?.executionState).toBe('partial')
      expect(taskFailure('offer-not-found-before-activation').failureLabel).toBe('链接不可用')
      expect(publicText('待确认积分 未取得 未匹配')).not.toMatch(/待确认|未取得|未匹配/)
    } finally {
      store.close()
    }
  })
})
