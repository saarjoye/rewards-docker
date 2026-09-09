import { useState, type ReactElement } from 'react'
import { Card } from 'tdesign-react/es/card/index.js'
import { DatePicker } from 'tdesign-react/es/date-picker/index.js'
import { Empty } from 'tdesign-react/es/empty/index.js'
import { Pagination } from 'tdesign-react/es/pagination/index.js'
import { Switch } from 'tdesign-react/es/switch/index.js'
import { AddIcon } from 'tdesign-icons-react'
import type { AccountSummary, StatePayload } from './App'
import { Button, DataTable, Field, PageHeader, SelectField, StatusTag } from './UiKit'
import { PointSummary } from './PointSummary'
import { clockTime, duration, points } from './display'

export function Overview({
  state,
  openRun
}: {
  state: StatePayload | undefined
  openRun: (id: string) => void
}): ReactElement {
  const active = state?.runs.find((row) => row.runId === state.activeRunId)
  return (
    <>
      <PageHeader title="概览" description="运行进度、账号余额与需要处理的事项" />
      <section className="metrics" aria-label="任务统计">
        {[
          ['已发现任务', state?.taskSummary.discovered],
          ['执行已结束', state?.taskSummary.completed],
          ['待复核', state?.taskSummary.verificationPending],
          [
            '失败 / 需处理',
            state ? state.taskSummary.failed + state.taskSummary.actionRequired : undefined
          ]
        ].map(([label, value]) => (
          <Card key={String(label)} bordered={false}>
            <span className="muted">{label}</span>
            <strong className="metric-value">{value ?? '读取中'}</strong>
          </Card>
        ))}
      </section>
      <Card bordered={false} title="当前运行" className="active-run-card">
        {active ? (
          <div className="active-run">
            <div>
              <StatusTag value={active.status} />
              <p>
                已处理 {active.accountsProcessed}/{active.accountsTotal} 个账号
              </p>
              <small className="muted">
                {clockTime(active.startedAt)} — 进行中 ={' '}
                {duration(active.startedAt, new Date().toISOString())}
              </small>
            </div>
            <div>
              <span className="muted">本次余额变化</span>
              <strong className="balance-number">{points(active.runBalanceDelta)}</strong>
              <StatusTag value={active.runBalanceDelta === null ? 'pending' : 'provisional'} />
              <Button
                variant="outline"
                onClick={() => {
                  openRun(active.runId)
                }}
              >
                查看当前运行
              </Button>
            </div>
          </div>
        ) : (
          <p className="muted">当前没有运行中的任务。通过“新建运行”选择账号和执行方式。</p>
        )}
      </Card>
      <Card
        bordered={false}
        title="今日账户余额变化"
        subtitle="Asia/Shanghai · 任务执行与到账确认独立统计"
      >
        {!state ? (
          <Empty description="读取中" />
        ) : !state.today.length ? (
          <Empty description="暂无余额观测" />
        ) : (
          <div className="balance-cards">
            {state.today.map((day) => (
              <article className="balance-card" key={day.accountId}>
                <div className="section-heading">
                  <strong>{day.accountLabel}</strong>
                  <StatusTag value={day.verificationStatus} />
                </div>
                <div className="balance-number">{points(day.dailyBalanceDelta)}</div>
                <details>
                  <summary>查看积分依据</summary>
                  <PointSummary value={day} />
                </details>
              </article>
            ))}
          </div>
        )}
      </Card>
      <Card bordered={false} title="最近运行">
        <DataTable
          rows={state?.runs.slice(0, 5) ?? []}
          rowKey={(row) => row.runId}
          empty="暂无运行记录"
          columns={[
            {
              key: 'time',
              title: '执行时间',
              cell: (row) => (
                <>
                  <span>{clockTime(row.startedAt)}</span>
                  <small className="muted">
                    {clockTime(row.finishedAt)} ={' '}
                    {duration(
                      row.startedAt,
                      row.finishedAt ??
                        (row.runId === state?.activeRunId ? new Date().toISOString() : null)
                    )}
                  </small>
                </>
              )
            },
            {
              key: 'progress',
              title: '账号进度',
              cell: (row) => `已处理 ${String(row.accountsProcessed)}/${String(row.accountsTotal)}`
            },
            { key: 'status', title: '状态', cell: (row) => <StatusTag value={row.status} /> },
            { key: 'points', title: '本次余额变化', cell: (row) => points(row.runBalanceDelta) },
            {
              key: 'actions',
              title: '操作',
              cell: (row) => (
                <Button
                  variant="text"
                  onClick={() => {
                    openRun(row.runId)
                  }}
                >
                  查看详情
                </Button>
              )
            }
          ]}
        />
      </Card>
    </>
  )
}

