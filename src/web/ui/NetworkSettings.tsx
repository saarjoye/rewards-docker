import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { Card } from 'tdesign-react/es/card/index.js'
import { InternetIcon, CheckCircleIcon, CloseCircleIcon } from 'tdesign-icons-react'

import { Button, Feedback } from './UiKit'

export interface NetworkSettingsData {
  lockRegion: boolean
  proxyUrl: string
}

export interface RegionTestResult {
  allowed: boolean
  region?: string
  ipInfo?: string
  message: string
}

export function NetworkSettings({
  csrfToken,
  onUnsavedChange
}: {
  csrfToken: string
  onUnsavedChange: (unsaved: boolean) => void
}): ReactElement {
  const [settings, setSettings] = useState<NetworkSettingsData | null>(null)
  const [lockRegion, setLockRegion] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<RegionTestResult | null>(null)
  const [message, setMessage] = useState('')
  const savingRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/settings/network', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('读取网络设置失败')
        return (await response.json()) as NetworkSettingsData
      })
      .then((data) => {
        if (controller.signal.aborted) return
        setSettings(data)
        setLockRegion(data.lockRegion)
        setProxyUrl(data.proxyUrl)
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('网络设置读取失败')
      })
    return () => {
      controller.abort()
    }
  }, [])

  const unsaved =
    settings !== null &&
    (lockRegion !== settings.lockRegion || proxyUrl.trim() !== settings.proxyUrl.trim())

  useEffect(() => {
    if (savingRef.current) return
    onUnsavedChange(unsaved)
  }, [unsaved, onUnsavedChange])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    savingRef.current = true
    setMessage('')
    try {
      const response = await fetch('/api/settings/network', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
          lockRegion,
          proxyUrl: proxyUrl.trim()
        })
      })
      if (!response.ok) throw new Error('保存网络设置失败')
      const updated = (await response.json()) as NetworkSettingsData
      setSettings(updated)
      setLockRegion(updated.lockRegion)
      setProxyUrl(updated.proxyUrl)
      setMessage('网络设置已保存')
      onUnsavedChange(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  const testNetwork = async () => {
    setTesting(true)
    setTestResult(null)
    setMessage('')
    try {
      const response = await fetch('/api/settings/network/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        }
      })
      if (!response.ok) throw new Error('网络探测请求失败')
      const result = (await response.json()) as RegionTestResult
      setTestResult(result)
    } catch (error) {
      setTestResult({
        allowed: false,
        message: error instanceof Error ? error.message : '探测请求失败'
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="settings-page">
      <Card
        title="网络代理与国区安全锁"
        subtitle="配置网络出口代理与防止账号海外风控的国区安全锁"
        bordered={false}
      >
        <Feedback error={message} />

        <form onSubmit={(e) => void save(e)} className="settings-form">
          <div className="form-group-checkbox">
            <label className="checkbox-label" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={lockRegion}
                onChange={(e) => { setLockRegion(e.target.checked); }}
                style={{ marginTop: '3px' }}
              />
              <div>
                <strong>开启国区安全锁 (Region Lock)</strong>
                <p className="muted" style={{ margin: '4px 0 0 0', fontSize: '12px' }}>
                  开启后，任务启动前将向微软 Bing 探测当前网络出口。若判定非中国大陆地区 (CN)，将主动阻断任务执行，彻底防止账号被微软风控锁区。
                </p>
              </div>
            </label>
          </div>

          <div className="form-group" style={{ marginTop: '16px' }}>
            <label htmlFor="proxyUrlInput">
              <strong>网络代理服务地址 (Proxy URL)</strong>
            </label>
            <input
              id="proxyUrlInput"
              type="text"
              placeholder="例如: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080 (留空为直连)"
              value={proxyUrl}
              onChange={(e) => { setProxyUrl(e.target.value); }}
              className="text-input"
              style={{ width: '100%', marginTop: '6px' }}
            />
            <small className="muted" style={{ display: 'block', marginTop: '4px' }}>
              支持 HTTP、HTTPS 或 SOCKS5 代理。留空表示直连宿主机默认网络。
            </small>
          </div>

          <div style={{ display: 'flex', gap: '12px', marginTop: '20px', alignItems: 'center' }}>
            <Button type="submit" loading={saving} disabled={!unsaved || saving}>
              保存设置
            </Button>
            <Button
              type="button"
              variant="outline"
              icon={<InternetIcon />}
              loading={testing}
              disabled={testing}
              onClick={() => void testNetwork()}
            >
              探测当前网络环境
            </Button>
          </div>
        </form>

        {testResult && (
          <div
            className={`test-result-box ${testResult.allowed ? 'test-result-success' : 'test-result-warn'}`}
            style={{
              marginTop: '20px',
              padding: '14px 16px',
              borderRadius: '8px',
              border: `1px solid ${testResult.allowed ? '#86efac' : '#fca5a5'}`,
              background: testResult.allowed ? '#f0fdf4' : '#fef2f2'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              {testResult.allowed ? (
                <CheckCircleIcon style={{ color: '#16a34a', fontSize: '18px' }} />
              ) : (
                <CloseCircleIcon style={{ color: '#dc2626', fontSize: '18px' }} />
              )}
              <span>{testResult.allowed ? '安全检测通过' : '安全检测拦截告警'}</span>
            </div>
            <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: '#374151' }}>
              {testResult.message}
            </p>
            {testResult.region && (
              <div style={{ marginTop: '6px', fontSize: '12px', color: '#6b7280' }}>
                微软出口地区代号: <strong>{testResult.region}</strong>
                {testResult.ipInfo ? ` | ${testResult.ipInfo}` : ''}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
