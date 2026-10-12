import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { StatusTag } from './UiKit'
import {
  clockTime,
  points,
  stateLabel,
  friendlyFailureReason,
  friendlyTaskDisplayName,
  taskTypeInfo
} from './display'

export interface StreamEvent {
  id: string
  time: string
  accountId: string
  accountLabel: string
  accountIndex?: number | null | undefined
  taskType: string
  taskId?: string | undefined
  taskName?: string | null | undefined
  status: string
  progressCompleted?: number | null | undefined
  progressTotal?: number | null | undefined
  earnedPoints?: number | null | undefined
  reason?: string | null | undefined
  isActive?: boolean | undefined
}

export function LiveRunStream({
  title = '执行动态流',
  events,
  currentAccountLabel,
  isRunning = false
}: {
  title?: string
  events: readonly StreamEvent[]
  currentAccountLabel?: string | null | undefined
  isRunning?: boolean
}): ReactElement {
  const [autoScroll, setAutoScroll] = useState(true)
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'completed' | 'issues'>('all')
  const streamRef = useRef<HTMLDivElement>(null)

  // 提取动态中涉及的账号列表以供筛选
  const accountOptions = useMemo(() => {
    const map = new Map<string, { id: string; label: string; index?: number | null | undefined }>()
    for (const e of events) {
      if (!map.has(e.accountId)) {
        map.set(e.accountId, {
          id: e.accountId,
          label: e.accountLabel,
          index: e.accountIndex
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => (a.index ?? 999) - (b.index ?? 999))
  }, [events])

  // 过滤出有意义的动态项
  const meaningfulEvents = useMemo(() => {
    return events.filter((e) => {
      if (
        (e.earnedPoints === null || e.earnedPoints === 0) &&
        e.progressCompleted === 0 &&
        (e.status === 'skipped' || e.status === 'discovered' || e.status === 'unknown') &&
        !e.reason
      ) {
        return false
      }
      return true
    })
  }, [events])

  const filteredEvents = useMemo(() => {
    return meaningfulEvents.filter((e) => {
      if (selectedAccountId !== 'all' && e.accountId !== selectedAccountId) {
        return false
      }
      if (statusFilter === 'running') {
        return e.status === 'running' || e.isActive === true
      }
      if (statusFilter === 'completed') {
        return e.status === 'completed' || e.status === 'success'
      }
      if (statusFilter === 'issues') {
        return (
          Boolean(e.reason) ||
          ['failed', 'action-required', 'interrupted', 'verification-pending'].includes(e.status)
        )
      }
      return true
    })
  }, [meaningfulEvents, selectedAccountId, statusFilter])

  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTo({
        top: streamRef.current.scrollHeight,
        behavior: 'smooth'
      })
    }
  }, [filteredEvents, autoScroll])

  return (
    <div className="live-stream-panel">
      <div className="live-stream-header">
        <div className="live-stream-title-group">
          <strong>{title}</strong>
          {isRunning ? (
            <span className="live-status-badge running">
              <span className="pulse-dot" /> 运行中
            </span>
          ) : (
            <span className="live-status-badge idle">待机 / 历史</span>
          )}
          {currentAccountLabel && (
            <span className="current-account-tag">
              正在执行：<strong>{currentAccountLabel}</strong>
            </span>
          )}
        </div>
        <div className="live-stream-controls">
          <button
            type="button"
            className={`stream-control-btn ${autoScroll ? 'active' : ''}`}
            onClick={() => {
              setAutoScroll(!autoScroll)
            }}
          >
            {autoScroll ? '自动滚动：开' : '自动滚动：已暂停'}
          </button>
          <span className="stream-count-text">共 {filteredEvents.length} 项动态</span>
        </div>
      </div>

      <div className="live-stream-filter-bar">
        <div className="stream-filter-group">
          <span className="filter-label">账号筛选：</span>
          <button
            type="button"
            className={`filter-chip ${selectedAccountId === 'all' ? 'active' : ''}`}
            onClick={() => {
              setSelectedAccountId('all')
            }}
          >
            全部 ({meaningfulEvents.length})
          </button>
          {accountOptions.map((acc) => {
            const count = meaningfulEvents.filter((e) => e.accountId === acc.id).length
            return (
              <button
                key={acc.id}
                type="button"
                className={`filter-chip ${selectedAccountId === acc.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedAccountId(acc.id)
                }}
              >
                {acc.index ? `账号 ${String(acc.index)}` : ''} · {acc.label} ({count})
              </button>
            )
          })}
        </div>

        <div className="stream-filter-group">
          <span className="filter-label">状态筛选：</span>
          <button
            type="button"
            className={`filter-chip ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => {
              setStatusFilter('all')
            }}
          >
            全部
          </button>
          <button
            type="button"
            className={`filter-chip ${statusFilter === 'running' ? 'active' : ''}`}
            onClick={() => {
              setStatusFilter('running')
            }}
          >
            进行中
          </button>
          <button
            type="button"
            className={`filter-chip ${statusFilter === 'completed' ? 'active' : ''}`}
            onClick={() => {
              setStatusFilter('completed')
            }}
          >
            已完成
          </button>
          <button
            type="button"
            className={`filter-chip ${statusFilter === 'issues' ? 'active' : ''}`}
            onClick={() => {
              setStatusFilter('issues')
            }}
          >
            异常/待复核
          </button>
        </div>
      </div>

      <div
        className="live-stream-container"
        ref={streamRef}
        onWheel={(e) => {
          if (e.deltaY < 0 && autoScroll) {
            setAutoScroll(false)
          }
        }}
      >
        {filteredEvents.length === 0 ? (
          <div className="stream-empty">暂无任务动态记录，等待执行...</div>
        ) : (
          <div className="stream-list">
            {filteredEvents.map((event) => {
              const typeInfo = taskTypeInfo(event.taskType)
              const hasFailure =
                Boolean(event.reason) || ['failed', 'action-required'].includes(event.status)
              const failureText = event.reason ? friendlyFailureReason(event.reason) : null
              const displayName = friendlyTaskDisplayName({
                taskId: event.taskId,
                displayName: event.taskName,
                type: event.taskType
              })

              return (
                <div
                  key={event.id}
                  className={`stream-item ${event.isActive ? 'active-task' : ''} ${
                    hasFailure ? 'failed-task' : ''
                  }`}
                >
                  <div className="stream-item-main">
                    <span className="stream-time">{clockTime(event.time).slice(-8)}</span>
                    <span className="stream-account-badge">
                      {event.accountIndex ? `账号 ${String(event.accountIndex)}` : '账号'} · {event.accountLabel}
                    </span>
                    <span className="stream-task-name">
                      <span className="task-icon">{typeInfo.icon}</span>
                      <strong>{displayName}</strong>
                    </span>
                    <span className="stream-status">
                      <StatusTag value={event.status} label={stateLabel(event.status)} />
                    </span>
                  </div>

                  <div className="stream-item-sub">
                    <div className="stream-progress-group">
                      {event.progressTotal != null ? (
                        <span className="stream-progress">
                          进度：<strong>{event.progressCompleted ?? 0}/{event.progressTotal}</strong>
                        </span>
                      ) : event.status === 'completed' ? (
                        <span className="stream-progress">
                          进度：<strong>已达标</strong>
                        </span>
                      ) : null}
                      {event.earnedPoints != null && event.earnedPoints > 0 ? (
                        <span className="stream-points gained">
                          获得积分：<strong>{points(event.earnedPoints)}</strong>
                        </span>
                      ) : event.earnedPoints === 0 ? (
                        <span className="stream-points zero">
                          获得积分：0 分
                        </span>
                      ) : null}
                    </div>

                    {failureText ? (
                      <div className="stream-failure-reason">
                        <span className="failure-icon">⚠️</span>
                        <span>{failureText}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
