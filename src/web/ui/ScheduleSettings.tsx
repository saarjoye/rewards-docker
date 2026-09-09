import { useEffect, useRef, useState } from 'react'
import { Card } from 'tdesign-react/es/card/index.js'
import { Button, Feedback } from './UiKit'

interface Schedule {
  enabled: boolean
  time: string
  nextRunAt: string | null
}
export function ScheduleSettings({
  csrfToken,
  onUnsavedChange
}: {
  csrfToken: string
  onUnsavedChange: (value: boolean) => void
}) {
  const [saved, setSaved] = useState<Schedule>()
  const [enabled, setEnabled] = useState(true)
  const [time, setTime] = useState('07:00')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const submitting = useRef(false)
  const dirty = Boolean(saved && (saved.enabled !== enabled || saved.time !== time))
  useEffect(() => {
    onUnsavedChange(dirty || busy)
    return () => {
      onUnsavedChange(false)
    }
  }, [dirty, busy, onUnsavedChange])
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/settings/schedule', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('load')
        const value = (await response.json()) as Schedule
        if (controller.signal.aborted) return
        setSaved(value)
        setEnabled(value.enabled)
        setTime(value.time)
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('读取失败，请刷新页面重试。')
      })
    return () => {
      controller.abort()
    }
  }, [])
  return (
    <Card title="定时任务">
      <p>
        使用上海时间，每天执行一次全部已启用账号。已有运行时跳过本次触发，不启动并发批次。保存不会立即执行任务。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (submitting.current) return
          submitting.current = true
          setBusy(true)
          setMessage('')
          void fetch('/api/settings/schedule', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': csrfToken
            },
            body: JSON.stringify({ enabled, time })
          })
            .then(async (response) => {
              if (!response.ok) throw new Error('save')
              setSaved((await response.json()) as Schedule)
              setMessage('已保存，定时计划立即生效。')
            })
            .catch(() => {
              setMessage('保存失败，原计划保持不变，请重试。')
            })
            .finally(() => {
              submitting.current = false
              setBusy(false)
            })
        }}
      >
        <p>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!saved || busy}
              onChange={(event) => {
                setEnabled(event.target.checked)
              }}
            />
            启用每日定时任务
          </label>
        </p>
        <p>
          <label>
            每日执行时间（Asia/Shanghai）{' '}
            <input
              type="time"
              required
              value={time}
              disabled={!saved || busy}
              onChange={(event) => {
                setTime(event.target.value)
              }}
            />
          </label>
        </p>
        {saved && !saved.time && <p>当前使用自定义启动计划，选择每日时间并保存后才会替换。</p>}
        <p>
          下次执行：
          {saved?.nextRunAt
            ? new Date(saved.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            : saved
              ? '已停用'
              : '—'}
        </p>
        <Button type="submit" disabled={!saved || !dirty || busy}>
          {busy ? '保存中…' : '保存定时设置'}
        </Button>
        {message && <Feedback {...(message.includes('失败') ? { error: message } : { message })} />}
      </form>
    </Card>
  )
}
