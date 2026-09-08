import crypto from 'node:crypto'

export const TASK_STATUSES = [
    'pending',
    'eligible',
    'submitted',
    'unsupported',
    'unavailable',
    'running',
    'verifying',
    'completed',
    'partial',
    'stopped',
    'failed',
    'skipped',
    'locked',
    'interrupted'
]
const terminal = new Set([
    'completed',
    'partial',
    'stopped',
    'failed',
    'skipped',
    'locked',
    'interrupted',
    'submitted',
    'unsupported',
    'unavailable'
])
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const businessDate = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : null
const text = (value, max = 180) =>
    [...String(value ?? '')]
        .map(c => (c.charCodeAt(0) < 32 ? ' ' : c))
        .join('')
        .slice(0, max)
export function accountRef(email) {
    return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

export function applyTaskEvent(state, entry) {
    if (entry.title !== 'TASK-EVENT') return false
    let event
    try {
        event = JSON.parse(entry.message)
    } catch {
        return false
    }
    if (
        event?.version !== 2 ||
        !Number.isSafeInteger(event.sequence) ||
        event.sequence < 1 ||
        !/^[\w-]+:\d+$/.test(event.eventId ?? '') ||
        !Number.isFinite(Date.parse(event.at))
    )
        return false
    const account = Object.values(state.accounts).find(item => accountRef(item.email) === event.accountRef)
    if (!account || !['task', 'balance'].includes(event.kind)) return false
    if (event.kind === 'task' && (!TASK_STATUSES.includes(event.status) || !event.id || !event.invocationId))
        return false
    account.telemetryVersion = 2
    account.eventSequences ??= {}
    account.pointRecords ??= []
    const scope = `inv:${event.invocationId || event.eventId.split(':')[0] + ':' + event.kind}`
    if (event.sequence <= (account.eventSequences[scope] ?? 0)) return false
    account.eventSequences[scope] = event.sequence
    if (event.kind === 'balance') {
        const balance = number(event.balance)
        const observedBalance = balance !== null && balance >= 0 ? balance : null
        if (observedBalance !== null && event.phase === 'start' && !account.initialObservedAt) {
            account.initialPoints = observedBalance
            account.initialObservedAt = event.at
        }
        if (observedBalance !== null && (!account.balanceObservedAt || Date.parse(event.at) >= Date.parse(account.balanceObservedAt))) {
            account.live.balance = observedBalance
            account.balanceObservedAt = event.at
        }
        if (observedBalance !== null && event.phase === 'end' && (!account.finalObservedAt || Date.parse(event.at) >= Date.parse(account.finalObservedAt))) {
            account.finalPoints = observedBalance
            account.finalObservedAt = event.at
        }
    } else {
        const id = text(event.id)
        const previous = account.tasks[id]
        if (previous?.invocationId === event.invocationId && previous.terminal && !event.terminal) return false
        if (previous?.invocationId !== event.invocationId && Date.parse(previous?.updatedAt) > Date.parse(event.at))
            return false
        const progress = event.progress
        const gained = number(event.reportedPoints ?? event.earnedPoints)
        const reported =
            (Object.hasOwn(event, 'reportedPoints') || ['confirmed', 'confirmed-zero'].includes(event.verification)) &&
            gained !== null &&
            gained >= 0 &&
            Number.isFinite(Date.parse(event.confirmedAt ?? event.at))
        const officialCredit = reported && event.evidenceSource === 'official-credit' && /^[a-f0-9]{64}$/.test(event.officialCreditKey ?? '')
        const confirmed = officialCredit || (reported && event.evidenceSource === 'official-progress' &&
            Number.isSafeInteger(event.progressBefore) && Number.isSafeInteger(event.progressAfter) &&
            event.progressBefore >= 0 && event.progressAfter - event.progressBefore === gained &&
            businessDate(event.startedAt) !== null && businessDate(event.startedAt) === businessDate(event.confirmedAt))
        account.tasks[id] = {
            id,
            title: text(event.title),
            source: text(event.source, 30),
            platform: text(event.platform, 20),
            taskType: text(event.taskType, 60) || previous?.taskType || null,
            capability: text(event.capability, 30) || previous?.capability || null,
            adapter: text(event.adapter, 80) || previous?.adapter || null,
            eligibility: text(event.eligibility, 40) || previous?.eligibility || null,
            eligibilityReason: text(event.eligibilityReason, 240) || previous?.eligibilityReason || null,
            planned: Object.hasOwn(event, 'planned') ? Boolean(event.planned) : Boolean(previous?.planned),
            executionOrder: Number.isInteger(event.executionOrder) ? event.executionOrder : previous?.executionOrder ?? null,
            invocationId: text(event.invocationId, 100),
            parentId: event.parentId ? text(event.parentId) : null,
            group: Boolean(event.group),
            status: event.status,
            action: text(event.action, 500),
            verification: confirmed
                ? gained === 0
                    ? 'confirmed-zero'
                    : 'confirmed'
                : event.verification === 'not-applicable'
                  ? 'not-applicable'
                  : 'pending',
            earnedPoints: confirmed ? gained : null,
            balance: number(event.balance),
            balanceChange: number(event.balanceChange),
            previouslyCompleted: Boolean(event.previouslyCompleted),
            submitted: Boolean(event.submitted),
            dataStatus: text(event.dataStatus, 30),
            evidenceSource: text(event.evidenceSource, 80) || previous?.evidenceSource || null,
            expectedPoints: number(event.expectedPoints),
            remainingPoints: number(event.remainingPoints),
            progress:
                number(progress?.current) !== null && number(progress?.total) !== null
                    ? {
                          current: progress.current,
                          total: progress.total,
                          unit: progress.unit === 'items' ? 'items' : 'points'
                      }
                    : null,
            attemptProgress: event.attemptProgress ?? previous?.attemptProgress ?? null,
            startedAt: Number.isFinite(Date.parse(event.startedAt)) ? event.startedAt : event.at,
            updatedAt: event.at,
            lastProgressAt:
                event.action !== previous?.action ||
                JSON.stringify(event.progress) !== JSON.stringify(previous?.progress)
                    ? event.at
                    : (previous?.lastProgressAt ?? event.at),
            waitUntil: Number.isFinite(Date.parse(event.waitUntil)) ? event.waitUntil : null,
            confirmedAt: confirmed ? event.confirmedAt : null,
            errorCategory: text(event.errorCategory, 40) || null,
            terminal: Boolean(event.terminal),
            telemetryVersion: 2
        }
        const task = account.tasks[id]
        if (
            event.terminal &&
            reported &&
            !task.group &&
            !account.pointRecords.some(item => item.id === event.invocationId)
        ) {
            const baseRecord = {
                id: event.invocationId,
                taskId: id,
                source: task.source,
                points: gained,
                confirmedAt: event.confirmedAt ?? event.at,
                verificationStatus: 'unverified',
                identityStable: false,
                evidenceSource: null
            }
            const start = number(event.progressBefore), end = number(event.progressAfter)
            const date = businessDate(event.confirmedAt ?? event.at)
            const startDate = businessDate(event.startedAt)
            if (officialCredit) {
                if (!account.pointRecords.some(record => record.creditKey === event.officialCreditKey))
                    account.pointRecords.push({ ...baseRecord, id: event.officialCreditKey, creditKey: event.officialCreditKey, identityStable: true, verificationStatus: gained === 0 ? 'confirmed-zero' : 'confirmed', evidenceSource: 'official-credit' })
            } else if (event.evidenceSource === 'official-progress' && startDate === date && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end - start === gained && gained <= 10000) {
                for (let position = start + 1; position <= end; position++) {
                    const creditKey = crypto.createHash('sha256').update(`${event.accountRef}|${date}|${id}|official-progress|${position}`).digest('hex')
                    if (!account.pointRecords.some(record => record.creditKey === creditKey))
                        account.pointRecords.push({ ...baseRecord, id: creditKey, creditKey, points: 1, identityStable: true, verificationStatus: 'confirmed', evidenceSource: 'official-progress' })
                }
                if (gained === 0) {
                    const creditKey = crypto.createHash('sha256').update(`${event.accountRef}|${date}|${id}|official-progress-zero|${start}`).digest('hex')
                    if (!account.pointRecords.some(record => record.creditKey === creditKey))
                        account.pointRecords.push({ ...baseRecord, id: creditKey, creditKey, identityStable: true, verificationStatus: 'confirmed-zero', evidenceSource: 'official-progress' })
                }
            } else account.pointRecords.push(baseRecord)
        }
        if (
            Object.hasOwn(event, 'balance') &&
            number(event.balance) !== null && number(event.balance) >= 0 &&
            (!account.balanceObservedAt || Date.parse(event.balanceObservedAt ?? event.at) >= Date.parse(account.balanceObservedAt))
        ) {
            account.live.balance = number(event.balance)
            account.balanceObservedAt = event.balanceObservedAt ?? event.at
        }
        if (event.dataStatus) {
            account.taskSources ??= {}
            account.taskSources[`${event.source}:${event.platform}`] = event.dataStatus
            const statuses = Object.values(account.taskSources)
            account.taskDataStatus = statuses.every(status => status === 'available')
                ? 'available'
                : statuses.includes('available')
                  ? 'partial'
                  : 'unavailable'
        }
    }
    account.balanceChange =
        number(account.initialPoints) !== null && number(account.live.balance) !== null
            ? account.live.balance - account.initialPoints
            : null
    const confirmedTaskPoints = account.pointRecords.filter(item => item.identityStable && item.verificationStatus === 'confirmed').reduce((sum, item) => sum + item.points, 0)
    account.live.gained = confirmedTaskPoints
    account.collectedPoints = account.live.gained
    account.live.bySource = {}
    for (const record of account.pointRecords.filter(item => item.identityStable && item.verificationStatus === 'confirmed'))
        account.live.bySource[record.source] = (account.live.bySource[record.source] ?? 0) + record.points
    account.pendingVerification = Object.values(account.tasks).filter(
        task => task.telemetryVersion === 2 && !task.group && task.verification === 'pending'
    ).length
    account.unattributedBalanceChange =
        null
    account.live.lastUpdateTs = event.at
    state.lastPointUpdateAt = event.at
    return true
}

export function structuredAccountStatus(account, finished = false) {
    const tasks = Object.values(account.tasks ?? {}).filter(
        task =>
            task.telemetryVersion === 2 &&
            !task.group &&
            (task.invocationId || (task.planned && task.eligibility !== 'excluded'))
    )
    if (!tasks.length) return account.error ? 'failed' : finished ? 'unknown' : 'running'
    if (account.error || tasks.some(task => task.status === 'failed'))
        return tasks.some(task => task.status === 'completed') || account.collectedPoints > 0 ? 'partial' : 'failed'
    if (tasks.some(task => task.status === 'interrupted')) return 'interrupted'
    if (tasks.some(task => !terminal.has(task.status))) return finished ? 'partial' : 'running'
    if (tasks.some(task => ['partial', 'stopped', 'submitted', 'unavailable'].includes(task.status))) return 'partial'
    return 'completed'
}

export function interruptTasks(run) {
    const accounts = run?.run?.accounts ?? run?.accounts ?? []
    for (const account of accounts) {
        for (const task of Object.values(account.tasks ?? {})) {
            if (
                task.telemetryVersion === 2 &&
                !task.terminal &&
                ['pending', 'eligible', 'running', 'submitted', 'verifying'].includes(task.status)
            ) {
                task.status = 'interrupted'
                task.action = '运行中断，未继续执行或重新领取'
                task.terminal = true
            }
        }
        if (account.telemetryVersion === 2) account.status = structuredAccountStatus(account, true)
    }
    return run
}

export function historyRecord(entry) {
    return {
        id: entry.id ?? null,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        exit: entry.exit,
        version: entry.run?.version ?? null,
        telemetryVersion: entry.run?.telemetryVersion ?? null,
        collected: entry.run?.collected ?? null,
        accounts: (entry.run?.accounts ?? []).map(a => ({
            email: a.email,
            initialPoints: a.initialPoints ?? null,
            initialObservedAt: a.initialObservedAt ?? null,
            finalObservedAt: a.finalObservedAt ?? null,
            finalPoints:
                a.telemetryVersion === 2 ? (a.finalPoints ?? null) : (a.finalPoints ?? a.live?.balance ?? null),
            collected: a.collectedPoints ?? a.live?.gained ?? null,
            collectedPoints: a.collectedPoints ?? a.live?.gained ?? null,
            bySource: a.live?.bySource ?? {},
            success: a.success,
            error: a.error,
            streakProtection: a.streakProtection ?? null,
            edgeBrowsing: a.edgeBrowsing ?? null,
            tasks: a.tasks ?? [],
            telemetryVersion: a.telemetryVersion ?? null,
            status: a.status ?? null,
            pointRecords: a.pointRecords ?? [],
            pendingVerification: a.pendingVerification ?? null,
            balanceChange: a.balanceChange ?? null,
            unattributedBalanceChange: a.unattributedBalanceChange ?? null,
            taskDataStatus: a.taskDataStatus ?? 'not-read',
            taskSources: a.taskSources ?? {}
        }))
    }
}
