import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('container browser layering', () => {
  it('aligns the next.27 release metadata without changing the image channel', async () => {
    const [workflow, deployment, readme] = await Promise.all([
      readFile('.github/workflows/docker-image.yml', 'utf8'),
      readFile('docs/deployment.md', 'utf8'),
      readFile('README.md', 'utf8')
    ])
    expect(workflow).toMatch(/^\s*CORE_TAG: 5\.0\.0-next\.27\s*$/m)
    expect(workflow).not.toContain('CORE_TAG: 5.0.0-next.26')
    expect(workflow).toContain('APP_VERSION=${{ env.CORE_TAG }}')
    expect(workflow).toContain('--tag "$CORE_IMAGE:$CORE_TAG"')
    expect(workflow).toContain('--tag "$CORE_IMAGE:latest"')
    expect(deployment).toContain('成功后才更新 `5.0.0-next.27` 与 `latest`。')
    for (const documentation of [deployment, readme]) {
      expect(documentation).toContain('ghcr.io/saarjoye/mrs-core:5.0.0-next.27')
    }
  })

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
    expect(applicationDockerfile).toContain('RUN --network=none npm run build')
    expect(applicationDockerfile).toContain(
      'npm ci --omit=dev --offline --ignore-scripts --no-audit --no-fund --fetch-retries=0'
    )
    expect(applicationDockerfile).not.toContain('npm prune')
    expect(browserDockerfile).toContain('patchright install-deps chromium')
    expect(browserDockerfile).toContain('https://deb.debian.org/')
    expect(browserDockerfile).toContain('rootCertificates')
    expect(browserDockerfile).toContain(
      'apt-get install -y --no-install-recommends ca-certificates'
    )
    expect(browserDockerfile).toContain('rm -f /etc/apt/apt.conf.d/80-build-ca /tmp/build-ca.pem')
    expect(browserDockerfile).not.toContain('Verify-Peer "false"')
    expect(browserDockerfile).not.toContain('Verify-Host "false"')
    expect(browserDockerfile).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED')
    expect(
      browserDockerfile.indexOf('apt-get install -y --no-install-recommends ca-certificates')
    ).toBeLessThan(browserDockerfile.indexOf('patchright install-deps chromium'))
    expect(browserDockerfile).toContain('RUN patchright install chromium')
    expect(browserDockerfile).toContain('Acquire::Retries "2";')
    expect(browserDockerfile).toContain('rm -f /etc/apt/apt.conf.d/80-build-retries')
    expect(browserDockerfile).not.toContain('patchright install --with-deps')
    expect(browserDockerfile.indexOf('patchright install-deps chromium')).toBeLessThan(
      browserDockerfile.indexOf('RUN patchright install chromium')
    )
    expect(compose).not.toContain('browser-install:')
    expect(compose).not.toContain('playwright-browsers:')
  })

  it('keeps the LXC deployment independent, non-privileged and persistent', async () => {
    const compose = await readFile('compose.lxc.yaml', 'utf8')
    expect(compose).toContain('name: microsoft-rewards-next')
    expect(compose).toContain('image: microsoft-rewards-next:${IMAGE_TAG:-local}')
    expect(compose).toContain('BROWSER_IMAGE: microsoft-rewards-next-browser:patchright-1.61.1')
    expect(compose).toContain("RUN_ON_START: 'false'")
    expect(compose).toContain('init: true')
    expect(compose).toContain("shm_size: '512mb'")
    expect(compose).toContain('no-new-privileges:true')
    expect(compose).not.toContain('privileged:')
    for (const name of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy'
    ]) {
      expect(compose).not.toContain(`${name}:`)
    }
    for (const directory of ['data', 'sessions', 'logs', 'backups']) {
      expect(compose).toContain(`rewards-next-${directory}:/app/${directory}`)
    }
    expect(compose).toContain('CREDENTIAL_KEY_FILE: /run/secrets/rewards_master_key')
    expect(compose).toContain('file: ./secrets/rewards_master_key')
    expect(compose).toContain('WEB_ADMIN_PASSWORD: ${WEB_ADMIN_PASSWORD:-}')
  })

  it('excludes the whole SSH configuration directory from Git and Docker context', async () => {
    const [gitIgnore, dockerIgnore] = await Promise.all([
      readFile('.gitignore', 'utf8'),
      readFile('.dockerignore', 'utf8')
    ])
    expect(gitIgnore.split(/\r?\n/)).toContain('lxc106/')
    expect(dockerIgnore.split(/\r?\n/)).toContain('lxc106/')
    expect(gitIgnore.split(/\r?\n/)).toContain('.bootstrap.env')
    expect(dockerIgnore.split(/\r?\n/)).toContain('.bootstrap.env')
  })
})
