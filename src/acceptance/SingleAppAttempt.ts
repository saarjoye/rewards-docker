import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { localDateKey } from '../domain/DateKey.js'
import type { RewardOffer } from '../rewards/RewardsModel.js'

export function selectSingleAppOffer(
  offers: readonly RewardOffer[],
  now = new Date()
): RewardOffer | undefined {
  return offers.find((offer) => {
    if (
      offer.source !== 'app-dashboard' ||
      offer.complete ||
      !offer.executable ||
      !offer.sourceTaskId
    )
      return false
    if (offer.type === 'app-activity' && offer.attributes?.type === 'sapphire') return true
    if (offer.type !== 'app-check-in') return false
    const updated = offer.attributes?.last_updated
    return Boolean(
      updated &&
      /(Z|[+-]\d{2}:\d{2})$/.test(updated) &&
      Number.isFinite(Date.parse(updated)) &&
      localDateKey(new Date(updated)) < localDateKey(now)
    )
  })
}

export function singleAppPayload(offer: RewardOffer): Record<string, unknown> {
  if (offer.type === 'app-check-in')
    return {
      risk_context: {},
      type: 103,
      channel: 'SAIOS',
      attributes: {},
      id: randomUUID(),
      amount: 1,
      country: 'CN'
    }
  if (offer.type !== 'app-activity') throw new Error('unsupported-single-app-task')
  return {
    id: randomUUID(),
    amount: 1,
    type: 101,
    attributes: { offerid: offer.sourceTaskId },
    country: 'CN'
  }
}

export async function reserveSingleAppAttempt(
  directory: string,
  accountIdentity: string,
  businessDate: string
): Promise<boolean> {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([accountIdentity, businessDate, 'single-app-audit']))
    .digest('hex')
  let file
  try {
    file = await open(join(directory, `app-audit-${fingerprint}.lock`), 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await file.writeFile('reserved-no-automatic-retry\n')
    await file.sync()
  } finally {
    await file.close()
  }
  return true
}
