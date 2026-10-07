import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ButtonProps } from 'tdesign-react'

import { Button } from '../src/web/ui/UiKit.js'

function render(props: ButtonProps): string {
  return renderToStaticMarkup(createElement(Button, props, '下载脱敏报告'))
}

describe('button navigation and disabled controls', () => {
  it('renders a native link that can navigate to the report download', () => {
    const href = '/api/runs/00000000-0000-4000-8000-000000000001/report'
    const html = render({ href, variant: 'text' })

    const anchor = html.match(/<a[^>]*>/)?.[0]
    expect(anchor).toBeDefined()
    expect(anchor).toContain(`href="${href}"`)
    expect(html).not.toContain('<button')
  })

  it('keeps action controls as native buttons', () => {
    const html = render({ type: 'button' })

    expect(html.match(/<button[^>]*>/)?.[0]).toContain('type="button"')
    expect(html).not.toContain('<a')
  })

  it('keeps disabled action controls natively disabled', () => {
    const html = render({ disabled: true })

    expect(html.match(/<button[^>]*>/)?.[0]).toContain('disabled')
    expect(html).not.toContain('<div')
  })

  it('prevents disabled links from exposing a navigable destination', () => {
    const html = render({ href: '/api/runs/synthetic/report', disabled: true })

    expect(html.match(/<button[^>]*>/)?.[0]).toContain('disabled')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<a')
  })

  it('prevents loading links from navigating while the control is busy', () => {
    const html = render({ href: '/api/runs/synthetic/report', loading: true })

    expect(html.match(/<button[^>]*>/)?.[0]).toContain('disabled')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('<a')
  })
})
