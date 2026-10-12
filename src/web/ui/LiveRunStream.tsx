import { useEffect, useRef, useState, type ReactElement } from 'react'
import { StatusTag } from './UiKit'
import {
  clockTime,
  points,
  stateLabel,
  friendlyFailureReason,
  taskTypeInfo
} from './display'

export interface StreamEvent {
  id: string
  time: string
  accountId: string
  accountLabel: string
  accountIndex?: number | null | undefined
  taskType: string
  taskName: string
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
  const streamRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTo({
        top: streamRef.current.scrollHeight,
        behavior: 'smooth'
      })
    }
  }, [events, autoScroll])

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
          <span className="stream-count-text">共 {events.length} 项动态</span>
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
        {events.length === 0 ? (
          <div className="stream-empty">暂无任务动态记录，等待执行...</div>
        ) : (
          <div className="stream-list">
            {events.map((event) => {
              const typeInfo = taskTypeInfo(event.taskType)
              const hasFailure =
                Boolean(event.reason) || ['failed', 'action-required'].includes(event.status)
              const failureText = event.reason ? friendlyFailureReason(event.reason) : null

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
                      {event.accountIndex ? `账号 ${event.accountIndex}` : '账号'} · {event.accountLabel}
                    </span>
                    <span className="stream-task-name">
                      <span className="task-icon">{typeInfo.icon}</span>
                      <strong>{event.taskName || typeInfo.label}</strong>
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
                      ) : null}
                      {event.earnedPoints != null && event.earnedPoints > 0 ? (
                        <span className="stream-points gained">
                          得分：<strong>{points(event.earnedPoints)}</strong>
                        </span>
                      ) : event.earnedPoints === 0 ? (
                        <span className="stream-points zero">
                          得分：0 分
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
