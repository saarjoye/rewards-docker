const TIMEZONE = 'Asia/Shanghai'

function finiteNumber(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

export function localDateInTimeZone(value, timeZone = TIMEZONE) {
    if (!value) return null
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return null
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date)
    const get = type => parts.find(part => part.type === type)?.value
    return `${get('year')}-${get('month')}-${get('day')}`
}

function observed(value, source, at) {
    const points = finiteNumber(value)
    const observedAt = typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null
    return points === null || points < 0 || !observedAt ? null : { points, source, observedAt }
}

function pendingSummary(tasks) {
    const pending = (tasks ?? []).filter(task =>
        !task.group && (['submitted', 'verifying'].includes(task?.status) || task?.verification === 'pending')
    )
    if (!pending.length) return { count: 0, points: 0 }
    const expected = pending.map(task => finiteNumber(task?.expectedPoints))
    return {
        count: pending.length,
        points: expected.every(value => value !== null) ? expected.reduce((total, value) => total + value, 0) : null
    }
}

function explicitEvents(events) {
    const seen = new Set()
    return (events ?? []).filter(event => {
        const points = finiteNumber(event?.points)
        const key = event.creditKey && `${event.accountKey}:${event.creditKey}`
        if (!key || seen.has(key)) return false
        const valid = points !== null && points >= 0 && event?.source !== 'account-balance' &&
            event.identityStable === true && !event.legacyUnverified &&
            ['confirmed', 'confirmed-zero'].includes(event.verificationStatus) &&
            ['official-credit', 'official-progress', 'isolated-balance'].includes(event.evidenceSource)
        if (valid) seen.add(key)
        return valid
    })
}

function creditSummary(events, delta, first, last) {
    const unique = new Map()
    for (const event of events) {
        if (event.source === 'account-balance' || finiteNumber(event.points) === null || finiteNumber(event.points) < 0) continue
        const key = event.creditKey || event.eventKey || event
        if (!unique.has(key)) unique.set(key, event)
    }
    const reports = [...unique.values()]
    const verified = explicitEvents(reports)
    const reported = reports.length ? reports.reduce((sum, event) => sum + finiteNumber(event.points), 0) : null
    const rawConfirmed = verified.reduce((sum, event) => sum + finiteNumber(event.points), 0)
    const conflict = delta !== null && rawConfirmed > Math.max(0, delta)
    const confirmed = conflict ? 0 : rawConfirmed
    const uncertain = reports.length !== verified.length
    const over = delta === null || reported === null ? null : Math.max(0, reported - Math.max(0, delta))
    const outside = reports.some(event => !first || !last || Date.parse(event.confirmedAt) < Date.parse(first.observedAt) || Date.parse(event.confirmedAt) > Date.parse(last.observedAt))
    const unattributed = delta === null || delta < 0 || uncertain || conflict || outside || over > 0 || events.some(event => event.source === 'account-balance')
        ? null : Math.max(0, delta - confirmed)
    return { reportedTaskPoints: reported, confirmedPoints: (uncertain || conflict) && !confirmed ? null : confirmed,
        pendingPoints: reported === null ? null : reported - confirmed, overreportedPoints: over,
        unattributedBalanceDelta: unattributed, unattributedPoints: unattributed,
        legacyUnverified: reports.some(event => event.legacyUnverified !== false), timeZone: TIMEZONE }
}

