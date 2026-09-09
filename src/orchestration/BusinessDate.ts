import { localDateKey } from '../domain/DateKey.js'

export class BusinessDateChanged extends Error {
  constructor() {
    super('business-date-changed')
    this.name = 'BusinessDateChanged'
  }
}

export function assertBusinessDate(expected: string, now = new Date()): void {
  if (localDateKey(now) !== expected) throw new BusinessDateChanged()
}
