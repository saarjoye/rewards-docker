const fs = require('node:fs')

const DEFAULT_BROWSERS_PATH = '/ms-playwright'
const INSTALL_COMMAND = 'docker compose --profile setup run --rm browser-install'

function resolveBrowsersPath(env = process.env) {
    const configured = typeof env.PLAYWRIGHT_BROWSERS_PATH === 'string' ? env.PLAYWRIGHT_BROWSERS_PATH.trim() : ''
    return configured || DEFAULT_BROWSERS_PATH
}

function expectedHeadlessShellPath() {
    process.env.PLAYWRIGHT_BROWSERS_PATH = resolveBrowsersPath()
    const { registry: registryExports } = require('patchright-core/lib/coreBundle')
    const executable = registryExports.registry.findExecutable('chromium-headless-shell')

    if (!executable) throw new Error('Patchright registry does not define chromium-headless-shell')
    return executable.executablePath()
}

function verifyBrowserExecutable(executablePath, access = fs.accessSync) {
    try {
        access(executablePath, fs.constants.X_OK)
        return { ok: true }
    } catch {
        return { ok: false, reason: 'missing-or-incompatible-browser' }
    }
}

function missingBrowserMessage() {
    return [
        '[browser-check] Chromium Headless Shell is missing or incompatible with the installed Patchright version.',
        `[browser-check] Run once before starting Rewards tasks: ${INSTALL_COMMAND}`
    ].join('\n')
}

function run(argv = process.argv.slice(2)) {
    const warnOnly = argv.includes('--warn-only')

    try {
        const result = verifyBrowserExecutable(expectedHeadlessShellPath())
        if (result.ok) return 0
    } catch {
        // Registry failures use the same safe remediation without exposing paths.
    }

    console.error(missingBrowserMessage())
    return warnOnly ? 0 : 1
}

if (require.main === module) process.exitCode = run()

module.exports = {
    DEFAULT_BROWSERS_PATH,
    INSTALL_COMMAND,
    resolveBrowsersPath,
    expectedHeadlessShellPath,
    verifyBrowserExecutable,
    missingBrowserMessage,
    run
}
