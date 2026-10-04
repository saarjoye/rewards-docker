import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { AccountsPage } from '../src/web/ui/ConsolePages.js'

const account = {
  accountId: 'synthetic-account',
  runAccountIndex: 1,
  displayAlias: 'Synthetic Account',
  maskedEmail: 's***@example.test',
  enabled: true
}

function render(running: boolean): string {
  return renderToStaticMarkup(
    createElement(AccountsPage, {
      accounts: [account],
      busy: false,
      running,
      add: vi.fn(),
      edit: vi.fn(),
      toggle: vi.fn(),
      remove: vi.fn()
    })
  )
}

describe('account management actions', () => {
  it('offers an accessible delete control for an idle account', () => {
    const html = render(false)
    const deleteButton = html.match(/<button[^>]*aria-label="删除账号 1"[^>]*>/)?.[0]
    expect(deleteButton).toBeDefined()
    expect(deleteButton).toContain('title="删除账号"')
    expect(deleteButton).not.toContain('disabled')
  })

  it('disables deletion while a run is active', () => {
    const html = render(true)
    const deleteButton = html.match(/<button[^>]*aria-label="删除账号 1"[^>]*>/)?.[0]
    expect(deleteButton).toContain('disabled')
  })
})
