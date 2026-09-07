const TIMEZONE = 'Asia/Shanghai'

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

export function localDateInTimeZone(value, timeZone = TIMEZONE) {
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
    return points === null || !observedAt ? null : { points, source, observedAt }
}

function pendingSummary(tasks) {
    const pending = (tasks ?? []).filter(task =>
        ['pending', 'submitted', 'verifying'].includes(task?.status) || task?.verification === 'pending'
    )
    if (!pending.length) return { count: 0, points: 0 }
    const expected = pending.map(task => finiteNumber(task?.expectedPoints))
    return {
        count: pending.length,
        points: expected.every(value => value !== null) ? expected.reduce((total, value) => total + value, 0) : null
    }
}

function explicitEvents(events) {
    return (events ?? []).filter(event => {
        const points = finiteNumber(event?.points)
        return points !== null && points >= 0 && event?.source !== 'account-balance'
    })
}

function accountRunResult(row, nextRows, date, events, tasks) {
    const initial = observed(row.initialPoints, 'initial', row.startedAt)
    const ownFinal = observed(row.finalPoints, row.finalSource || 'final', row.endedAt)
    const nextInitialRow = nextRows.find(next => {
        const nextDate = localDateInTimeZone(next.startedAt)
        return nextDate === date && finiteNumber(next.initialPoints) !== null
    })
    const nextInitial = nextInitialRow ? observed(nextInitialRow.initialPoints, 'next-initial', nextInitialRow.startedAt) : null
    const last = ownFinal ?? nextInitial
    const balanceDelta = initial && last ? Math.max(0, last.points - initial.points) : null
    const runEvents = explicitEvents(events).filter(event => event.runKey === row.runKey)
    const confirmedPoints = runEvents.length ? runEvents.reduce((total, event) => total + event.points, 0) : 0
    const pending = pendingSummary(tasks)
    return {
        runGained: balanceDelta ?? (runEvents.length ? confirmedPoints : null),
        confirmedPoints,
        unattributedPoints: balanceDelta === null ? null : Math.max(0, balanceDelta - confirmedPoints),
        pendingPoints: pending.points,
        pendingTaskCount: pending.count,
        balanceDelta,
        balanceReconciliation: {
            firstBalance: initial?.points ?? null,
            lastBalance: last?.points ?? null,
            firstObservedAt: initial?.observedAt ?? null,
            lastObservedAt: last?.observedAt ?? null,
            firstSource: initial?.source ?? null,
            lastSource: last?.source ?? null,
            provisional: Boolean(last && last.source !== 'final'),
            status: balanceDelta !== null ? 'confirmed' : initial ? 'pending' : 'unavailable'
        }
    }
}

export function reconcileAccountDay({ date, accountKey, runs = [], pointEvents = [], tasks = [] } = {}) {
    const rows = runs
        .filter(row => !accountKey || row.accountKey === accountKey)
        .toSorted((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    const runResults = rows.map((row, index) =>
        accountRunResult(row, rows.slice(index + 1), date, pointEvents, tasks.filter(task => task.runKey === row.runKey))
    )
    const events = explicitEvents(pointEvents).filter(event => localDateInTimeZone(event.confirmedAt) === date)
    const confirmedPoints = events.reduce((total, event) => total + event.points, 0)
    const first = rows
        .map(row => observed(row.initialPoints, 'initial', row.startedAt))
        .filter(item => item && localDateInTimeZone(item.observedAt) === date)
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))[0] ?? null
    const last = runResults
        .map(result =>
            result.balanceReconciliation.lastBalance === null
                ? null
                : {
                      points: result.balanceReconciliation.lastBalance,
                      source: result.balanceReconciliation.lastSource,
                      observedAt: result.balanceReconciliation.lastObservedAt
                  }
        )
        .filter(item => item && localDateInTimeZone(item.observedAt) === date)
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .at(-1) ?? null
    const balanceDelta = first && last ? Math.max(0, last.points - first.points) : null
    const dayRunKeys = new Set(
        rows
            .filter(row => localDateInTimeZone(row.startedAt) === date || localDateInTimeZone(row.endedAt) === date)
            .map(row => row.runKey)
    )
    const pending = pendingSummary(tasks.filter(task => dayRunKeys.has(task.runKey)))
    const todayGained = balanceDelta ?? (events.length ? confirmedPoints : null)
    const runGains = runResults.map(result => result.runGained).filter(value => value !== null)
    return {
        date,
        accountKey: accountKey ?? null,
        runGained: runGains.length ? runGains.reduce((total, value) => total + value, 0) : null,
        todayGained,
        confirmedPoints,
        unattributedPoints: balanceDelta === null ? null : Math.max(0, balanceDelta - confirmedPoints),
        pendingPoints: pending.points,
        pendingTaskCount: pending.count,
        balanceDelta,
        balanceReconciliation: {
            firstBalance: first?.points ?? null,
            lastBalance: last?.points ?? null,
            firstObservedAt: first?.observedAt ?? null,
            lastObservedAt: last?.observedAt ?? null,
            firstSource: first?.source ?? null,
            lastSource: last?.source ?? null,
            provisional: Boolean(last && last.source !== 'final'),
            status: balanceDelta !== null ? 'confirmed' : first || pending.count ? 'pending' : 'unavailable'
        },
        runs: rows.map((row, index) => ({ runKey: row.runKey, ...runResults[index] }))
    }
}

export function reconcileDailyPoints({ date, runs = [], pointEvents = [], tasks = [] } = {}) {
    const accountKeys = [...new Set(runs.map(row => row.accountKey).filter(Boolean))]
    const accounts = accountKeys.map(accountKey =>
        reconcileAccountDay({ date, accountKey, runs, pointEvents, tasks })
    )
    const known = values => values.filter(value => value !== null)
    const total = values => {
        if (!values.length || values.some(value => value === null)) return null
        return known(values).reduce((sum, value) => sum + value, 0)
    }
    return {
        date,
        todayGained: total(accounts.map(account => account.todayGained)),
        confirmedPoints: total(accounts.map(account => account.confirmedPoints)),
        unattributedPoints: total(accounts.map(account => account.unattributedPoints)),
        pendingPoints: total(accounts.map(account => account.pendingPoints)),
        pendingTaskCount: accounts.reduce((sum, account) => sum + account.pendingTaskCount, 0),
        accounts
    }
}
