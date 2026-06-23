const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'points-calendar-'))
process.chdir(tempDir)

const { queryPointsCalendar } = require('../../dist/util/PointsHistoryStore')

fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true })
fs.writeFileSync(
    path.join(tempDir, 'logs', 'points-history.json'),
    JSON.stringify(
        {
            version: 1,
            updatedAt: '2026-06-23T00:00:00.000Z',
            days: [
                {
                    date: '2026-06-23',
                    accountHash: 'hash-a',
                    accountLabel: 'a***@example.com',
                    beforePoints: 6054,
                    afterPoints: 6229,
                    todayGained: 175,
                    runGained: 175,
                    categories: {
                        pcSearch: 90,
                        mobileSearch: 0,
                        dailyActivity: 40,
                        appActivity: 0,
                        checkIn: 15,
                        readToEarn: 30,
                        bonus: 0,
                        streak: 0,
                        other: 0
                    },
                    status: 'completed',
                    updatedAt: '2026-06-23T01:00:00.000Z',
                    runs: [
                        {
                            id: 'run-a',
                            date: '2026-06-23',
                            accountHash: 'hash-a',
                            accountLabel: 'a***@example.com',
                            source: 'web',
                            pid: 123,
                            startedAt: '2026-06-23T00:00:00.000Z',
                            finishedAt: '2026-06-23T01:00:00.000Z',
                            beforePoints: 6054,
                            afterPoints: 6229,
                            runGained: 175,
                            todayGained: 175,
                            categories: {
                                pcSearch: 90,
                                mobileSearch: 0,
                                dailyActivity: 40,
                                appActivity: 0,
                                checkIn: 15,
                                readToEarn: 30,
                                bonus: 0,
                                streak: 0,
                                other: 0
                            },
                            status: 'completed',
                            taskSummary: []
                        }
                    ]
                }
            ]
        },
        null,
        2
    )
)

const accounts = [
    { id: 'hash-a', accountHash: 'hash-a', label: 'account-a' },
    { id: 'hash-b', accountHash: 'hash-b', label: 'account-b' }
]
const now = new Date('2026-06-23T08:00:00+08:00')

const month = queryPointsCalendar(accounts, { range: 'month', now })
assert.equal(month.range.end, '2026-06-23')
assert.equal(month.days.at(-1).date, '2026-06-23')
assert.equal(month.records.length, 1)
assert.equal(month.records[0].accountId, 'hash-a')
assert.equal(month.records[0].todayGained, 175)

const invalid = queryPointsCalendar(accounts, { account: 'missing-account', range: 'month', now })
assert.equal(invalid.accounts.length, 0)
assert.equal(invalid.records.length, 0)
assert.ok(invalid.days.every(day => day.records === 0))

const accountB = queryPointsCalendar(accounts, { account: 'hash-b', range: 'month', now })
assert.equal(accountB.accounts.length, 1)
assert.equal(accountB.records.length, 0)
assert.ok(accountB.days.every(day => day.records === 1))

console.log('pointsCalendarQuery.test.js passed')
