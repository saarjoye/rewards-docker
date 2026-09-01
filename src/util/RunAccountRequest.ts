import { validateRunAccountIndex, type RunAccountMode } from './RunCheckpointStore'

function optionalRunAccountIndex(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined
    const parsed = Number(value)
    if (!Number.isInteger(parsed)) throw new Error('运行账号序号必须是整数')
    return parsed
}

export function resolveRunAccountRequest(
    accountMode: RunAccountMode,
    indexValue: unknown,
    accountCount: number
): { accountMode: RunAccountMode; accountIndex?: number } {
    const requestedIndex = optionalRunAccountIndex(indexValue)
    const resolvedMode = accountMode === 'continue' && requestedIndex !== undefined ? 'account' : accountMode
    const accountIndex = resolvedMode === 'account' ? requestedIndex : undefined
    validateRunAccountIndex(accountCount, resolvedMode, accountIndex)
    return { accountMode: resolvedMode, accountIndex }
}

export function buildRunAccountEnvironment(accountMode: RunAccountMode, accountIndex?: number): Record<string, string> {
    return {
        RUN_ACCOUNT_MODE: accountMode,
        ...(accountMode === 'account' && accountIndex !== undefined ? { RUN_ACCOUNT_INDEX: String(accountIndex) } : {})
    }
}