function accountRunResult(row, date, events, tasks) {
    const initial = observed(row.initialPoints, 'initial', row.initialObservedAt)
    const final = observed(row.finalPoints, 'final', row.finalObservedAt)
    const live = observed(row.liveBalance, 'live', row.liveObservedAt)
    const last = final ?? live
    const active = ['starting', 'running', 'stopping'].includes(row.status)
    const balanceDelta = (final || active) && initial && last && localDateInTimeZone(initial.observedAt) === date &&
        localDateInTimeZone(last.observedAt) === date && Date.parse(last.observedAt) > Date.parse(initial.observedAt)
        ? last.points - initial.points : null
    const pending = pendingSummary(tasks)
    return {
        runGained: balanceDelta,
        runBalanceDelta: balanceDelta,
        liveRunBalanceDelta: !final && active ? balanceDelta : null,
        balanceVerification: balanceDelta === null ? 'pending' : final ? 'confirmed' : 'provisional',
        persistence: row.durable ? 'durable' : 'provisional',
        status: row.status ?? (final ? 'completed-pending-persist' : 'pending'),
        observedAt: last?.observedAt ?? initial?.observedAt ?? null,
        date,
        interrupted: row.status === 'interrupted',
        pendingExpectedPoints: pending.points,
        pendingTaskCount: pending.count,
        balanceDelta,
        ...creditSummary(events.filter(event => event.runKey === row.runKey), balanceDelta, initial, last),
        legacyUnverified: row.legacyUnverified === true || events.some(event => event.runKey === row.runKey && event.legacyUnverified !== false),
        balanceReconciliation: {
            firstBalance: initial?.points ?? null,
            lastBalance: last?.points ?? null,
            firstObservedAt: initial?.observedAt ?? null,
            lastObservedAt: last?.observedAt ?? null,
            firstSource: initial?.source ?? null,
            lastSource: last?.source ?? null,
            provisional: Boolean(last && last.source !== 'final'),
            status: balanceDelta !== null ? final ? 'confirmed' : 'provisional' : initial ? 'pending' : 'unavailable'
        }
    }
}

export function reconcileAccountDay({ date, accountKey, runs = [], pointEvents = [], tasks = [], currentRunId = null } = {}) {
    pointEvents = pointEvents.filter(event => event.accountKey === accountKey && localDateInTimeZone(event.confirmedAt) === date)
    tasks = tasks.filter(task => task.accountKey === accountKey)
    const rows = runs
        .filter(row => !accountKey || row.accountKey === accountKey)
        .filter(row => [row.startedAt, row.endedAt, row.initialObservedAt, row.finalObservedAt, row.liveObservedAt].some(at => localDateInTimeZone(at) === date))
        .toSorted((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    const runResults = rows.map(row =>
        accountRunResult(row, date, pointEvents, tasks.filter(task => task.runKey === row.runKey))
    )
    const first = rows
        .map(row => observed(row.initialPoints, 'initial', row.initialObservedAt))
        .filter(item => item && localDateInTimeZone(item.observedAt) === date)
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))[0] ?? null
    const last = rows.flatMap(row => [observed(row.finalPoints, 'final', row.finalObservedAt), observed(row.liveBalance, 'live', row.liveObservedAt)])
        .filter(item => item && localDateInTimeZone(item.observedAt) === date)
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || Number(a.source === 'final') - Number(b.source === 'final'))
        .at(-1) ?? null
    const balanceDelta = first && last && Date.parse(last.observedAt) > Date.parse(first.observedAt) ? last.points - first.points : null
    const dayRunKeys = new Set(
        rows
            .filter(row => localDateInTimeZone(row.startedAt) === date || localDateInTimeZone(row.endedAt) === date)
            .map(row => row.runKey)
    )
    const pending = pendingSummary(tasks.filter(task => dayRunKeys.has(task.runKey)))
    const todayGained = balanceDelta
    const selected = rows.findIndex(row => row.runKey === currentRunId)
    return {
        date,
        accountKey: accountKey ?? null,
        interrupted: rows.some(row => row.status === 'interrupted' && localDateInTimeZone(row.startedAt) === date),
        runGained: selected < 0 ? null : runResults[selected].runGained,
        runBalanceDelta: selected < 0 ? null : runResults[selected].runGained,
        dailyBalanceDelta: balanceDelta,
        liveDailyBalanceDelta: last?.source === 'live' ? balanceDelta : null,
        liveRunBalanceDelta: selected < 0 ? null : runResults[selected].liveRunBalanceDelta,
        runBalanceVerification: selected < 0 ? 'pending' : runResults[selected].balanceVerification,
        balanceVerification: balanceDelta === null ? 'pending' : last?.source === 'final' ? 'confirmed' : 'provisional',
        businessDate: date,
        observedAt: last?.observedAt ?? first?.observedAt ?? null,
        todayGained,
        pendingExpectedPoints: pending.points,
        pendingTaskCount: pending.count,
        balanceDelta,
        ...creditSummary(pointEvents.filter(event => localDateInTimeZone(event.confirmedAt) === date), balanceDelta, first, last),
        legacyUnverified: rows.some(row => dayRunKeys.has(row.runKey) && row.legacyUnverified === true) || pointEvents.some(event => localDateInTimeZone(event.confirmedAt) === date && event.legacyUnverified !== false),
        balanceReconciliation: {
            firstBalance: first?.points ?? null,
            lastBalance: last?.points ?? null,
            firstObservedAt: first?.observedAt ?? null,
            lastObservedAt: last?.observedAt ?? null,
            firstSource: first?.source ?? null,
            lastSource: last?.source ?? null,
            provisional: Boolean(last && last.source !== 'final'),
            status: balanceDelta !== null ? last?.source === 'final' ? 'confirmed' : 'provisional' : first || pending.count ? 'pending' : 'unavailable'
        },
        runs: rows.map((row, index) => ({ runKey: row.runKey, ...runResults[index] }))
    }
}

