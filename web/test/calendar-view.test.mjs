import assert from 'node:assert/strict'
import test from 'node:test'
import { calendarRange, calendarDays, calendarMarkup } from '../public/calendar-view.js'

test('calendar ranges support the original presets and validate custom input', () => {
    assert.deepEqual(calendarRange('week', '2026-09-06'), { start: '2026-08-31', end: '2026-09-06' })
    assert.equal(calendarRange('month', '2026-09-05').start, '2026-09-01')
    assert.equal(calendarRange('quarter', '2026-09-05').start, '2026-07-01')
    assert.equal(calendarRange('year', '2026-09-05').start, '2026-01-01')
    assert.throws(() => calendarRange('custom', '2026-09-05', { start: '2026-02-30', end: '2026-09-05' }), /日期/)
    assert.throws(() => calendarRange('custom', '2026-09-05', { start: '2026-09-06', end: '2026-09-05' }), /不能晚于/)
})

test('calendar fills missing dates without inventing zero gains', () => {
    const range = { start: '2024-02-28', end: '2024-03-01' }
    const days = calendarDays(range, [{ date: '2024-02-29', totalGained: 0, status: 'stopped', records: 1 }])
    assert.equal(days.length, 3)
    assert.equal(days[0].totalGained, null)
    assert.equal(days[1].totalGained, 0)
    const html = calendarMarkup({ range, days, records: [] })
    assert.match(html, /无记录/)
    assert.match(html, /未得分停止/)
    assert.doesNotMatch(html, /undefined|NaN/)
})

test('calendar groups daily account runs, preserves legacy amounts and escapes labels', () => {
    const record = {
        date: '2026-09-05',
        accountId: 'synthetic',
        accountLabel: '<script>test</script>',
        beforePoints: null,
        afterPoints: 103,
        startedAt: '2026-09-05T00:00:00Z',
        endedAt: '2026-09-05T00:05:00Z',
        status: 'partial',
        sources: { app: 3 }
    }
    const html = calendarMarkup({
        range: { start: '2026-09-05', end: '2026-09-05' },
        days: [{ date: '2026-09-05', totalGained: 3, status: 'partial', records: 2 }],
        records: [
            { ...record, runId: 'run-one', runGained: 3, verification: 'tracked' },
            { ...record, runId: 'run-two', runGained: 40, verification: 'legacy' }
        ]
    })
    assert.match(html, /查看 2 次执行记录/)
    assert.match(html, /旧记录未核验/)
    assert.match(html, /App 活动/)
    assert.match(html, /heat-4/)
    assert.doesNotMatch(html, /<script>|\+43/)
})
