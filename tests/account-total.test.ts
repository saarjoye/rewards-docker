import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'
import { localDateKey } from '../src/domain/DateKey.js'
import { AccountPointTotals } from '../src/web/ui/ConsolePages'

describe('overview daily earnings and total balance', () => {
  it('keeps account totals independent from daily changes and retains yesterday totals', () => {
    const store = new SqliteStore(':memory:')
    try {
      const accounts = ['a', 'b', 'c'].map((accountId, index) => ({
        accountId,
        displayAlias: `Synthetic ${String(index)}`,
        maskedEmail: 'Synthetic',
        runAccountIndex: index + 1
      }))
      const date = localDateKey()
      const balance = (account: string, value: number, observedAt: string, run = 'run') =>
        { store.ledger.balance(run, account, 'live', {
          value,
          observedAt,
          source: 'bing-flyout',
          availability: 'valid',
          confidence: 1
        }); }
      balance('a', 17500, `${date}T00:00:00Z`)
      balance('a', 17607, `${date}T01:00:00Z`)
      balance('b', 5000, '2025-01-01T00:00:00Z')
      const rows = new RunViews(store).today(accounts)
      expect(rows[0]).toMatchObject({ dailyBalanceDelta: 107, accountTotalPoints: 17607 })
      expect(rows[1]).toMatchObject({ dailyBalanceDelta: null, accountTotalPoints: 5000 })
      expect(rows[2]).toMatchObject({ dailyBalanceDelta: null, accountTotalPoints: null })
      balance('a', 17608, `${date}T01:00:00Z`, 'other')
      expect(new RunViews(store).today(accounts)[0]?.accountTotalPoints).toBeNull()
      balance('a', 0, `${date}T02:00:00Z`)
      expect(new RunViews(store).today(accounts)[0]?.accountTotalPoints).toBe(0)
    } finally {
      store.close()
    }
  })
  it('labels both numbers, does not add a plus sign to the total, and preserves unknown and zero', () => {
    const html = renderToStaticMarkup(
      createElement(AccountPointTotals, { today: 107, total: 17607 })
    )
    expect(html).toContain('今日得分</dt><dd>+107 分')
    expect(html).toContain('账号总分</dt><dd>17607 分')
    expect(html).not.toContain('+17607')
    expect(
      renderToStaticMarkup(createElement(AccountPointTotals, { today: null, total: 0 }))
    ).toContain('今日得分</dt><dd>—')
    expect(
      renderToStaticMarkup(createElement(AccountPointTotals, { today: 0, total: null }))
    ).toContain('账号总分</dt><dd>—')
  })
})
