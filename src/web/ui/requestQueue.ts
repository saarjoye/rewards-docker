export function createRequestQueue<T>(
  load: () => Promise<T>,
  apply: (value: T) => void,
  fail: (error: unknown) => void
) {
  let revision = 0
  let pending = false
  let active: Promise<void> | undefined
  return function refresh(): Promise<void> {
    revision += 1
    pending = true
    active ??= (async () => {
      while (pending) {
        pending = false
        const current = revision
        try {
          const value = await load()
          if (current === revision) apply(value)
        } catch (error) {
          if (current === revision) fail(error)
        }
      }
    })().finally(() => {
      active = undefined
      if (pending) return refresh()
    })
    return active
  }
}
