import { describe, expect, it } from 'vitest'
import { taskPointDetail } from '../src/domain/TaskPointDetail.js'
import { taskPointSummaries } from '../src/domain/TaskPointSummary.js'
import {
  taskCategoryPoints,
  type CategoryBalance,
  type CategoryCredit
} from '../src/domain/TaskCategoryPoints.js'

const scope = { runId: 'synthetic-run', accountId: 'synthetic-account' }
const date = '2026-10-05'
const task = (id: string, points?: number) =>
  taskPointDetail({
    taskId: id,
    displayName: id,
    type: 'daily-set',
    localDate: date,
    status: 'completed',
    expectedPoints: 99,
    ...(points === undefined ? {} : { taskEarnedPoints: points })
  })
const balance = (
  id: string | null,
  phase: string,
  value: number,
  second: number,
  overrides: Partial<CategoryBalance> = {}
): CategoryBalance => ({
  ...scope,
  taskId: id,
  phase,
  balance: value,
  businessDate: date,
  observedAt: new Date(Date.parse(`${date}T00:00:00Z`) + second * 1000).toISOString(),
  snapshotId: `${id ?? 'account'}:${phase}:${String(second)}`,
  ...overrides
})
const credit = (id: string, overrides: Partial<CategoryCredit> = {}): CategoryCredit => ({
  ...scope,
  taskId: id,
  businessDate: date,
  observedAt: `${date}T00:00:02Z`,
  evidenceSource: 'task-report',
  confirmedPoints: null,
  conflict: false,
  ...overrides
})
const shared = () => [
  balance('first', 'task-before', 100, 1),
  balance('first', 'task-after', 110, 2),
  balance('second', 'task-before', 100, 1),
  balance('second', 'task-after', 120, 3)
]
const scores = (
  tasks: Parameters<typeof taskPointSummaries>[0] = [task('first'), task('second')],
  balances: readonly CategoryBalance[] = shared(),
  credits: readonly CategoryCredit[] = []
) => taskCategoryPoints(taskPointSummaries(tasks), scope, balances, credits)

