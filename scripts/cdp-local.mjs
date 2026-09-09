import { setTimeout, clearTimeout } from 'node:timers'

export async function connectLocalCdp(url) {
  const socket = new globalThis.WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  const errors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails.text)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
    else entry.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('CDP closed'))
    }
    pending.clear()
  })
  return {
    errors,
    send(method, params = {}, sessionId) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }, 15000)
        pending.set(id, { resolve, reject, timer, method })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      })
    },
    close() {
      socket.close()
    }
  }
}
