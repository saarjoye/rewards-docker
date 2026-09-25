export interface SearchQueryAllocationInput {
  localDate: string
  accountId: string
  taskId: string
  candidates: Iterable<string>
}

/** Reservations are never released: a crash may hide a successful submission. */
export interface SearchQueryAllocator {
  reserve(input: SearchQueryAllocationInput): string | null
}

export function normalizeSearchQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}
