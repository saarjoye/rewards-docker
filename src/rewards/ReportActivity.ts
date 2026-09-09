import type { RewardOffer } from './RewardsModel.js'

export function buildReportActivityBody(
  offer: Pick<RewardOffer, 'sourceTaskId' | 'hash' | 'activityType' | 'isPromotional'>,
  timezoneOffset = -480
): readonly unknown[] {
  if (!offer.hash) throw new TypeError('reportActivity requires an offer hash')
  return [
    offer.hash,
    offer.activityType ?? 11,
    {
      offerid: offer.sourceTaskId,
      isPromotional:
        offer.isPromotional === undefined ? '$undefined' : offer.isPromotional.toString(),
      timezoneOffset: timezoneOffset.toString()
    }
  ]
}
