import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { HashedMutationLedger } from '../src/acceptance/HashedMutationLedger.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('acceptance mutation ledger', () => {
  it('survives reruns with a new transient account id without storing the logical task key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-acceptance-ledger-'))
    roots.push(root)
    const path = join(root, 'mutation-ledger.sqlite')
    const firstTask = 'transient-account-a:2026-09-04:daily-offer:article:1'
    const secondTask = 'transient-account-b:2026-09-04:daily-offer:article:1'

    const first = new HashedMutationLedger(path, 2, '2026-09-04')
    expect(first.beginMutation(firstTask)).toBe(true)
    first.updateMutation(firstTask, 'verification-pending')
    first.close()

    const second = new HashedMutationLedger(path, 2, '2026-09-04')
    expect(second.getMutationState(secondTask)).toBe('verification-pending')
    expect(second.beginMutation(secondTask)).toBe(false)
    second.close()

    const database = new DatabaseSync(path, { readOnly: true })
    const row = database
      .prepare('SELECT account_index, local_date, task_hash, state FROM acceptance_mutations')
      .get() as { account_index: number; local_date: string; task_hash: string; state: string }
    database.close()
    expect(row).toMatchObject({
      account_index: 2,
      local_date: '2026-09-04',
      state: 'verification-pending'
    })
    expect(row.task_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row.task_hash).not.toContain('daily-offer')
    expect((await readFile(path)).includes(Buffer.from('daily-offer'))).toBe(false)
  })

  it('isolates the same logical task by account index and local date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-acceptance-ledger-scope-'))
    roots.push(root)
    const path = join(root, 'mutation-ledger.sqlite')
    const first = new HashedMutationLedger(path, 1, '2026-09-04')
    expect(first.beginMutation('temporary:2026-09-04:offer')).toBe(true)
    first.close()

    const otherAccount = new HashedMutationLedger(path, 2, '2026-09-04')
    expect(otherAccount.getMutationState('temporary:2026-09-04:offer')).toBeUndefined()
    otherAccount.close()
    const otherDate = new HashedMutationLedger(path, 1, '2026-09-05')
    expect(otherDate.getMutationState('temporary:2026-09-05:offer')).toBeUndefined()
    otherDate.close()
  })

  it('allows a task to start again only when submission never began', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-acceptance-ledger-cancel-'))
    roots.push(root)
    const path = join(root, 'mutation-ledger.sqlite')
    const taskId = 'temporary:2026-09-04:missing-link'
    const ledger = new HashedMutationLedger(path, 1, '2026-09-04')

    expect(ledger.beginMutation(taskId)).toBe(true)
    expect(ledger.getMutationState(taskId)).toBe('submission-started')
    ledger.cancelMutation(taskId)
    expect(ledger.getMutationState(taskId)).toBeUndefined()
    expect(ledger.beginMutation(taskId)).toBe(true)
    ledger.updateMutation(taskId, 'submitted')
    ledger.cancelMutation(taskId)
    expect(ledger.getMutationState(taskId)).toBe('submitted')
    ledger.close()
  })
})
