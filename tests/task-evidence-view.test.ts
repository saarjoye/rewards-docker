import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TaskEvidencePanel, type EvidenceRow } from '../src/web/ui/TaskEvidencePanel'

const task = { taskId: 'fixture-task', displayName: 'Synthetic task', status: 'completed' }
const row: EvidenceRow = {
  taskId: task.taskId,
  kind: 'response',
  source: 'app-dashboard',
  observedAt: '2026-09-08T01:00:00Z',
  businessDate: '2026-09-08',
  balance: 5088,
  accepted: true,
  completed: null,
  total: null,
  confirmedPoints: null,
  creditKey: null
}

it('renders proven zero credit without hiding it behind a hard-coded missing-evidence label', () => {
  const html = renderToStaticMarkup(
    createElement(TaskEvidencePanel, {
      tasks: [task],
      evidence: [{ ...row, confirmedPoints: 0, creditKey: 'synthetic-credit' }]
    })
  )
  expect(html).toContain('已确认到账 0 分')
  expect(html).not.toContain('未取得到账证据')
  expect(html).toContain('synthetic-credit')
})

it('separates accepted responses and observed balances from confirmed credits', () => {
  const html = renderToStaticMarkup(
    createElement(TaskEvidencePanel, { tasks: [task], evidence: [row] })
  )
  expect(html).toContain('5088 分')
  expect(html).toContain('已记录接收回执')
  expect(html).toContain('任务到账：— 分')
  expect(html).not.toMatch(/未取得|未匹配|待确认|已观测/)
  expect(html).not.toContain('已到账 5088')
  expect(html).toContain('2026-09-08')
  expect(html).toContain('App 响应')
})

it('keeps zero, missing values and false acknowledgements distinct and escapes task text', () => {
  const html = renderToStaticMarkup(
    createElement(TaskEvidencePanel, {
      tasks: [{ ...task, displayName: '<script>unsafe</script>' }],
      evidence: [{ ...row, balance: 0, accepted: false, completed: 0, total: 30 }]
    })
  )
  expect(html).toContain('0 分')
  expect(html).toContain('0 / 30')
  expect(html).toContain('未确认接收')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('已确认到账')
})

it('shows legacy tasks without evidence and orphan evidence without inventing task names', () => {
  const html = renderToStaticMarkup(
    createElement(TaskEvidencePanel, {
      tasks: [task],
      evidence: [{ ...row, taskId: 'orphan' }]
    })
  )
  expect(html).toContain('尚无保存的任务证据')
  expect(html).toContain('任务名称：—')
  expect(html).toContain('5088 分')
})

it('shows all task amounts before individual evidence disclosures', () => {
  const html = renderToStaticMarkup(
    createElement(TaskEvidencePanel, {
      tasks: [
        { ...task, displayName: '每日任务', taskEarnedPoints: 97, expectedPoints: 100 },
        { ...task, taskId: 'pending-task', displayName: '更多推广', expectedPoints: 5 }
      ],
      creditEvidence: [
        {
          taskId: 'pending-task',
          businessDate: '2026-09-08',
          creditKey: 'pending-credit',
          evidenceSource: 'task-report',
          confirmedPoints: null,
          reportedPoints: 5,
          expectedPoints: 5
        }
      ]
    })
  )
  expect(html).toContain('任务积分明细')
  const table = html.slice(0, html.indexOf('<details class="task-evidence"'))
  expect(table).toContain('每日任务')
  expect(table).toContain('更多推广')
  expect(table).toContain('已确认 +97 分')
  expect(table).toContain('预计 +100 分')
  expect(table).toContain('上报 +5 分')
  expect(table).toContain('到账未确认')
  expect(table).not.toContain('已确认 +5 分')
})