export function reconcileDailyPoints({ date, runs = [], pointEvents = [], tasks = [], currentRunId = null } = {}) {
    const accountKeys = [...new Set([...runs.filter(row =>
        [row.startedAt, row.endedAt, row.initialObservedAt, row.finalObservedAt, row.liveObservedAt].some(at => localDateInTimeZone(at) === date)
    ), ...pointEvents.filter(event => localDateInTimeZone(event.confirmedAt) === date)].map(row => row.accountKey).filter(Boolean))]
    const accounts = accountKeys.map(accountKey =>
        reconcileAccountDay({ date, accountKey, runs, pointEvents, tasks, currentRunId })
    )
    const known = values => values.filter(value => value !== null)
    const total = values => {
        if (!values.length || values.some(value => value === null)) return null
        return known(values).reduce((sum, value) => sum + value, 0)
    }
    const participating = currentRunId ? accounts.filter(account => account.runs.some(run => run.runKey === currentRunId)) : []
    return {
        date,
        timeZone: TIMEZONE,
        businessDate: date,
        balanceVerification: accounts.some(account => account.dailyBalanceDelta === null) || !accounts.length ? 'pending' : accounts.some(account => account.balanceVerification === 'provisional') ? 'provisional' : 'confirmed',
        runBalanceVerification: !participating.length || participating.some(account => account.runBalanceVerification === 'pending') ? 'pending' : participating.some(account => account.runBalanceVerification === 'provisional') ? 'provisional' : 'confirmed',
        observedAt: accounts.map(account => account.observedAt).filter(Boolean).sort().at(-1) ?? null,
        runGained: total(participating.map(account => account.runGained)),
        runBalanceDelta: total(participating.map(account => account.runBalanceDelta)),
        dailyBalanceDelta: total(accounts.map(account => account.dailyBalanceDelta)),
        reportedTaskPoints: total(accounts.map(account => account.reportedTaskPoints)),
        overreportedPoints: total(accounts.map(account => account.overreportedPoints)),
        unattributedBalanceDelta: total(accounts.map(account => account.unattributedBalanceDelta)),
        todayGained: total(accounts.map(account => account.todayGained)),
        confirmedPoints: total(accounts.map(account => account.confirmedPoints)),
        unattributedPoints: total(accounts.map(account => account.unattributedPoints)),
        pendingPoints: total(accounts.map(account => account.pendingPoints)),
        pendingTaskCount: accounts.reduce((sum, account) => sum + account.pendingTaskCount, 0),
        accounts
    }
}
