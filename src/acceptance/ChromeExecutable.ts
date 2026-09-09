import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { AcceptanceInspectionError } from './AccountAcceptance.js'

async function firstAccessible(paths: readonly (string | undefined)[]): Promise<string> {
  for (const path of paths) {
    if (!path) continue
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    ) {
      return path
    }
  }
  throw new AcceptanceInspectionError('failed', 'browser-launch', 'chrome-executable-missing')
}

export async function resolveChromeExecutable(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<string> {
  if (env.REWARDS_BROWSER_EXECUTABLE) {
    return firstAccessible([env.REWARDS_BROWSER_EXECUTABLE])
  }
  return firstAccessible([
    env.LOCALAPPDATA
      ? join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
    env.PROGRAMFILES
      ? join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
    env['PROGRAMFILES(X86)']
      ? join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined
  ])
}
