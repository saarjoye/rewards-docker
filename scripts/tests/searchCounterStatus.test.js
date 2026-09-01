const assert = require('node:assert/strict')
const { calculateMissingSearchPoints } = require('../../dist/util/SearchCounter')

function mobileStatus(counters) {
    return calculateMissingSearchPoints(counters, true)
}

const missing = mobileStatus({ pcSearch: [] })
assert.equal(missing.mobileStatus, 'missing-counter')
assert.equal(missing.mobileDetected, false)
assert.equal(missing.mobilePoints, 0)

const empty = mobileStatus({ mobileSearch: [], pcSearch: [] })
assert.equal(empty.mobileStatus, 'empty-counter')
assert.equal(empty.mobileDetected, false)
assert.equal(empty.mobilePoints, 0)

const active = mobileStatus({
    mobileSearch: [{ pointProgress: 0, pointProgressMax: 30 }],
    pcSearch: []
})
assert.equal(active.mobileStatus, 'ok')
assert.equal(active.mobileDetected, true)
assert.equal(active.mobilePoints, 30)
assert.equal(active.mobileCounter.completed, 0)
assert.equal(active.mobileCounter.total, 30)

const completed = mobileStatus({
    mobileSearch: [{ pointProgress: 30, pointProgressMax: 30 }],
    pcSearch: []
})
assert.equal(completed.mobileStatus, 'completed')
assert.equal(completed.mobileDetected, true)
assert.equal(completed.mobilePoints, 0)

const invalid = mobileStatus({
    mobileSearch: [{ pointProgress: 'bad', pointProgressMax: 30 }],
    pcSearch: []
})
assert.equal(invalid.mobileStatus, 'invalid-counter')
assert.equal(invalid.mobileDetected, false)
assert.equal(invalid.mobilePoints, 0)

const desktop = calculateMissingSearchPoints(
    {
        mobileSearch: [],
        pcSearch: [
            { pointProgress: 0, pointProgressMax: 60 },
            { pointProgress: 10, pointProgressMax: 20 }
        ]
    },
    false
)
assert.equal(desktop.desktopCounter.status, 'ok')
assert.equal(desktop.desktopCounter.completed, 0)
assert.equal(desktop.desktopCounter.total, 60)
assert.equal(desktop.desktopPoints, 60)
assert.equal(desktop.edgePoints, 10)
assert.equal(desktop.totalPoints, 70)

console.log('searchCounterStatus.test.js passed')
