import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'patchright'

import {
  AcceptanceConfigurationError,
  classifyAcceptanceRegion,
  createAcceptanceAccountReport,
  loginWithManualAssistance,
  readAcceptanceAccounts,
  runAcceptanceSequence,
  selectAcceptanceAccounts,
  type AcceptanceInspection
} from '../src/acceptance/AccountAcceptance.js'
import { LoginStateError, type LoginState } from '../src/auth/LoginState.js'
import type { AccountBrowserSlot } from '../src/browser/BrowserRuntime.js'
import { createEvidence, type FieldAvailability } from '../src/domain/Evidence.js'
import type { CanonicalTaskType, TaskRecord, TaskStatus } from '../src/domain/Task.js'

const observedAt = '2026-09-04T00:00:00.000Z'

function evidence<T>(value: T) {
  return createEvidence({
    availability: 'valid' as const,
    source: 'bing-flyout' as const,
    confidence: 0.95,
    observedAt,
    value
  })
}

function unavailable<T>(availability: FieldAvailability = 'missing') {
  return createEvidence<T>({
    availability,
    source: 'bing-flyout',
    confidence: 0,
    observedAt,
    reason: 'synthetic unavailable field'
  })
}

function task(
  type: CanonicalTaskType,
  status: TaskStatus = 'discovered',
  executable = type !== 'unknown'
): TaskRecord {
  return {
    taskId: `acceptance:date:${type}`,
    accountId: 'acceptance',
    localDate: '2026-09-04',
    sourceTaskId: type,
    type,
    source: 'rsc',
    displayName: 'Synthetic task',
    executable,
    required: type === 'pc-search',
    status,
    progress: status === 'skipped' ? { completed: 1, total: 1 } : { completed: 0, total: 1 },
    updatedAt: observedAt
  }
}

const allTaskTypes: readonly CanonicalTaskType[] = [
  'claim-bonus-points',
  'app-activity',
  'daily-set',
  'special-promotion',
  'more-promotion',
  'app-check-in',
  'read-to-earn',
  'punch-card',
  'mobile-search',
  'pc-search'
]

function inspection(market = evidence('CN')): AcceptanceInspection {
  return {
    loginStage: 'login-complete',
    loginTransitions: [
      {
        phase: 'microsoft',
        state: 'email-input',
        stage: 'login-email',
        location: 'login-live'
      },
      {
        phase: 'microsoft',
        state: 'password-input',
        stage: 'login-password',
        location: 'login-live'
      }
    ],
    executionCapabilities: allTaskTypes.map((type) => ({
      type,
      path:
        type === 'pc-search' || type === 'mobile-search'
          ? ('search-browser' as const)
          : type === 'app-activity' || type === 'app-check-in' || type === 'read-to-earn'
            ? ('app-api' as const)
            : ('report-activity' as const)
    })),
    market,
    searchCounters: {
      pc: evidence({ completed: 0, total: 60, remaining: 60 }),
      mobile: unavailable('missing')
    },
    dataSources: {
      rsc: true,
      dom: true,
      dashboard: true,
      flyout: true,
      'app-dashboard': false
    },
    tasks: [
      ...allTaskTypes.map((type) =>
        type === 'claim-bonus-points' ? task(type, 'skipped', false) : task(type)
      ),
      task('unknown', 'unknown', false)
    ]
  }
}

