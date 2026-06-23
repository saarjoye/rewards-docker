const assert = require('node:assert/strict')
const {
    extractDeploymentIdFromHtml,
    extractScriptUrls,
    extractServerActionHashResultFromSources
} = require('../../dist/util/ServerActions')

const streakHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const bonusHash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const html = `
  <html>
    <head>
      <script src="/_next/static/chunks/app/dashboard/page.js?dpl=20260616-3"></script>
      <script src="https://rewards.bing.com/_next/static/chunks/app/dashboard/actions.js"></script>
    </head>
  </html>
`

assert.equal(extractDeploymentIdFromHtml(html), '20260616-3')
assert.deepEqual(extractScriptUrls(html), [
    'https://rewards.bing.com/_next/static/chunks/app/dashboard/page.js?dpl=20260616-3',
    'https://rewards.bing.com/_next/static/chunks/app/dashboard/actions.js'
])

const uniqueResult = extractServerActionHashResultFromSources([
    {
        name: 'dashboard-html',
        content: html
    },
    {
        name: 'chunk.js',
        content: `
            var toggleStreakProtection=createServerReference("${streakHash}", null, null);
            var claimBonusPoints=createServerReference("${bonusHash}", null, null);
        `
    }
])

assert.equal(uniqueResult.hashes.toggleStreakProtection, streakHash)
assert.equal(uniqueResult.hashes.claimBonusPoints, bonusHash)
assert.equal(uniqueResult.diagnostics.toggleStreakProtection.reason, 'unique')
assert.equal(uniqueResult.diagnostics.claimBonusPoints.reason, 'unique')

const ambiguousResult = extractServerActionHashResultFromSources([
    {
        name: 'chunk.js',
        content: `
            var claimBonusPoints=createServerReference("${bonusHash}", null, null);
            var claimBonusPoints2=createServerReference("cccccccccccccccccccccccccccccccccccccccc", null, null);
        `
    }
])

assert.equal(ambiguousResult.hashes.claimBonusPoints, undefined)
assert.equal(ambiguousResult.diagnostics.claimBonusPoints.reason, 'ambiguous')
assert.equal(ambiguousResult.diagnostics.claimBonusPoints.candidateCount, 2)

console.log('serverActionParser.test.js passed')