export function TasksPage({
  state,
  date,
  onDate
}: {
  state: StatePayload | undefined
  date: string
  onDate: (date: string) => void
}): ReactElement {
  const [account, setAccount] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const filtered =
    state?.tasks.filter(
      (row) =>
        (!account || row.accountId === account) &&
        (!status || row.status === status) &&
        (!search ||
          `${row.displayName} ${row.type}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    ) ?? []
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / 15)))
  return (
    <section className="task-section">
      <PageHeader title="任务状态" description="按账号和日期查看任务；完成状态不等于积分到账" />
      <Card bordered={false}>
        <div className="filter-bar">
          <label className="form-field">
            <span>日期</span>
            <DatePicker
              allowInput
              value={date || state?.localDate || ''}
              clearable={false}
              onChange={(value) => {
                if (value) {
                  onDate(String(value))
                  setPage(1)
                }
              }}
            />
          </label>
          <SelectField
            label="账号"
            value={account}
            onChange={(value) => {
              setAccount(value)
              setPage(1)
            }}
            options={[
              { label: '全部账号', value: '' },
              ...(state?.accounts.map((row) => ({
                label: `${String(row.runAccountIndex)} · ${row.displayAlias}`,
                value: row.accountId
              })) ?? [])
            ]}
          />
          <SelectField
            label="状态"
            value={status}
            onChange={(value) => {
              setStatus(value)
              setPage(1)
            }}
            options={[
              { label: '全部状态', value: '' },
              ...[
                'discovered',
                'running',
                'submitted',
                'verification-pending',
                'completed',
                'failed',
                'skipped',
                'action-required',
                'unknown'
              ].map((value) => ({
                value,
                label:
                  (
                    {
                      discovered: '待执行',
                      running: '进行中',
                      submitted: '已提交',
                      'verification-pending': '待复核',
                      completed: '执行已结束',
                      failed: '失败',
                      skipped: '已跳过',
                      'action-required': '需人工处理',
                      unknown: '待确认'
                    } as Record<string, string>
                  )[value] ?? value
              }))
            ]}
          />
          <Field
            label="搜索任务"
            value={search}
            onChange={(value) => {
              setSearch(value)
              setPage(1)
            }}
            placeholder="任务名称或类型"
          />
          <Button
            variant="text"
            onClick={() => {
              setAccount('')
              setStatus('')
              setSearch('')
              setPage(1)
              onDate('')
            }}
          >
            重置筛选
          </Button>
        </div>
        <DataTable
          rows={filtered.slice((current - 1) * 15, current * 15)}
          rowKey={(row) => row.taskId}
          loading={!state}
          empty="没有符合筛选条件的任务"
          columns={[
            {
              key: 'account',
              title: '账号',
              cell: (row) => {
                const a = state?.accounts.find((item) => item.accountId === row.accountId)
                return a ? `账号 ${String(a.runAccountIndex)} · ${a.displayAlias}` : '历史账号'
              }
            },
            {
              key: 'task',
              title: '任务',
              cell: (row) => (
                <>
                  <strong>{row.displayName}</strong>
                  <small className="muted">{row.reason ?? row.source}</small>
                </>
              )
            },
            { key: 'status', title: '执行状态', cell: (row) => <StatusTag value={row.status} /> },
            {
              key: 'progress',
              title: '任务进度',
              cell: (row) =>
                row.progress.total === null
                  ? '待确认'
                  : `${String(row.progress.completed)}/${String(row.progress.total)}`
            },
            { key: 'time', title: '更新时间', cell: (row) => clockTime(row.updatedAt) }
          ]}
        />
        <Pagination
          current={current}
          pageSize={15}
          total={filtered.length}
          showPageSize={false}
          onCurrentChange={setPage}
        />
      </Card>
    </section>
  )
}

export function AccountsPage({
  accounts,
  busy,
  running,
  add,
  edit,
  toggle
}: {
  accounts: AccountSummary[]
  busy: boolean
  running: boolean
  add: () => void
  edit: (account: AccountSummary) => void
  toggle: (account: AccountSummary) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const rows = accounts.filter((row) =>
    `${row.displayAlias} ${row.maskedEmail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  return (
    <>
      <PageHeader
        title="账号管理"
        description="管理账号名称和运行资格；账号编号仅用于选择，不代表完成数量"
        actions={
          <Button icon={<AddIcon />} onClick={add}>
            添加账号
          </Button>
        }
      />
      <Card bordered={false}>
        <div className="filter-bar">
          <Field
            label="搜索账号"
            value={query}
            onChange={setQuery}
            placeholder="搜索名称或脱敏账号"
          />
          <span className="muted">
            {accounts.filter((row) => row.enabled).length}/{accounts.length} 个已启用
          </span>
        </div>
        {running && <p className="muted">运行期间暂不能更改账号启停状态，名称仍可编辑。</p>}
        <DataTable
          rows={rows}
          rowKey={(row) => row.accountId}
          empty={accounts.length ? '没有匹配的账号' : '尚未添加账号'}
          columns={[
            { key: 'number', title: '编号', cell: (row) => `账号 ${String(row.runAccountIndex)}` },
            {
              key: 'name',
              title: '名称与账号',
              cell: (row) => (
                <>
                  <strong>{row.displayAlias}</strong>
                  <small className="muted">{row.maskedEmail}</small>
                </>
              )
            },
            {
              key: 'enabled',
              title: '参与运行',
              cell: (row) => (
                <Switch
                  value={row.enabled}
                  aria-checked={row.enabled}
                  disabled={busy || running}
                  label={['已启用', '已停用']}
                  onChange={() => {
                    toggle(row)
                  }}
                  aria-label={`启用账号 ${String(row.runAccountIndex)}`}
                />
              )
            },
            {
              key: 'edit',
              title: '操作',
              cell: (row) => (
                <Button
                  variant="text"
                  disabled={busy}
                  onClick={() => {
                    edit(row)
                  }}
                >
                  编辑名称
                </Button>
              )
            }
          ]}
        />
      </Card>
    </>
  )
}
