import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { Card } from 'tdesign-react/es/card/index.js'

import { Button, Feedback } from './UiKit'

export interface SearchSettingsAccount {
  readonly accountId: string
  readonly displayAlias?: string
  readonly maskedEmail?: string
  readonly runAccountIndex?: number
  readonly enabled?: boolean
}

export interface SearchSettingsData {
  delayMinSeconds: number
  delayMaxSeconds: number
  scroll: boolean
  clickResult: boolean
  stagnantLimit: number
  resultVisitSeconds: number
  quizPollEnabled?: boolean
  quizPollScope?: 'all' | 'selected'
  quizPollAccountIds?: readonly string[]
}

export function SearchSettings({
  csrfToken,
  onUnsavedChange,
  accounts: propAccounts
}: {
  csrfToken: string
  onUnsavedChange: (unsaved: boolean) => void
  accounts?: readonly SearchSettingsAccount[]
}): ReactElement {
  const [settings, setSettings] = useState<SearchSettingsData | null>(null)
  const [delayMin, setDelayMin] = useState('')
  const [delayMax, setDelayMax] = useState('')
  const [resultVisit, setResultVisit] = useState('')
  const [stagnantLimit, setStagnantLimit] = useState('')
  const [scroll, setScroll] = useState(false)
  const [clickResult, setClickResult] = useState(false)
  const [quizPollEnabled, setQuizPollEnabled] = useState(false)
  const [quizPollScope, setQuizPollScope] = useState<'all' | 'selected'>('all')
  const [quizPollAccountIds, setQuizPollAccountIds] = useState<string[]>([])
  const [loadedAccounts, setLoadedAccounts] = useState<readonly SearchSettingsAccount[]>([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const savingRef = useRef(false)

  useEffect(() => {
    if (propAccounts !== undefined && propAccounts.length > 0) return
    const controller = new AbortController()
    void fetch('/api/state', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return
        const data = (await response.json()) as { accounts?: SearchSettingsAccount[] }
        if (!controller.signal.aborted && Array.isArray(data.accounts)) {
          setLoadedAccounts(data.accounts)
        }
      })
      .catch(() => {})
    return () => {
      controller.abort()
    }
  }, [propAccounts])

  const accounts = propAccounts !== undefined && propAccounts.length > 0 ? propAccounts : loadedAccounts

  const isAccountIdsEqual = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length !== b.length) return false
    const setA = new Set(a)
    return b.every((id) => setA.has(id))
  }

  const savedQuizPollEnabled = settings?.quizPollEnabled ?? false
  const savedQuizPollScope = settings?.quizPollScope ?? 'all'
  const savedQuizPollAccountIds = settings?.quizPollAccountIds ?? []

  const quizPollDirty =
    settings !== null &&
    (quizPollEnabled !== savedQuizPollEnabled ||
      quizPollScope !== savedQuizPollScope ||
      !isAccountIdsEqual(quizPollAccountIds, savedQuizPollAccountIds))

  const dirty =
    settings !== null &&
    (Number(stagnantLimit) !== settings.stagnantLimit ||
      Number(delayMin) !== settings.delayMinSeconds ||
      Number(delayMax) !== settings.delayMaxSeconds ||
      Number(resultVisit) !== settings.resultVisitSeconds ||
      scroll !== settings.scroll ||
      clickResult !== settings.clickResult ||
      quizPollDirty)

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
        setStagnantLimit(String(data.stagnantLimit))
        setDelayMin(String(data.delayMinSeconds))
        setDelayMax(String(data.delayMaxSeconds))
        setResultVisit(String(data.resultVisitSeconds))
        setScroll(data.scroll)
        setClickResult(data.clickResult)
        setQuizPollEnabled(Boolean(data.quizPollEnabled))
        setQuizPollScope(data.quizPollScope === 'selected' ? 'selected' : 'all')
        setQuizPollAccountIds(Array.from(data.quizPollAccountIds ?? []))
      })
      .catch(() => {
        if (!controller.signal.aborted) setMessage('?????????????')
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
    const limit = Number(stagnantLimit)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
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
      setMessage('????????? 5?900 ?????????????? 1?120 ?????? 1?100?')
      return
    }
    if (quizPollEnabled && quizPollScope === 'selected' && quizPollAccountIds.length === 0) {
      setMessage('????????? Quiz / Poll ???????????????')
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
        resultVisitSeconds: visit,
        stagnantLimit: limit,
        quizPollEnabled,
        quizPollScope,
        quizPollAccountIds
      })
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('save')
        const data = (await response.json()) as SearchSettingsData
        setSettings(data)
        setStagnantLimit(String(data.stagnantLimit))
        setDelayMin(String(data.delayMinSeconds))
        setDelayMax(String(data.delayMaxSeconds))
        setResultVisit(String(data.resultVisitSeconds))
        setScroll(data.scroll)
        setClickResult(data.clickResult)
        setQuizPollEnabled(Boolean(data.quizPollEnabled))
        setQuizPollScope(data.quizPollScope === 'selected' ? 'selected' : 'all')
        setQuizPollAccountIds(Array.from(data.quizPollAccountIds ?? []))
        setMessage('????????????????????')
      })
      .catch(() => {
        setMessage('?????????????????')
      })
      .finally(() => {
        savingRef.current = false
        setSaving(false)
      })
  }

  return (
    <Card title="????">
      <p>
        ????????????????????????????????????????????
      </p>
      <form onSubmit={submit}>
        <p>
          <label>
            ??????????
            <input
              type="number"
              min="1"
              max="100"
              required
              value={stagnantLimit}
              disabled={settings === null || saving}
              onChange={(event) => {
                setStagnantLimit(event.target.value)
              }}
            />
          </label>
        </p>
        <p>
          ???????????
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
          ???????????
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
          ????????????????
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
            ??????
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
            ????????????
          </label>
        </p>

        <hr style={{ margin: '20px 0', borderColor: '#e7e7e7', borderStyle: 'solid', borderWidth: '1px 0 0 0' }} />
        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: 600 }}>Quiz / Poll ????</h4>
          <p style={{ margin: '0 0 12px 0', color: '#666', fontSize: '13px' }}>
            ????????????????? Quiz ??????????????
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                checked={quizPollEnabled}
                disabled={settings === null || saving}
                onChange={(event) => {
                  setQuizPollEnabled(event.target.checked)
                }}
              />
              ?? Quiz / Poll ????
            </label>
          </p>
        </div>

        {quizPollEnabled && (
          <div style={{ marginLeft: '20px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '24px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="quizPollScope"
                  value="all"
                  checked={quizPollScope === 'all'}
                  disabled={settings === null || saving}
                  onChange={() => {
                    setQuizPollScope('all')
                  }}
                />
                ????
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="quizPollScope"
                  value="selected"
                  checked={quizPollScope === 'selected'}
                  disabled={settings === null || saving}
                  onChange={() => {
                    setQuizPollScope('selected')
                  }}
                />
                ??????
              </label>
            </div>

            {quizPollScope === 'selected' && (
              <div style={{ marginTop: '8px', padding: '12px', background: '#f8f9fa', borderRadius: '6px', border: '1px solid #e5e5e5' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: '#333' }}>
                    ??????????
                  </span>
                  {accounts.length > 0 && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#0284c7',
                          cursor: 'pointer',
                          fontSize: '12px',
                          padding: 0
                        }}
                        disabled={settings === null || saving}
                        onClick={() => {
                          setQuizPollAccountIds(accounts.map((a) => a.accountId))
                        }}
                      >
                        ??
                      </button>
                      <span style={{ color: '#ccc', fontSize: '12px' }}>|</span>
                      <button
                        type="button"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#64748b',
                          cursor: 'pointer',
                          fontSize: '12px',
                          padding: 0
                        }}
                        disabled={settings === null || saving}
                        onClick={() => {
                          setQuizPollAccountIds([])
                        }}
                      >
                        ??
                      </button>
                    </div>
                  )}
                </div>
                {accounts.length === 0 ? (
                  <div style={{ color: '#888', fontSize: '12px' }}>??????????</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                    {accounts.map((account) => {
                      const checked = quizPollAccountIds.includes(account.accountId)
                      return (
                        <label
                          key={account.accountId}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={settings === null || saving}
                            onChange={(event) => {
                              if (event.target.checked) {
                                setQuizPollAccountIds([...quizPollAccountIds, account.accountId])
                              } else {
                                setQuizPollAccountIds(quizPollAccountIds.filter((id) => id !== account.accountId))
                              }
                            }}
                          />
                          <span>
                            {account.displayAlias || `?? ${account.runAccountIndex !== undefined ? String(account.runAccountIndex) : ''}`}
                            {account.maskedEmail ? ` (${account.maskedEmail})` : ''}
                            {account.enabled === false ? ' (???)' : ''}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <Button type="submit" disabled={settings === null || !dirty || saving}>
          {saving ? '????' : '??????'}
        </Button>
        {message &&
          (message.includes('??') || message.includes('???') || message.includes('??') ? (
            <Feedback error={message} />
          ) : (
            <Feedback message={message} />
          ))}
      </form>
    </Card>
  )
}