describe('notification category scores from existing evidence', () => {
  it('uses a shared category envelope once without changing any inputs or creating credits', () => {
    const tasks = [task('first'), task('second')].map((row) => Object.freeze(row))
    const balances = shared().map((row) => Object.freeze(row))
    const credits = [credit('first')].map((row) => Object.freeze(row))
    const input = JSON.stringify([tasks, balances, credits])
    expect(scores(tasks, balances, credits).get('daily-set')).toBe(20)
    expect(JSON.stringify([tasks, balances, credits])).toBe(input)
    expect(taskPointSummaries(tasks)[0]?.confirmedPoints).toBeNull()
  })

  it('allows a preceding category to end exactly at the next category boundary', () => {
    const tasks = [{ ...task('app'), type: 'app-activity' as const }, task('first'), task('second')]
    const rows = [
      balance('app', 'task-before', 90, 0),
      balance('app', 'task-after', 100, 1),
      ...shared()
    ]
    expect([...scores(tasks, rows)]).toEqual([
      ['app-activity', 10],
      ['daily-set', 20]
    ])
  })

  it('rejects another category overlapping the execution window', () => {
    const rows = [
      ...shared(),
      balance('promotion', 'task-before', 100, 1.5),
      balance('promotion', 'task-after', 110, 2.5)
    ]
    expect(scores(undefined, rows).size).toBe(0)
  })

  it('rejects another category between disjoint tasks in the category', () => {
    const rows = [
      balance('first', 'task-before', 100, 0),
      balance('first', 'task-after', 110, 1),
      balance('other', 'task-before', 110, 1),
      balance('other', 'task-after', 115, 2),
      balance('second', 'task-before', 115, 2),
      balance('second', 'task-after', 125, 3)
    ]
    expect(scores(undefined, rows).size).toBe(0)
  })

  it('ignores other accounts even with invalid timestamps and conflicting balances', () => {
    expect(
      scores(
        undefined,
        [
          ...shared(),
          balance('other', 'task-before', -1, 2, {
            accountId: 'another-synthetic-account',
            observedAt: 'invalid'
          })
        ],
        [credit('first', { accountId: 'another-synthetic-account', conflict: true })]
      ).get('daily-set')
    ).toBe(20)
  })

  it('rejects overlapping task windows from another run even when task identifiers match', () => {
    expect(
      scores(undefined, [
        ...shared(),
        balance('first', 'task-before', 100, 1, { runId: 'another-synthetic-run' }),
        balance('first', 'task-after', 120, 3, { runId: 'another-synthetic-run' })
      ]).size
    ).toBe(0)
  })

  it('rejects another active run that only has account snapshots', () => {
    expect(
      scores(undefined, [
        ...shared(),
        balance(null, 'start', 100, 0, { runId: 'another-synthetic-run' }),
        balance(null, 'end', 120, 4, { runId: 'another-synthetic-run' })
      ]).size
    ).toBe(0)
  })

  it('allows other runs that finish or start exactly at the category boundaries', () => {
    expect(
      scores(undefined, [
        ...shared(),
        balance(null, 'start', 90, 0, { runId: 'earlier-synthetic-run' }),
        balance(null, 'end', 100, 1, { runId: 'earlier-synthetic-run' }),
        balance(null, 'start', 120, 3, { runId: 'later-synthetic-run' }),
        balance(null, 'end', 125, 4, { runId: 'later-synthetic-run' })
      ]).get('daily-set')
    ).toBe(20)
  })

  it('rejects an unclosed competing task that started before the category', () => {
    expect(scores(undefined, [...shared(), balance('other', 'task-before', 90, 0)]).size).toBe(0)
  })

  it('rejects another task activity even if it only has a live balance', () => {
    expect(scores(undefined, [...shared(), balance('other', 'live', 110, 2)]).size).toBe(0)
  })

  it('rejects unrelated credits, including pending records, inside the interval', () => {
    expect(scores(undefined, shared(), [credit('other')]).size).toBe(0)
    expect(
      scores(undefined, shared(), [credit('first', { runId: 'another-synthetic-run' })]).size
    ).toBe(0)
  })

  it('rejects competing credit scopes even if the receipt arrives after the interval', () => {
    expect(
      scores(undefined, shared(), [
        credit('other', {
          observedAt: `${date}T00:00:04Z`,
          beforeSnapshotId: 'first:task-before:1',
          afterSnapshotId: 'second:task-after:3'
        })
      ]).size
    ).toBe(0)
  })

  it('prefers complete confirmed task amounts over a larger balance change', () => {
    expect(scores([task('first', 5), task('second', 5)]).get('daily-set')).toBe(10)
  })

  it('uses the category delta in place of a subtotal without adding it twice', () => {
    expect(
      scores([task('first', 10), task('second')], shared(), [
        credit('first', { evidenceSource: 'official-credit', confirmedPoints: 10 })
      ]).get('daily-set')
    ).toBe(20)
  })

  it('keeps confirmed amounts when category isolation or coverage is unavailable', () => {
    expect(scores([task('first', 10), task('second')], [], []).get('daily-set')).toBe(10)
    expect(scores([task('first', 10), task('second')], shared().slice(0, 2)).get('daily-set')).toBe(
      10
    )
    expect(scores([task('first', 30), task('second')]).get('daily-set')).toBe(30)
  })

  it('does not replace an earlier or later confirmed receipt with an incomplete interval', () => {
    for (const second of [0, 4])
      expect(
        scores([task('first', 10), task('second')], shared(), [
          credit('first', {
            evidenceSource: 'official-credit',
            confirmedPoints: 10,
            observedAt: `${date}T00:00:0${String(second)}Z`
          })
        ]).get('daily-set')
      ).toBe(10)
  })

  it('suppresses conflicting categories and does not revive rejected isolated credits', () => {
    expect(scores([{ ...task('first', 10), pointsStatus: 'conflict' }, task('second')]).size).toBe(
      0
    )
    expect(scores(undefined, shared(), [credit('first', { conflict: true })]).size).toBe(0)
    expect(
      scores(undefined, shared(), [credit('first', { evidenceSource: 'isolated-balance' })]).size
    ).toBe(0)
  })

  it('does not infer scores from unsafe receipt amounts', () => {
    expect(
      scores(undefined, shared(), [
        credit('first', {
          confirmedPoints: Number.MAX_SAFE_INTEGER + 1
        })
      ]).size
    ).toBe(0)
  })

  it('never assigns opening/end account residuals or estimates without explicit task boundaries', () => {
    expect(
      scores(undefined, [balance(null, 'start', 100, 0), balance(null, 'end', 120, 4)]).size
    ).toBe(0)
    expect(
      scores(undefined, [balance('first', 'live', 100, 0), balance('first', 'live', 120, 4)]).size
    ).toBe(0)
    expect(scores(undefined, [], [credit('first')]).size).toBe(0)
    expect(scores().get('daily-set')).not.toBe(198)
  })

  it('accepts duplicate matching snapshots and rejects conflicting timestamps', () => {
    expect(
      scores(undefined, [...shared(), balance('first', 'task-before', 100, 1)]).get('daily-set')
    ).toBe(20)
    expect(scores(undefined, [...shared(), balance(null, 'live', 99, 1)]).size).toBe(0)
    expect(scores(undefined, [...shared(), balance(null, 'live', 105, 2)]).size).toBe(0)
  })

  it('does not attribute balance decreases even when the net category delta is positive', () => {
    expect(scores(undefined, [...shared(), balance(null, 'live', 90, 1.5)]).size).toBe(0)
  })

  it.each([
    { observedAt: 'invalid' },
    { observedAt: `${date}T00:00:01` },
    { balance: -1 },
    { balance: 1.5 },
    { balance: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects invalid balance observations %j', (override) => {
    const rows = shared()
    const first = rows[0]
    if (!first) throw new Error('Missing synthetic observation')
    rows[0] = { ...first, ...override }
    expect(scores(undefined, rows).size).toBe(0)
  })

  it('does not interpret a stale same-time observation as a confirmed zero', () => {
    expect(
      scores(
        [task('first')],
        [balance('first', 'task-before', 100, 1), balance('first', 'task-after', 100, 1)]
      ).size
    ).toBe(0)
    expect(scores([task('first', 0)], []).get('daily-set')).toBe(0)
    expect(
      scores(
        [task('first')],
        [balance('first', 'task-before', 100, 1), balance('first', 'task-after', 100, 2)]
      ).get('daily-set')
    ).toBe(0)
  })

  it('never joins task boundaries from different business dates', () => {
    const rows = shared().map((row) =>
      row.phase === 'task-before' ? { ...row, businessDate: '2026-10-04' } : row
    )
    expect(scores(undefined, rows).size).toBe(0)
  })

  it('combines independently measured days and keeps repeated task identifiers scoped by date', () => {
    const next = '2026-10-06'
    const rows = shared().map((row) => ({
      ...row,
      businessDate: next,
      observedAt: row.observedAt.replace(date, next)
    }))
    expect(
      scores(
        [
          task('first'),
          task('second'),
          { ...task('first'), businessDate: next },
          { ...task('second'), businessDate: next }
        ],
        [...shared(), ...rows]
      ).get('daily-set')
    ).toBe(40)
  })

  it('does not overflow confirmed totals or inferred totals across dates', () => {
    expect(scores([task('first', Number.MAX_SAFE_INTEGER), task('second', 1)], []).size).toBe(0)
    expect(
      scores(
        [
          task('first', Number.MAX_SAFE_INTEGER),
          { ...task('second', 1), businessDate: '2026-10-06' }
        ],
        []
      ).size
    ).toBe(0)
  })
})
