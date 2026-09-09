import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { batchStatus, runOutcome } from '../src/domain/RunOutcome.js'
import { RunResultSummary } from '../src/web/ui/RunResultSummary'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'
import { Notifications } from '../src/notifications/Notifications.js'

const end = '2026-09-09T08:37:52Z'
describe('independent run outcomes and execution mode', () => {
  it('counts three partial accounts as ended, never as fully completed or failed', () => {
    const value = runOutcome(
      'partial',
      3,
      Array.from({ length: 3 }, () => ({ executionState: 'partial', endedAt: end }))
    )
    expect(value).toMatchObject({
      status: 'partial',
      accountsEnded: 3,
      accountsCompleted: 0,
      accountsPartial: 3,
      accountsFailed: 0,
      accountsNotCompleted: 3,
      allAccountsCompleted: false
    })
    const html = renderToStaticMarkup(
      createElement(RunResultSummary, { run: { ...value, executionMode: 'mutating' } })
    )
    expect(html).toContain('执行任务')
    expect(html).toContain('部分完成')
    expect(html).toContain('已结束账号</dt><dd>3/3')
    expect(html).toContain('完全完成账号</dt><dd>0/3')
    expect(html).not.toMatch(/全部完成|运行已完成|待确认/)
  })
  it('requires both the stored completed status and every selected account completed', () => {
    const completed = { executionState: 'completed', endedAt: end }
    expect(runOutcome('completed', 3, [completed, completed, completed]).runStatusLabel).toBe(
      '全部完成'
    )
    expect(runOutcome('partial', 3, [completed, completed, completed]).runStatusLabel).toBe(
      '部分完成'
    )
    expect(runOutcome('completed', 3, [completed]).runStatusLabel).toBe('部分完成')
    expect(
      runOutcome('completed', 1, [{ executionState: 'partial', endedAt: end }]).runStatusLabel
    ).toBe('部分完成')
    expect(runOutcome('running', 1, [completed]).runStatusLabel).toBe('执行中')
  })
  it('keeps failed accounts separate from partial and shares the coordinator aggregation', () => {
    const rows = ['completed', 'partial', 'failed'].map((executionState) => ({
      executionState,
      endedAt: end
    }))
    expect(runOutcome('partial', 3, rows)).toMatchObject({
      accountsEnded: 3,
      accountsCompleted: 1,
      accountsPartial: 1,
      accountsFailed: 1,
      accountsNotCompleted: 2
    })
    expect(batchStatus(['partial', 'partial', 'partial'], 3)).toBe('partial')
    expect(batchStatus(['failed', 'failed', 'failed'], 3)).toBe('failed')
    expect(batchStatus(['success', 'success', 'success'], 3)).toBe('completed')
    expect(batchStatus(['success'], 3)).toBe('partial')
  })
  it('keeps detail, calendar, frontend and notification consistent after finished_at is set', async () => {
    const store = new SqliteStore(':memory:')
    let now = Date.parse('2026-09-09T00:00:00Z')
    const send = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      await Promise.resolve()
      return new Response(
        JSON.stringify(
          typeof url === 'string' && url.includes('gettoken')
            ? { errcode: 0, access_token: 'synthetic', expires_in: 7200 }
            : { errcode: 0 }
        )
      )
    })
    const notifications = new Notifications(store, Buffer.alloc(32, 7), send, () => now)
    try {
      notifications.save({
        enabled: true,
        corpId: 'synthetic',
        agentId: '1',
        corpSecret: 'synthetic',
        toUser: '@all',
        maxAttempts: 3
      })
      now += 1000
      store.createRun({
        runId: 'run',
        localDate: '2026-09-09',
        executionMode: 'mutating',
        selectedAccountIndexes: [1, 2, 3],
        startedAt: new Date(now).toISOString()
      })
      for (const index of [1, 2, 3])
        store.ledger.lifecycle({
          runId: 'run',
          accountId: `synthetic-${String(index)}`,
          accountIndex: index,
          accountLabel: 'Synthetic',
          executionState: 'partial',
          startedAt: new Date(now).toISOString(),
          endedAt: end,
          updatedAt: end
        })
      store.updateRun('run', 'partial', end)
      const views = new RunViews(store)
      const run = views.run('run')
      expect(run).toMatchObject({
        status: 'partial',
        executionMode: 'mutating',
        finishedAt: end,
        accountsEnded: 3,
        accountsCompleted: 0,
        accountsPartial: 3,
        accountsFailed: 0
      })
      expect(
        views
          .calendar('2026-09')
          .every((entry) => entry.records.every((record) => record.runStatusLabel === '部分完成'))
      ).toBe(true)
      await notifications.tick()
      const bodies = send.mock.calls.map(([, init]) =>
        typeof init?.body === 'string' ? init.body : ''
      )
      const summary = bodies.find((body) => body.includes('Microsoft Rewards 运行汇总'))
      expect(summary).toContain('运行状态：部分完成')
      expect(summary).toContain('模式：执行任务')
      expect(summary).toContain('已结束账号：3/3')
      expect(summary).toContain('完全完成账号：0/3')
      expect(summary).toContain('部分完成账号：3')
      expect(summary).toContain('失败账号：0')
      expect(summary).toContain('未完全完成账号：3')
      expect(summary).not.toMatch(/全部完成|运行已完成|待确认/)
      // Do not rewrite old contradictory history to make the view look consistent.
      store.updateRun('run', 'completed', end)
      expect(views.run('run')?.status).toBe('partial')
      expect(store.getRun('run')?.status).toBe('completed')
    } finally {
      store.close()
    }
  })
})
