import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  pointAmount,
  taskPointDetail,
  taskPointAmountLabel,
  type TaskPointCredit
} from '../src/domain/TaskPointDetail.js'
import { TaskPointTable } from '../src/web/ui/TaskPointTable'

const task = {
  taskId: 'synthetic-task',
  displayName: '合成任务',
  status: 'completed',
  localDate: '2026-10-04',
  expectedPoints: 100,
  progress: { completed: 1, total: 1 }
}
const credit: TaskPointCredit = {
  taskId: task.taskId,
  businessDate: task.localDate,
  creditKey: 'synthetic-credit',
  evidenceSource: 'official-credit',
  confirmedPoints: 97,
  reportedPoints: 100,
  expectedPoints: 100
}

describe('task point presentation', () => {
  it.each([
    null,
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1
  ])('rejects unavailable or invalid amounts: %s', (value) => {
    expect(pointAmount(value)).toBeNull()
  })
  it('keeps proven zero separate from unknown and expected zero', () => {
    expect(taskPointAmountLabel(taskPointDetail({ ...task, taskEarnedPoints: 0 }))).toBe(
      '已确认 0 分'
    )
    expect(taskPointAmountLabel(taskPointDetail({ ...task, expectedPoints: 0 }))).toBe(
      '预计 0 分，到账未确认'
    )
    expect(
      taskPointAmountLabel(
        taskPointDetail({ taskId: 'legacy', displayName: '旧任务', status: 'completed' })
      )
    ).toBe('得分未确认')
  })
  it('does not convert completion, progress or a report into a credit', () => {
    const detail = taskPointDetail(task, [
      { ...credit, evidenceSource: 'task-report', confirmedPoints: null }
    ])
    expect(detail).toMatchObject({
      confirmedPoints: null,
      reportedPoints: 100,
      expectedPoints: 100,
      pointsStatus: 'unconfirmed'
    })
    expect(taskPointAmountLabel(detail)).toBe('上报 +100 分，到账未确认')
  })
  it('uses current server attribution rather than reviving a rejected receipt', () => {
    expect(
      taskPointDetail({ ...task, taskEarnedPoints: null }, [credit]).confirmedPoints
    ).toBeNull()
    expect(taskPointDetail({ ...task, taskEarnedPoints: 97 }, [credit]).confirmedPoints).toBe(97)
  })
  it('deduplicates stable receipts and chooses the established source priority', () => {
    const detail = taskPointDetail(task, [
      credit,
      credit,
      {
        ...credit,
        creditKey: 'other-source',
        evidenceSource: 'isolated-balance',
        confirmedPoints: 100
      }
    ])
    expect(detail.confirmedPoints).toBe(97)
    expect(detail.confirmedSource).toBe('official-credit')
    expect(
      taskPointDetail(task, [
        credit,
        { ...credit, creditKey: 'second-receipt', confirmedPoints: 3 }
      ]).confirmedPoints
    ).toBe(100)
  })
  it('isolates task identity and business date and excludes account-level credits', () => {
    expect(
      taskPointDetail(task, [
        { ...credit, taskId: 'other' },
        { ...credit, businessDate: '2026-10-05' }
      ]).confirmedPoints
    ).toBeNull()
    expect(
      taskPointDetail(task, [{ ...credit, evidenceSource: 'account-balance' }]).confirmedPoints
    ).toBeNull()
  })
  it('keeps inconsistent metadata and conflicting credit amounts unknown', () => {
    const rows = [credit, { ...credit, confirmedPoints: 98 }]
    const detail = taskPointDetail({ ...task, taskEarnedPoints: 97 }, rows)
    expect(detail).toMatchObject({ confirmedPoints: null, pointsStatus: 'conflict' })
    expect(taskPointAmountLabel(detail)).toBe('积分证据冲突')
    const expected = taskPointDetail(
      { taskId: task.taskId, displayName: '未知预计值', status: 'completed' },
      [credit, { ...credit, creditKey: 'different', expectedPoints: 105, reportedPoints: 105 }]
    )
    expect(expected.expectedPoints).toBeNull()
    expect(expected.reportedPoints).toBeNull()
  })
  it('renders pending, skipped, zero, legacy and quest tasks without nested disclosures or unsafe markup', () => {
    const tasks = [
      taskPointDetail({ ...task, displayName: '<script>unsafe</script>', taskEarnedPoints: 0 }),
      taskPointDetail({
        ...task,
        taskId: 'pending',
        status: 'verification-pending',
        expectedPoints: 5
      }),
      taskPointDetail({
        ...task,
        taskId: 'skipped',
        status: 'skipped',
        reason: '下一项需等待24小时',
        quest: { parentOfferId: 'synthetic-quest', title: '合成子任务', ariaLabel: 'Synthetic' }
      }),
      taskPointDetail({ taskId: 'legacy', displayName: '旧记录', status: 'completed' })
    ]
    const html = renderToStaticMarkup(createElement(TaskPointTable, { tasks }))
    expect(html).toContain('已确认 0 分')
    expect(html).toContain('预计 +5 分')
    expect(html).toContain('待复核')
    expect(html).toContain('已跳过')
    expect(html).toContain('下一项需等待24小时')
    expect(html).toContain('任务包子任务')
    expect(html).toContain('得分未确认')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<details')
  })
})
