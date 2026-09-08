const EVENTS = new Set(['TASK-EVENT', 'TASK-SNAPSHOT', 'GET-CURRENT-POINTS', 'POINTS', 'ACCOUNT-START', 'ACCOUNT-END', 'RUN-START', 'RUN-END'])
export const isProgressEvent = title => EVENTS.has(title)

export function createRefreshScheduler({ refresh, publish, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null, poll = null, running = null, queued = false, stopped = false, active = false
    const closing = new Set()
    const retries = new Set()
    function schedule(delay = 300) {
        if (stopped) return
        if (running) { queued = true; return }
        if (timer !== null && delay !== 0) return
        if (timer !== null) clearTimer(timer)
        timer = setTimer(() => { timer = null; void execute() }, delay)
        timer?.unref?.()
    }
    async function execute() {
        if (stopped) return
        if (running) { queued = true; return running }
        running = Promise.resolve().then(refresh).then(result => {
            publish(result)
            const status = result?.status
            const nextActive = ['starting', 'running', 'stopping'].includes(status?.state)
            if (active && status?.state === 'idle') finish(status.runId)
            if (status) active = nextActive
        }).finally(() => {
            running = null
            if (poll !== null) clearTimer(poll)
            if (!stopped) {
                poll = setTimer(() => { poll = null; schedule(0) }, active ? 3000 : 10000)
                poll?.unref?.()
                if (queued) { queued = false; schedule(0) }
            }
        })
        return running
    }
    function finish(key) {
        schedule(0)
        if (closing.has(key)) return
        closing.add(key)
        for (const delay of [2000, 10000]) {
            const retry = setTimer(() => { retries.delete(retry); schedule(0) }, delay)
            retries.add(retry)
            retry?.unref?.()
        }
    }
    return { schedule, finish, execute, stop() {
        stopped = true
        for (const handle of [timer, poll, ...retries]) if (handle !== null) clearTimer(handle)
    } }
}
