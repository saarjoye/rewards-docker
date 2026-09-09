import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { Card } from 'tdesign-react/es/card/index.js'
import { InputNumber } from 'tdesign-react/es/input-number/index.js'
import { Loading } from 'tdesign-react/es/loading/index.js'
import { Switch } from 'tdesign-react/es/switch/index.js'
import { Button, DataTable, Feedback, Field, PageHeader } from './UiKit'
import { clockTime } from './display'
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

export function NotificationSettings({
  csrfToken,
  onUnsavedChange
}: {
  csrfToken: string
  onUnsavedChange: (dirty: boolean) => void
}): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [corpId, setCorpId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [toUser, setToUser] = useState('@all')
  const [secret, setSecret] = useState('')
  const [maxAttempts, setMaxAttempts] = useState(5)
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    onUnsavedChange(dirty || busy)
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    if (dirty || busy) window.addEventListener('beforeunload', warn)
    return () => {
      onUnsavedChange(false)
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty, busy, onUnsavedChange])

  async function request<T>(suffix = '', method = 'GET', body?: object): Promise<T> {
    const response = await fetch(`/api/notifications/wecom${suffix}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-csrf-token': csrfToken
      },
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
        setApiBaseUrl(value.apiBaseUrl === 'https://qyapi.weixin.qq.com' ? '' : value.apiBaseUrl)
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
    if (busy) return
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
        maxAttempts,
        apiBaseUrl
      })
      setStatus(result)
      setSecret('')
      setDirty(false)
      setMessage('配置已加密保存。启用后结束的任务会进入通知队列。')
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : ''
      setError(errors[code] ?? `保存失败：${code}`)
    } finally {
      setBusy(false)
    }
  }

  async function test(): Promise<void> {
    if (busy || dirty) return
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

  const change = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setDirty(true)
  }
  return (
    <section className="notification-settings">
      <PageHeader title="消息推送" description="账号结束、整体汇总和中断通知分别处理" />
      <Feedback error={error} message={message} />
      {!status ? (
        !error && <Loading text="推送设置加载中" />
      ) : (
        <>
          <Card
            bordered={false}
            title="企业微信应用"
            subtitle="使用官方应用接口；已保存的 Secret 不会回显"
          >
            <form className="stack-form notification-form" onSubmit={(event) => void save(event)}>
              <div className="switch-row">
                <div>
                  <strong>启用企业微信推送</strong>
                  <p className="muted">保存后生效；关闭将暂停队列发送。</p>
                </div>
                <Switch
                  value={enabled}
                  aria-checked={enabled}
                  disabled={busy}
                  onChange={(value) => {
                    setEnabled(value)
                    setDirty(true)
                  }}
                  aria-label="启用企业微信推送"
                />
              </div>
              <div className="form-grid">
                <Field
                  label="企业微信反代地址"
                  value={apiBaseUrl}
                  onChange={change(setApiBaseUrl)}
                  maxLength={512}
                  disabled={busy}
                  placeholder="留空使用企业微信官方接口"
                  hint="填写您控制的 HTTPS 反代根地址，可带路径前缀；不带鉴权信息、查询参数。企业微信凭证和消息会经过该地址，仅影响通知，不影响 Rewards 网络。"
                />
                <Field
                  label="企业 ID"
                  value={corpId}
                  onChange={change(setCorpId)}
                  required={enabled}
                  maxLength={128}
                  disabled={busy}
                />
                <Field
                  label="应用 AgentId"
                  value={agentId}
                  onChange={change(setAgentId)}
                  required={enabled}
                  maxLength={16}
                  disabled={busy}
                />
                <Field
                  label="应用 Secret"
                  type="password"
                  value={secret}
                  onChange={change(setSecret)}
                  required={enabled && !status.hasSecret}
                  maxLength={512}
                  disabled={busy}
                  autoComplete="new-password"
                  placeholder={status.hasSecret ? '已保存；留空保持原值' : '请输入应用 Secret'}
                  hint={status.hasSecret ? '留空保存不会清除现有 Secret。' : undefined}
                />
                <Field
                  label="接收成员"
                  value={toUser}
                  onChange={change(setToUser)}
                  required
                  maxLength={1024}
                  disabled={busy}
                  hint="@all 表示应用可见范围内所有成员；多个成员 ID 用 | 分隔。"
                />
                <label className="form-field">
                  <span>最多发送尝试次数</span>
                  <InputNumber
                    value={maxAttempts}
                    min={1}
                    max={8}
                    disabled={busy}
                    onChange={(value) => {
                      setMaxAttempts(typeof value === 'number' ? value : 0)
                      setDirty(true)
                    }}
                  />
                  <small className="muted">失败后退避重试，耗尽后保留记录。</small>
                </label>
              </div>
              <div className="form-actions">
                <Button type="submit" loading={busy} disabled={maxAttempts < 1 || maxAttempts > 8}>
                  保存配置
                </Button>
                <Button
                  variant="outline"
                  disabled={!status.enabled || dirty || busy}
                  onClick={() => void test()}
                >
                  发送测试消息
                </Button>
                {dirty && <span className="unsaved-label">有未保存修改，请先保存再测试</span>}
              </div>
            </form>
          </Card>
          <Card
            bordered={false}
            title="最近通知"
            actions={
              <Button
                variant="text"
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
              </Button>
            }
          >
            {status.serviceError && <Feedback error="通知存储异常，请检查容器数据卷是否可写。" />}
            <p className="muted">
              “接口已接受”不代表客户端最终收到。发送后进程中断时，重试可能重复投递。
            </p>
            <DataTable
              rows={status.recent}
              rowKey={(job) => job.notificationKey}
              empty="暂无通知记录"
              columns={[
                {
                  key: 'kind',
                  title: '通知类型',
                  cell: (job) => (job.kind === 'account' ? '账号任务结束' : '运行汇总')
                },
                {
                  key: 'status',
                  title: '发送状态',
                  cell: (job) => states[job.status] ?? job.status
                },
                { key: 'attempts', title: '尝试次数', cell: (job) => job.attempts },
                {
                  key: 'time',
                  title: '接受时间 / 下次尝试',
                  cell: (job) =>
                    job.acceptedAt
                      ? clockTime(job.acceptedAt)
                      : job.status === 'pending'
                        ? clockTime(new Date(job.nextAttemptAt).toISOString())
                        : '—'
                },
                {
                  key: 'error',
                  title: '失败原因',
                  cell: (job) => (job.lastError ? (errors[job.lastError] ?? job.lastError) : '—')
                }
              ]}
            />
          </Card>
        </>
      )}
    </section>
  )
}
