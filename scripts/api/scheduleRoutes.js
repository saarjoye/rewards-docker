export async function handleSchedule({ method, pathname, authorized, writable, read, write, controller, body, send }) {
    if (!['/schedule', '/schedule/trigger'].includes(pathname)) return false
    if (!authorized) {
        send(401, { error: '调度操作需要认证', code: 'UNAUTHORIZED' })
        return true
    }
    try {
        if (pathname === '/schedule/trigger' && method === 'POST') {
            const result = controller.trigger()
            send(result.lastTrigger?.result === 'failed' ? 500 : 200, result)
        } else if (pathname === '/schedule' && method === 'GET') {
            send(200, { ...read(), ...controller.status(), writable })
        } else if (pathname === '/schedule' && ['PATCH', 'PUT'].includes(method)) {
            if (!writable) {
                send(403, { error: '调度写入未启用', code: 'SCHEDULE_READ_ONLY' })
                return true
            }
            const patch = await body()
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                send(400, { error: '调度配置必须为对象', code: 'BAD_REQUEST' })
                return true
            }
            const updated = write(patch)
            controller.cancel()
            send(200, { ...updated, ...controller.status(), writable: true })
        } else send(405, { error: '请求方法不支持' })
    } catch (error) {
        send(error.code === 'BAD_REQUEST' ? 400 : 500, {
            error:
                error.code === 'BAD_REQUEST' ? '调度字段、cron 或时区无效' : '调度读取或应用失败，请检查 Core 调度状态',
            code: error.code || 'SCHEDULE_FAILED'
        })
    }
    return true
}