describe('acceptance account input', () => {
  it('reads exactly three stable account indexes without exposing values', () => {
    const env = {
      ACCOUNT_1_EMAIL: 'first@synthetic.test',
      ACCOUNT_1_PASSWORD: 'password-one-canary',
      ACCOUNT_2_EMAIL: 'second@synthetic.test',
      ACCOUNT_2_PASSWORD: 'password-two-canary',
      ACCOUNT_3_EMAIL: 'third@synthetic.test',
      ACCOUNT_3_PASSWORD: 'password-three-canary'
    }
    const accounts = readAcceptanceAccounts(env)
    expect(accounts.map((account) => account.accountIndex)).toEqual([1, 2, 3])
    expect(accounts[0]?.credentials.email).toBe(env.ACCOUNT_1_EMAIL)
  })

  it.each([
    [{}, 'incomplete-account-1'],
    [
      {
        ACCOUNT_1_EMAIL: 'first@synthetic.test',
        ACCOUNT_1_PASSWORD: 'one',
        ACCOUNT_2_EMAIL: 'second@synthetic.test',
        ACCOUNT_2_PASSWORD: '',
        ACCOUNT_3_EMAIL: 'third@synthetic.test',
        ACCOUNT_3_PASSWORD: 'three'
      },
      'incomplete-account-2'
    ],
    [
      {
        ACCOUNT_1_EMAIL: 'first@synthetic.test',
        ACCOUNT_1_PASSWORD: 'one',
        ACCOUNT_2_EMAIL: 'second@synthetic.test',
        ACCOUNT_2_PASSWORD: 'two',
        ACCOUNT_3_EMAIL: 'third@synthetic.test',
        ACCOUNT_3_PASSWORD: 'three',
        ACCOUNT_4_EMAIL: 'extra@synthetic.test'
      },
      'unexpected-account-index'
    ]
  ])('rejects incomplete or extra configuration without values', (env, code) => {
    let error: unknown
    try {
      readAcceptanceAccounts(env)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AcceptanceConfigurationError)
    expect((error as AcceptanceConfigurationError).code).toBe(code)
    expect(String(error)).not.toContain('synthetic.test')
  })

  it('selects one 1-based account without shifting the configured index', () => {
    const accounts = readAcceptanceAccounts({
      ACCOUNT_1_EMAIL: 'first@synthetic.test',
      ACCOUNT_1_PASSWORD: 'one',
      ACCOUNT_2_EMAIL: 'second@synthetic.test',
      ACCOUNT_2_PASSWORD: 'two',
      ACCOUNT_3_EMAIL: 'third@synthetic.test',
      ACCOUNT_3_PASSWORD: 'three'
    })

    expect(selectAcceptanceAccounts([], accounts).map((account) => account.accountIndex)).toEqual([
      1, 2, 3
    ])
    expect(
      selectAcceptanceAccounts(['--account-index=1'], accounts).map(
        (account) => account.accountIndex
      )
    ).toEqual([1])
    expect(
      selectAcceptanceAccounts(['--account-index=3'], accounts).map(
        (account) => account.accountIndex
      )
    ).toEqual([3])
  })

  it.each<[string[], string]>([
    [['--account-index=0'], 'account-index-out-of-range'],
    [['--account-index=-1'], 'account-index-invalid'],
    [['--account-index=4'], 'account-index-out-of-range'],
    [['--account-index=two'], 'account-index-invalid'],
    [['--account-index=1', '--account-index=2'], 'account-index-duplicate']
  ])('rejects an invalid single-account selection', (args, code) => {
    const accounts = [
      { accountIndex: 1, credentials: { email: 'first@synthetic.test', password: 'one' } },
      { accountIndex: 2, credentials: { email: 'second@synthetic.test', password: 'two' } },
      { accountIndex: 3, credentials: { email: 'third@synthetic.test', password: 'three' } }
    ]

    let error: unknown
    try {
      selectAcceptanceAccounts(args, accounts)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AcceptanceConfigurationError)
    expect((error as AcceptanceConfigurationError).code).toBe(code)
  })
})

