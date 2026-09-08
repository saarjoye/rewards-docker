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

test('calendar cells list individual reconciled accounts without residual prose or summing runs', () => {
    const html = calendarMarkup({
        range: { start: '2026-09-08', end: '2026-09-08' },
        accounts: [{ id: 'b' }, { id: 'a' }],
        days: [{ date: '2026-09-08', totalGained: 205, records: 3, status: 'running', balanceReconciliation: [
            { accountKey: 'a', dailyBalanceDelta: 0 },
            { accountKey: 'b', dailyBalanceDelta: 205, balanceVerification: 'provisional' }
        ] }], records: []
    }, [{ id: 'b', index: 2 }, { id: 'a', index: 1 }])
    assert.match(html, /账号1：.*?0 分/s)
    assert.match(html, /账号2：.*?205 分/s)
    assert.match(html, /暂时/)
    assert.doesNotMatch(html, /未归属|余额增加但|NaN|undefined/)
})

test('calendar distinguishes empty days from legacy evidence and keeps account number after filtering', () => {
    const html = calendarMarkup({
        range: { start: '2026-09-01', end: '2026-09-02' }, days: [],
        records: [{ date: '2026-09-02', accountId: 'b', runId: 'legacy', legacyCollected: 111, runGained: 999, status: 'interrupted' }]
    }, [{ id: 'a', index: 1 }, { id: 'b', index: 2 }])
    const cells = html.split('</article>')
    assert.match(cells[0], /无记录/)
    assert.doesNotMatch(cells[0], /待确认/)
    assert.match(cells[1], /账号2：.*?待确认/s)
    assert.match(cells[1], /1 条记录.*余额证据不足/s)
    assert.doesNotMatch(cells[1], /无记录|111|999/)
})
