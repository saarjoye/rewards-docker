import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeFileAtomic(
  targetPath: string,
  content: Uint8Array | string,
  mode = 0o600
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${String(process.pid)}.${String(Date.now())}.tmp`
  let created = false

  try {
    const handle = await open(temporaryPath, 'wx', mode)
    created = true
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporaryPath, targetPath)
  } catch (error) {
    if (created) await rm(temporaryPath, { force: true })
    throw error
  }
}