describe('acceptance report', () => {
  it('classifies CN, other markets and missing evidence without exposing credentials', () => {
    expect(classifyAcceptanceRegion(evidence('CN'))).toBe('confirmed-cn')
    expect(classifyAcceptanceRegion(evidence('US'))).toBe('region-mismatch')
    expect(classifyAcceptanceRegion(unavailable())).toBe('region-unconfirmed')

    const report = createAcceptanceAccountReport({
      accountIndex: 1,
      inspection: inspection(),
      durationMs: 25
    })
    const serialized = JSON.stringify(report)
    expect(report.status).toBe('passed')
    expect(report.loginTransitions.map((transition) => transition.state)).toEqual([
      'email-input',
      'password-input'
    ])
    expect(report.tasks.filter((item) => item.type !== 'unknown')).toHaveLength(10)
    expect(report.tasks.find((item) => item.type === 'unknown')).toMatchObject({
      executable: 0,
      statuses: ['unknown'],
      statusCounts: [{ status: 'unknown', count: 1 }],
      executionPaths: []
    })
    expect(report.tasks.find((item) => item.type === 'pc-search')?.executionPaths).toEqual([
      { path: 'search-browser', count: 1 }
    ])
    expect(report.claimStatus).toBe('skipped')
    expect(serialized).not.toContain('first@synthetic.test')
    expect(serialized).not.toContain('password-one-canary')
  })

  it('does not report skipped when a claim task lacks confirmed zero semantics', () => {
    const source = inspection()
    const claim = task('claim-bonus-points', 'skipped', false)
    claim.progress = { completed: 0, total: 1 }
    const report = createAcceptanceAccountReport({
      accountIndex: 1,
      inspection: { ...source, tasks: [claim] },
      durationMs: 1
    })
    expect(report.claimStatus).toBe('unknown')
  })
})

describe('manual login assistance', () => {
  it.each<LoginState>(['otp-code-entry', 'captcha', 'passkey-error'])(
    'waits for %s and resumes the existing page',
    async (state) => {
      const initialError = new LoginStateError({
        loginState: state,
        loginStage: `login-${state}`,
        message: 'Synthetic user action required',
        url: 'https://login.example.test/path',
        host: 'login.example.test',
        path: '/path'
      })
      const controller = {
        login: vi.fn().mockRejectedValueOnce(initialError).mockResolvedValue(undefined),
        detectCurrentState: vi.fn().mockResolvedValue({
          state: 'logged-in',
          loginStage: 'login-candidate',
          url: 'https://rewards.example.test/dashboard',
          host: 'rewards.example.test',
          path: '/dashboard'
        })
      }
      await expect(
        loginWithManualAssistance({
          controller,
          page: {} as Page,
          credentials: { email: 'synthetic@example.test', password: 'password-canary' },
          signal: new AbortController().signal,
          sleep: () => Promise.resolve()
        })
      ).resolves.toBe('login-complete-after-user-action')
      expect(controller.login).toHaveBeenCalledTimes(2)
    }
  )

  it('stops after the bounded manual-action deadline', async () => {
    let now = 0
    const initialError = new LoginStateError({
      loginState: 'captcha',
      loginStage: 'login-captcha',
      message: 'Synthetic CAPTCHA',
      url: 'https://login.example.test/path',
      host: 'login.example.test',
      path: '/path'
    })
    const controller = {
      login: vi.fn().mockRejectedValue(initialError),
      detectCurrentState: vi.fn().mockResolvedValue({
        state: 'captcha',
        loginStage: 'login-captcha',
        url: 'https://login.example.test/path',
        host: 'login.example.test',
        path: '/path'
      })
    }
    await expect(
      loginWithManualAssistance({
        controller,
        page: {} as Page,
        credentials: { email: 'synthetic@example.test', password: 'password-canary' },
        signal: new AbortController().signal,
        manualTimeoutMs: 20,
        pollIntervalMs: 10,
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds
          return Promise.resolve()
        }
      })
    ).rejects.toMatchObject({ status: 'action-required', code: 'user-action-timeout' })
  })
})

