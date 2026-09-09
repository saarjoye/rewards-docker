import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import type { Notifications } from '../../notifications/Notifications.js'

type Status = ReturnType<Notifications['status']>
const errors: Record<string, string> = {
  'notification-busy': '通知正在发送，请稍后重试。',
  'notification-config-incomplete': '请填写企业 ID、应用 AgentId 和 Secret。',
  'notifications-disabled': '请先启用并保存配置，再发送测试消息。',
  'network-or-provider-error': '无法连接企业微信，请检查网络和应用可信 IP。',
  'provider-rejected': '企业微信未完整接受消息，请检查接收成员及应用可见范围。',
  'notifications-unavailable': '通知服务尚未就绪。',
  'invalid-request': '配置格式无效，请检查各字段。'
}
const states: Record<string, string> = {
  sending: '发送中',
  sent: '接口已接受',
  pending: '等待发送 / 重试',
  accepted: '接口已接受',
  failed: '重试已耗尽',
  cancelled: '收件配置已变更，已取消'
}

export function NotificationSettings({ csrfToken }: { csrfToken: string }): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [corpId, setCorpId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [toUser, setToUser] = useState('@all')
  const [secret, setSecret] = useState('')
  const [maxAttempts, setMaxAttempts] = useState(5)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function request<T>(suffix = '', method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/notifications/wecom${suffix}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrfToken },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    const result = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(result.error ?? '请求失败')
    return result
  }

  useEffect(() => {
    let active = true
    void request<Status>()
      .then((value) => {
        if (!active) return
        setStatus(value)
        setEnabled(value.enabled)
        setCorpId(value.corpId)
        setAgentId(value.agentId)
        setToUser(value.toUser)
        setMaxAttempts(value.maxAttempts)
      })
      .catch(() => {
        if (active) setError('无法加载推送设置，请重新进入此页面。')
      })
    return () => {
      active = false
    }
  }, [csrfToken])

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await request<Status>('', 'PUT', {
        enabled,
        corpId,
        agentId,
        corpSecret: secret,
        toUser,
        maxAttempts
      })
      setStatus(result)
      setSecret('')
      setDirty(false)
      setMessage('配置已加密保存。自动通知适用于启用后新建的运行。')
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : ''
      setError(errors[code] ?? `保存失败：${code}`)
    } finally {
      setBusy(false)
    }
  }

  async function test(): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await request('/test', 'POST')
      setMessage('企业微信接口已接受测试消息，请到客户端确认是否收到。')
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : ''
      setError(errors[code] ?? `测试失败：${code}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="notification-settings" aria-labelledby="notification-title">
      <h2 id="notification-title">消息推送</h2>
      <p>企业微信应用通知 · 账号任务结束、运行汇总及运行中断分别通知。</p>
      <p className="muted">使用企业微信官方接口。Next 不读取旧 Web 的密钥，请重新填写应用配置。</p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {!status ? (
        <p>推送设置加载中</p>
      ) : (
        <>
          <form
            onSubmit={(event) => void save(event)}
            onChange={() => {
              setDirty(true)
            }}
          >
            <fieldset disabled={busy}>
              <label className="notification-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => {
                    setEnabled(event.target.checked)
                  }}
                />
                启用企业微信推送
              </label>
              <label>
                企业 ID
                <input
                  value={corpId}
                  onChange={(event) => {
                    setCorpId(event.target.value)
                  }}
                  maxLength={128}
                  required={enabled}
                  autoComplete="off"
                />
              </label>
              <label>
                应用 AgentId
                <input
                  value={agentId}
                  onChange={(event) => {
                    setAgentId(event.target.value)
                  }}
                  inputMode="numeric"
                  pattern="[0-9]+"
                  maxLength={16}
                  required={enabled}
                />
              </label>
              <label>
                应用 Secret
                <input
                  type="password"
                  value={secret}
                  onChange={(event) => {
                    setSecret(event.target.value)
                  }}
                  autoComplete="new-password"
                  maxLength={512}
                  placeholder={status.hasSecret ? '已保存；留空保持原值' : '请输入应用 Secret'}
                  required={enabled && !status.hasSecret}
                />
              </label>
              <label>
                接收成员
                <input
                  value={toUser}
                  onChange={(event) => {
                    setToUser(event.target.value)
                  }}
                  maxLength={1024}
                  required
                />
                <span className="muted">
                  @all 为应用可见范围内所有成员；多个成员 ID 用 | 分隔。
                </span>
              </label>
              <label>
                最多发送尝试次数
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={maxAttempts}
                  onChange={(event) => {
                    setMaxAttempts(Number(event.target.value))
                  }}
                  required
                />
              </label>
              <div className="notification-actions">
                <button type="submit" className="primary">
                  {busy ? '处理中…' : '保存配置'}
                </button>
                <button
                  type="button"
                  disabled={!status.enabled || dirty}
                  onClick={() => {
                    void test()
                  }}
                >
                  发送测试消息
                </button>
              </div>
              {dirty && <p className="muted">有未保存的修改，请先保存再测试。</p>}
            </fieldset>
          </form>
          <h3>最近通知</h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void request<Status>()
                .then(setStatus)
                .catch(() => {
                  setError('刷新通知记录失败')
                })
                .finally(() => {
                  setBusy(false)
                })
            }}
          >
            刷新通知记录
          </button>
          {status.serviceError && <p role="alert">通知存储异常，请检查容器数据卷是否可写。</p>}
          <p className="muted">
            接口接受不代表客户端最终收到。网络响应丢失或进程在发送后中断时，重试可能重复投递。
          </p>
          {status.recent.length === 0 ? (
            <p>暂无通知记录</p>
          ) : (
            <ul className="notification-records">
              {status.recent.map((job) => (
                <li key={job.notificationKey}>
                  <strong>{job.kind === 'account' ? '账号任务结束' : '运行汇总'}</strong>
                  <span>
                    {states[job.status] ?? job.status} · 已尝试 {job.attempts} 次
                  </span>
                  {job.acceptedAt && (
                    <span>
                      {new Date(job.acceptedAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false
                      })}
                    </span>
                  )}
                  {job.lastError && <span>原因：{errors[job.lastError] ?? job.lastError}</span>}
                  {job.status === 'pending' && (
                    <span>
                      下次尝试：
                      {new Date(job.nextAttemptAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
