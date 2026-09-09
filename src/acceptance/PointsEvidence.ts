import type { PointsHistoryRecord } from '../infra/SqliteStore.js'

export interface AcceptancePointsEvidence {
  confirmed: boolean
  delta: number | null
  increased: boolean | null
  source: 'dashboard-before-after' | 'unconfirmed'
}

export function buildAcceptancePointsEvidence(
  record: PointsHistoryRecord | undefined
): AcceptancePointsEvidence {
  if (
    !record?.balanceConfirmed ||
    record.initialPoints === null ||
    record.finalPoints === null ||
    record.gainedPoints === null ||
    !Number.isSafeInteger(record.initialPoints) ||
    record.initialPoints < 0 ||
    !Number.isSafeInteger(record.finalPoints) ||
    record.finalPoints < 0 ||
    !Number.isSafeInteger(record.gainedPoints) ||
    record.gainedPoints !== record.finalPoints - record.initialPoints
  ) {
    return {
      confirmed: false,
      delta: null,
      increased: null,
      source: 'unconfirmed'
    }
  }

  return {
    confirmed: true,
    delta: record.gainedPoints,
    increased: record.gainedPoints > 0,
    source: 'dashboard-before-after'
  }
}
