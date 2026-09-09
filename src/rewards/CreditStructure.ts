const containers = new Set([
  'response',
  'dashboard',
  'userstatus',
  'userinfo',
  'promotions',
  'offers',
  'attributes',
  'credits',
  'transactions',
  'rewards',
  'history',
  'items',
  'records',
  'data'
])
const fields = [
  'balance',
  'availablepoints',
  'pointprogress',
  'pointprogressmax',
  'pointmax',
  'progress',
  'max',
  'complete',
  'offerid',
  'taskid',
  'creditid',
  'officialcreditid',
  'transactionid',
  'receiptid',
  'earnedpoints',
  'creditedpoints',
  'awardedpoints',
  'rewardpoints',
  'points',
  'amount',
  'creditedat',
  'earnedat',
  'timestamp'
] as const
type Candidate = (typeof fields)[number]
type ValueType = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'other'
export interface CreditStructure {
  scope: 'allowlisted-app-dashboard-structure' | 'allowlisted-app-activity-structure'
  fields: Array<{ field: Candidate; types: ValueType[]; occurrences: number }>
  truncated: boolean
  hasUninspectedBranches: boolean
}

export function inspectCreditStructure(
  payload: unknown,
  scope: CreditStructure['scope'] = 'allowlisted-app-dashboard-structure'
): CreditStructure {
  const found = new Map<Candidate, { types: Set<ValueType>; occurrences: number }>()
  const candidates = new Set<string>(fields)
  const seen = new WeakSet<object>()
  let budget = 10_000
  let truncated = false
  let hasUninspectedBranches = false
  const visit = (value: unknown, depth: number): void => {
    if (--budget < 0 || depth > 12) {
      truncated = true
      return
    }
    if (value === null || typeof value !== 'object') return
    if (seen.has(value)) {
      truncated = true
      return
    }
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1)
        if (budget < 0) break
      }
      return
    }
    for (const key of Object.keys(value)) {
      if (--budget < 0) {
        truncated = true
        break
      }
      const canonical = key.toLowerCase().replaceAll('_', '').replaceAll('-', '')
      if (!candidates.has(canonical) && !containers.has(canonical)) {
        hasUninspectedBranches = true
        continue
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        hasUninspectedBranches = true
        continue
      }
      const item: unknown = descriptor.value
      if (candidates.has(canonical)) {
        const field = canonical as Candidate
        const type: ValueType =
          item === null
            ? 'null'
            : Array.isArray(item)
              ? 'array'
              : ['object', 'string', 'number', 'boolean'].includes(typeof item)
                ? (typeof item as ValueType)
                : 'other'
        const entry = found.get(field) ?? { types: new Set<ValueType>(), occurrences: 0 }
        entry.types.add(type)
        entry.occurrences += 1
        found.set(field, entry)
      }
      if (containers.has(canonical)) visit(item, depth + 1)
    }
  }
  visit(payload, 0)
  return {
    scope,
    truncated,
    hasUninspectedBranches,
    fields: [...found]
      .map(([field, entry]) => ({
        field,
        types: [...entry.types].sort(),
        occurrences: entry.occurrences
      }))
      .sort((a, b) => a.field.localeCompare(b.field))
  }
}
