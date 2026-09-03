const width = Number(process.argv[2] || 1440)
const height = Number(process.argv[3] || 900)
const pages = await fetch('http://127.0.0.1:9222/json/list').then(response => response.json())
const page = pages.find(item => item.type === 'page')
if (!page) throw new Error('没有可用的 CDP 页面')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
})
socket.send(
    JSON.stringify({
        id: 1,
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width, height, deviceScaleFactor: 1, mobile: width <= 760 }
    })
)
await new Promise(resolve => setTimeout(resolve, 150))
socket.close()
console.log(`${width}x${height}`)
