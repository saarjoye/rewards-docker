import { describe, expect, it } from 'vitest'
import { taskPointDetail } from '../src/domain/TaskPointDetail.js'
import { taskPointSummaries, taskPointSummaryLine } from '../src/domain/TaskPointSummary.js'

const task = (id: string, points?: number) =>
  taskPointDetail({
    taskId: id,
    displayName: `合成任务 ${id}`,
    type: 'daily-set',
    localDate: '2026-10-05',
    status: 'completed',
    ...(points === undefined ? {} : { taskEarnedPoints: points })
  })

describe('readable task module summaries', () => {
  it('groups confirmed daily tasks into one legacy style line and deduplicates identities', () => {
    const first = task('first', 50)
    const summaries = taskPointSummaries([first, first, task('second', 50)])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.tasks).toHaveLength(2)
    const summary = summaries[0]
    if (!summary) throw new Error('Expected synthetic task summary')
    expect(taskPointSummaryLine(summary)).toBe('- 每日任务：100 分')
  })

  it('orders recorded modules without inventing missing tasks', () => {
    const rows = taskPointSummaries([
      { ...task('pc', 60), type: 'pc-search' },
      { ...task('reading', 30), type: 'read-to-earn' },
      { ...task('claim', 480), type: 'claim-bonus-points' },
      { ...task('check-in', 50), type: 'app-check-in' }
    ])
    expect(rows.map((row) => row.displayName)).toEqual([
      '领取奖励积分',
      '每日签到',
      '阅读赚取',
      'PC 搜索'
    ])
    expect(rows.some((row) => row.displayName === '连击保护')).toBe(false)
  })

  it('distinguishes a proven zero from missing and expected zero', () => {
    expect(taskPointSummaries([task('zero', 0)])[0]?.amountLabel).toBe('+0 分')
    expect(taskPointSummaries([task('missing')])[0]?.amountLabel).toBe('得分未确认')
    expect(
      taskPointSummaries([{ ...task('expected-zero'), expectedPoints: 0 }])[0]?.amountLabel
    ).toBe('预计 +0 分（未确认）')
  })

  it('keeps a confirmed subtotal separate from the unconfirmed tasks', () => {
    const rows = taskPointSummaries([
      task('confirmed', 100),
      { ...task('unconfirmed'), expectedPoints: 5 }
    ])
    expect(rows[0]?.amountLabel).toBe('+100 分（另1项未确认）')
    expect(rows[0]?.tasks[1]?.confirmedPoints).toBeNull()
    expect(rows[0]?.tasks[1]?.expectedPoints).toBe(5)
  })

  it('labels mixed reports and estimates without treating either as a credit', () => {
    const rows = taskPointSummaries([
      { ...task('reported'), reportedPoints: 5, expectedPoints: 10 },
      { ...task('expected'), expectedPoints: 5 }
    ])
    expect(rows[0]?.amountLabel).toBe('上报/预计 +10 分（未确认）')
  })

  it('does not present incomplete metadata as a total', () => {
    const rows = taskPointSummaries([{ ...task('expected'), expectedPoints: 5 }, task('missing')])
    expect(rows[0]?.amountLabel).toBe('得分未确认（其中预计 +5 分）')
  })

  it('does not label a partly completed module as fully completed', () => {
    const rows = taskPointSummaries([
      task('done', 0),
      { ...task('locked'), status: 'skipped', reason: '需等待24小时后解锁' }
    ])
    expect(rows[0]?.statusLabel).toBe('已完成 1/2 项，已跳过 1 项')
    expect(rows[0]?.reason).toBe('需等待24小时后解锁')
  })

  it('preserves official search progress and legacy line order', () => {
    const rows = taskPointSummaries([
      { ...task('search', 60), type: 'pc-search', progress: { completed: 60, total: 60 } }
    ])
    const summary = rows[0]
    if (!summary) throw new Error('Expected synthetic task summary')
    expect(taskPointSummaryLine(summary)).toBe('- PC 搜索：60 分')
    expect(summary.progress).toEqual({ completed: 60, total: 60 })
    expect(
      taskPointSummaries([{ ...task('search', 60), type: 'pc-search' }])[0]?.progress
    ).toBeNull()
  })

  it('keeps verification pending and failed tasks visible alongside completion', () => {
    const rows = taskPointSummaries([
      task('done', 5),
      { ...task('pending'), status: 'verification-pending' },
      { ...task('failed'), status: 'failed' }
    ])
    expect(rows[0]?.statusLabel).toBe('已完成 1/3 项，失败 1 项，待复核 1 项')
  })

  it('does not hide conflicting evidence or overflow safe integer amounts', () => {
    expect(
      taskPointSummaries([{ ...task('conflict'), pointsStatus: 'conflict' }])[0]?.amountLabel
    ).toBe('积分证据冲突')
    expect(
      taskPointSummaries([task('huge', Number.MAX_SAFE_INTEGER), task('other', 1)])[0]?.amountLabel
    ).toBe('得分未确认')
  })

  it('keeps notification names on one line without splitting composed emoji', () => {
    const emoji = '👨‍👩‍👧‍👦'
    const summary = taskPointSummaries([
      {
        ...task('emoji', 5),
        type: 'unknown',
        displayName: emoji.repeat(61),
        status: 'failed',
        reason: '合成原因\n下一行'
      }
    ])[0]
    if (!summary) throw new Error('Expected synthetic task summary')
    const line = taskPointSummaryLine(summary)
    expect(line).toBe(`- ${emoji.repeat(59)}…：5 分`)
    expect(line).not.toContain('\n')
  })

  it('only formats earned points and preserves confirmed zero', () => {
    const line = (rows: Parameters<typeof taskPointSummaries>[0]) => {
      const summary = taskPointSummaries(rows)[0]
      if (!summary) throw new Error('Expected synthetic task summary')
      return taskPointSummaryLine(summary)
    }
    expect(line([task('zero', 0)])).toBe('- 每日任务：0 分')
    expect(line([task('missing')])).toBeNull()
    expect(line([{ ...task('estimate'), expectedPoints: 5 }])).toBeNull()
    expect(line([{ ...task('report'), reportedPoints: 5 }])).toBeNull()
    expect(line([task('earned', 10), { ...task('estimate'), expectedPoints: 5 }])).toBe(
      '- 每日任务：10 分'
    )
    expect(line([{ ...task('conflict', 10), pointsStatus: 'conflict' }])).toBeNull()
    expect(line([task('huge', Number.MAX_SAFE_INTEGER), task('one', 1)])).toBeNull()
  })

  it('keeps unknown task names separate and does not modify the input', () => {
    const first = { ...task('first', 5), type: 'unknown' as const, displayName: '<b>任务一</b>' }
    const second = { ...task('second', 5), type: 'unknown' as const, displayName: '任务二' }
    const input = Object.freeze([Object.freeze(first), Object.freeze(second)])
    const summaries = taskPointSummaries(input)
    expect(summaries.map((row) => row.displayName)).toEqual(['<b>任务一</b>', '任务二'])
    expect(input[0]).toBe(first)
  })
})
