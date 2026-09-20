import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Card } from 'tdesign-react/es/card/index.js'

import { Button, Feedback } from './UiKit'

export interface SearchSettingsData {
  delayMinSeconds: number
  delayMaxSeconds: number
  scroll: boolean
  clickResult: boolean
  resultVisitSeconds: number
}

export function SearchSettings({
  csrfToken,
  onUnsavedChange
}: {
  csrfToken: string
  onUnsavedChange: (unsaved: boolean) => void
}) {
  const [settings, setSettings] = useState<SearchSettingsData | null>(null)
  const [delayMin, setDelayMin] = useState('')
  const [delayMax, setDelayMax] = useState('')
  const [resultVisit, setResultVisit] = useState('')
  const [scroll, setScroll] = useState(false)
  const [clickResult, setClickResult] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const savingRef = useRef(false)

  const dirty =
    settings !== null &&
    (Number(delayMin) !== settings.delayMinSeconds ||
      Number(delayMax) !== settings.delayMaxSeconds ||
      Number(resultVisit) !== settings.resultVisitSeconds ||
      scroll !== settings.scroll ||
      clickResult !== settings.clickResult)

  useEffect(() => {
    onUnsavedChange(dirty || saving)
    return () => {
      onUnsavedChange(false)
    }
  }, [dirty, saving, onUnsavedChange])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/settings/search', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('load')
        const data = (await response.json()) as SearchSettingsData
        if (controller.signal.aborted) return
        setSettings(data)
        setDelayMin(String(data.delayMinSeconds))
        setDelayMax(String(data.delayMaxSeconds))
        setResultVisit(String(data.resultVisitSeconds))
        setScroll(data.scroll)
        setClickResult(data.clickResult)
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('读取失败，请刷新页面重试。')
      })
    return () => {
      controller.abort()
    }
  }, [])

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (savingRef.current || settings === null) return
    const min = Number(delayMin)
    const max = Number(delayMax)
    const visit = Number(resultVisit)
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      !Number.isInteger(visit) ||
      min < 5 ||
      min > 900 ||
      max < 5 ||
      max > 900 ||
      max < min ||
      visit < 1 ||
      visit > 120
    ) {
      setMessage('参数不合法：延迟需 5–900 秒且最大值≥最小值，结果停留 1–120 秒。')
      return
    }
    savingRef.current = true
    setSaving(true)
    setMessage('')
    fetch('/api/settings/search', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({
        delayMinSeconds: min,
        delayMaxSeconds: max,
        scroll,
        clickResult,
        resultVisitSeconds: visit
      })
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('save')
        const data = (await response.json()) as SearchSettingsData
        setSettings(data)
        setDelayMin(String(data.delayMinSeconds))
        setDelayMax(String(data.delayMaxSeconds))
        setResultVisit(String(data.resultVisitSeconds))
        setScroll(data.scroll)
        setClickResult(data.clickResult)
        setMessage('已保存，下一次搜索立即生效。')
      })
      .catch(() => {
        setMessage('保存失败，原设置保持不变，请重试。')
      })
      .finally(() => {
        savingRef.current = false
        setSaving(false)
      })
  }

  return (
    <Card title="搜索设置">
      <p>
        控制搜索每条之间的随机等待时间（秒）与结果页停留行为。保存后无需重启，下一次搜索即生效。
      </p>
      <form onSubmit={submit}>
        <p>
          每条搜索最小延迟（秒）
          <input
            type="number"
            min="5"
            max="900"
            required
            value={delayMin}
            disabled={settings === null || saving}
            onChange={(event) => {
              setDelayMin(event.target.value)
            }}
          />
        </p>
        <p>
          每条搜索最大延迟（秒）
          <input
            type="number"
            min="5"
            max="900"
            required
            value={delayMax}
            disabled={settings === null || saving}
            onChange={(event) => {
              setDelayMax(event.target.value)
            }}
          />
        </p>
        <p>
          结果页停留（秒，点击结果时生效）
          <input
            type="number"
            min="1"
            max="120"
            required
            value={resultVisit}
            disabled={settings === null || saving}
            onChange={(event) => {
              setResultVisit(event.target.value)
            }}
          />
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={scroll}
              disabled={settings === null || saving}
              onChange={(event) => {
                setScroll(event.target.checked)
              }}
            />
            随机滚动页面
          </label>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              checked={clickResult}
              disabled={settings === null || saving}
              onChange={(event) => {
                setClickResult(event.target.checked)
              }}
            />
            点击并访问第一条搜索结果
          </label>
        </p>
        <Button type="submit" disabled={settings === null || !dirty || saving}>
          {saving ? '保存中…' : '保存搜索设置'}
        </Button>
        {message &&
          (message.includes('失败') || message.includes('不合法') ? (
            <Feedback error={message} />
          ) : (
            <Feedback message={message} />
          ))}
      </form>
    </Card>
  )
}