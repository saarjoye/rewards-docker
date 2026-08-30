const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
    DEFAULT_BROWSERS_PATH,
    INSTALL_COMMAND,
    resolveBrowsersPath,
    expectedHeadlessShellPath,
    verifyBrowserExecutable,
    missingBrowserMessage,
    run
} = require('../docker/check-browser')

assert.equal(resolveBrowsersPath({}), DEFAULT_BROWSERS_PATH)
assert.equal(resolveBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '  /external/browsers  ' }), '/external/browsers')
assert.equal(resolveBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '   ' }), DEFAULT_BROWSERS_PATH)

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-browser-check-'))
const originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = fixtureRoot
    const expectedExecutable = expectedHeadlessShellPath()
    const oldExecutable = path.join(fixtureRoot, 'chromium_headless_shell-old', 'headless-shell')

    assert.equal(path.resolve(expectedExecutable).startsWith(path.resolve(fixtureRoot)), true)
    fs.mkdirSync(path.dirname(expectedExecutable), { recursive: true })
    fs.writeFileSync(expectedExecutable, '')
    fs.chmodSync(expectedExecutable, 0o755)
    assert.deepEqual(verifyBrowserExecutable(expectedExecutable), { ok: true })
    assert.equal(run(), 0)

    fs.rmSync(expectedExecutable)
    fs.mkdirSync(path.dirname(oldExecutable), { recursive: true })
    fs.writeFileSync(oldExecutable, '')
    assert.deepEqual(verifyBrowserExecutable(expectedExecutable), {
        ok: false,
        reason: 'missing-or-incompatible-browser'
    })

    const emptyVolumeExecutable = path.join(fixtureRoot, 'empty', 'headless-shell')
    assert.deepEqual(verifyBrowserExecutable(emptyVolumeExecutable), {
        ok: false,
        reason: 'missing-or-incompatible-browser'
    })
} finally {
    if (originalBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
}

const message = missingBrowserMessage()
assert.match(message, /missing or incompatible/)
assert.match(message, new RegExp(INSTALL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
assert.equal(message.includes('node_modules/patchright-core/.local-browsers'), false)

console.log('dockerBrowserCheck.test.js passed')
