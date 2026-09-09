import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('container browser layering', () => {
  it('publishes Next through the existing core image without the old web service', async () => {
    const compose = await readFile('compose.yaml', 'utf8')
    const workflow = await readFile('.github/workflows/docker-image.yml', 'utf8')
    expect(compose).toContain('image: ghcr.io/saarjoye/mrs-core:latest')
    expect(compose).not.toContain('mrs-web')
    expect(compose).not.toContain('build:')
    expect(compose).not.toContain('PROXY')
    expect(compose).toContain('rewards-next-data:/app/data')
    expect(workflow).toContain('--network none')
    expect(workflow.indexOf('- name: Verify candidate')).toBeLessThan(
      workflow.indexOf('- name: Promote verified candidate')
    )
  })

  it('keeps Chromium installation in the pinned browser base only', async () => {
    const [applicationDockerfile, browserDockerfile, compose] = await Promise.all([
      readFile('Dockerfile', 'utf8'),
      readFile('docker/Dockerfile.browser', 'utf8'),
      readFile('compose.yaml', 'utf8')
    ])

    expect(applicationDockerfile).toContain(
      'ARG BROWSER_IMAGE=microsoft-rewards-next-browser:patchright-1.61.1'
    )
    expect(applicationDockerfile).toContain('FROM ${BROWSER_IMAGE} AS build')
    expect(applicationDockerfile).toContain('FROM ${BROWSER_IMAGE} AS runtime')
    expect(applicationDockerfile).not.toContain('patchright install')
    expect(browserDockerfile).toContain('patchright install --with-deps chromium')
    expect(compose).not.toContain('browser-install:')
    expect(compose).not.toContain('playwright-browsers:')
  })
})
