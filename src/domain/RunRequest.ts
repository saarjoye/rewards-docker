export type AccountMode = 'continue' | 'account'
export type ExecutionMode = 'read-only' | 'mutating'

export interface RunRequest {
  accountMode: AccountMode
  runAccountIndex?: number
  executionMode?: ExecutionMode
}

export interface SelectedAccount<T> {
  account: T
  runAccountIndex: number
}

export function selectAccounts<T>(
  accounts: readonly T[],
  request: RunRequest,
  isComplete: (account: T, runAccountIndex: number) => boolean
): SelectedAccount<T>[] {
  if (request.accountMode === 'continue') {
    if (request.runAccountIndex !== undefined) {
      throw new TypeError('continue mode must not include runAccountIndex')
    }
    return accounts.flatMap((account, index) => {
      const runAccountIndex = index + 1
      return isComplete(account, runAccountIndex) ? [] : [{ account, runAccountIndex }]
    })
  }

  const selectedIndex = request.runAccountIndex
  if (!Number.isInteger(selectedIndex) || selectedIndex === undefined) {
    throw new RangeError('account mode requires an integer runAccountIndex')
  }
  if (selectedIndex < 1 || selectedIndex > accounts.length) {
    throw new RangeError(`runAccountIndex must be between 1 and ${String(accounts.length)}`)
  }

  return [{ account: accounts[selectedIndex - 1] as T, runAccountIndex: selectedIndex }]
}