describe('three-account isolation', () => {
  it('uses distinct contexts and never commits sessions', async () => {
    const accounts = readAcceptanceAccounts({
      ACCOUNT_1_EMAIL: 'first@synthetic.test',
      ACCOUNT_1_PASSWORD: 'one',
      ACCOUNT_2_EMAIL: 'second@synthetic.test',
      ACCOUNT_2_PASSWORD: 'two',
      ACCOUNT_3_EMAIL: 'third@synthetic.test',
      ACCOUNT_3_PASSWORD: 'three'
    })
    const contexts = [{}, {}, {}] as BrowserContext[]
    const commitVerified = vi.fn()
    const close = vi.fn().mockResolvedValue(undefined)
    const openSlot = vi.fn((account: (typeof accounts)[number]) =>
      Promise.resolve({
        slot: 'web-desktop',
        context: contexts[account.accountIndex - 1],
        page: {} as Page,
        close,
        commitVerified
      } as AccountBrowserSlot)
    )
    const inspect = vi.fn().mockResolvedValue(inspection())
    const report = await runAcceptanceSequence(accounts, {
      openSlot,
      inspect,
      now: () => 100,
      generatedAt: () => observedAt
    })

    expect(report.accounts.map((account) => account.accountIndex)).toEqual([1, 2, 3])
    expect(report.accounts.every((account) => account.status === 'passed')).toBe(true)
    expect(new Set(contexts)).toHaveLength(3)
    expect(close).toHaveBeenCalledTimes(3)
    expect(commitVerified).not.toHaveBeenCalled()
  })

  it('rejects a context reused by another account', async () => {
    const accounts = readAcceptanceAccounts({
      ACCOUNT_1_EMAIL: 'first@synthetic.test',
      ACCOUNT_1_PASSWORD: 'one',
      ACCOUNT_2_EMAIL: 'second@synthetic.test',
      ACCOUNT_2_PASSWORD: 'two',
      ACCOUNT_3_EMAIL: 'third@synthetic.test',
      ACCOUNT_3_PASSWORD: 'three'
    })
    const context = {} as BrowserContext
    const commitVerified = vi.fn()
    const slot = {
      slot: 'web-desktop',
      context,
      page: {} as Page,
      close: vi.fn().mockResolvedValue(undefined),
      commitVerified
    } as AccountBrowserSlot
    const report = await runAcceptanceSequence(accounts, {
      openSlot: () => Promise.resolve(slot),
      inspect: () => Promise.resolve(inspection())
    })
    expect(report.accounts.map((account) => account.status)).toEqual(['passed', 'failed', 'failed'])
    expect(report.accounts[1]).toMatchObject({
      loginStage: 'context-isolation',
      errorCode: 'context-reused'
    })
    expect(commitVerified).not.toHaveBeenCalled()
  })

  it('reduces login alert text to a non-sensitive error code', async () => {
    const accounts = readAcceptanceAccounts({
      ACCOUNT_1_EMAIL: 'first@synthetic.test',
      ACCOUNT_1_PASSWORD: 'one',
      ACCOUNT_2_EMAIL: 'second@synthetic.test',
      ACCOUNT_2_PASSWORD: 'two',
      ACCOUNT_3_EMAIL: 'third@synthetic.test',
      ACCOUNT_3_PASSWORD: 'three'
    })
    const report = await runAcceptanceSequence(accounts.slice(0, 1), {
      openSlot: () =>
        Promise.resolve({
          slot: 'web-desktop',
          context: {} as BrowserContext,
          page: {} as Page,
          close: () => Promise.resolve(),
          commitVerified: vi.fn()
        }),
      inspect: () =>
        Promise.reject(
          new LoginStateError({
            loginState: 'error-alert',
            loginStage: 'login-error-alert',
            message: 'Password is incorrect for first@synthetic.test',
            url: 'https://login.example.test/path',
            host: 'login.example.test',
            path: '/path'
          })
        )
    })
    expect(report.accounts[0]).toMatchObject({
      errorCode: 'login-invalid-credentials',
      loginStage: 'login-error-alert'
    })
    expect(JSON.stringify(report)).not.toContain('first@synthetic.test')
  })
})
