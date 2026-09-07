import http from 'node:http'

const port = Number(process.env.API_PORT || 3010)
const token = process.env.API_TOKEN
if (!token || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    console.error('调度触发失败：控制接口认证或端口未配置')
    process.exitCode = 1
} else {
    const request = http.request(
        {
            host: '127.0.0.1',
            port,
            path: '/schedule/trigger',
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        },
        response => {
            response.resume()
            const accepted = response.statusCode === 200
            console.log(accepted ? '调度请求已处理，任务结果请查看运行记录' : '调度请求失败，未确认任务启动')
            if (!accepted) process.exitCode = 1
        }
    )
    request.on('error', () => {
        console.error('调度控制接口不可用')
        process.exitCode = 1
    })
    request.setTimeout(10000, () => request.destroy())
    request.end()
}
