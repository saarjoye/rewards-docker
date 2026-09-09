import { createEvidence, type EvidenceSource, type FieldEvidence } from '../domain/Evidence.js'
import { localDateKey } from '../domain/DateKey.js'
import type { RewardOffer, RewardsObservation, SearchQuota } from './RewardsModel.js'

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): RecordValue | undefined {
  return isRecord(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function evidence<T>(input: {
  availability: FieldEvidence<T>['availability']
  source: EvidenceSource
  confidence: number
  observedAt: string
  value?: T
  reason?: string
}): FieldEvidence<T> {
  return createEvidence({
    availability: input.availability,
    source: input.source,
    confidence: input.confidence,
    observedAt: input.observedAt,
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.reason === undefined ? {} : { reason: input.reason })
  })
}

function missing<T>(source: EvidenceSource, observedAt: string, reason: string): FieldEvidence<T> {
  return evidence({ availability: 'missing', source, confidence: 0, observedAt, reason })
}

function parseBalance(
  source: EvidenceSource,
  observedAt: string,
  userStatus: RecordValue | undefined,
  userInfo: RecordValue | undefined,
  appResponse: RecordValue | undefined
): FieldEvidence<number> {
  const candidates = [userStatus?.availablePoints, userInfo?.balance, appResponse?.balance]
  const raw = candidates.find((value) => value !== undefined)
  if (raw === undefined) return missing(source, observedAt, 'availablePoints missing')
  const value = safeNonNegativeInteger(raw)
  return value === undefined
    ? evidence({
        availability: 'invalid',
        source,
        confidence: 0,
        observedAt,
        reason: 'availablePoints is not a non-negative safe integer'
      })
    : evidence({
        availability: 'valid',
        source,
        confidence: source === 'bing-flyout' ? 0.95 : 0.9,
        observedAt,
        value
      })
}

function parseRewardsUser(
  source: EvidenceSource,
  observedAt: string,
  userStatus: RecordValue | undefined,
  userInfo: RecordValue | undefined,
  appResponse: RecordValue | undefined
): FieldEvidence<boolean> {
  const raw = userStatus?.isRewardsUser ?? userInfo?.isRewardsUser
  if (typeof raw === 'boolean') {
    return evidence({ availability: 'valid', source, confidence: 0.95, observedAt, value: raw })
  }
  if (appResponse && isRecord(appResponse.profile)) {
    return evidence({ availability: 'valid', source, confidence: 0.75, observedAt, value: true })
  }
  return missing(source, observedAt, 'Rewards membership flag missing')
}

function parseMarket(
  source: EvidenceSource,
  observedAt: string,
  root: RecordValue,
  userStatus: RecordValue | undefined,
  userInfo: RecordValue | undefined,
  appResponse: RecordValue | undefined
): FieldEvidence<string> {
  const appProfile = asRecord(appResponse?.profile)
  const rootUserInfo = asRecord(root.userInfo)
  const nestedCandidate = (scopes: readonly (RecordValue | undefined)[]): unknown => {
    const acceptedKeys = new Set(['market', 'country', 'countrycode', 'marketcode'])
    const queue = scopes.flatMap((scope) => (scope ? [{ value: scope, depth: 0 }] : []))
    for (const item of queue) {
      for (const [key, value] of Object.entries(item.value)) {
        if (acceptedKeys.has(key.toLowerCase()) && value !== undefined && value !== null) {
          return value
        }
        const child = asRecord(value)
        if (child && item.depth < 3) queue.push({ value: child, depth: item.depth + 1 })
      }
    }
    return undefined
  }
  const candidates = [
    userStatus?.market,
    userStatus?.country,
    userInfo?.market,
    userInfo?.country,
    root.market,
    root.country,
    appProfile?.market,
    appProfile?.country,
    appResponse?.market,
    appResponse?.country,
    nestedCandidate([userStatus, userInfo, rootUserInfo, appProfile])
  ]
  const raw = candidates.find((value) => value !== undefined && value !== null)
  if (raw === undefined) return missing(source, observedAt, 'market missing')
  if (typeof raw !== 'string' || !/^[A-Za-z]{2}$/.test(raw.trim())) {
    return evidence({
      availability: 'invalid',
      source,
      confidence: 0,
      observedAt,
      reason: 'market is not a two-letter country code'
    })
  }
  return evidence({
    availability: 'valid',
    source,
    confidence: source === 'bing-flyout' ? 0.95 : 0.9,
    observedAt,
    value: raw.trim().toUpperCase()
  })
}

function parseCounterArray(
  value: unknown,
  source: EvidenceSource,
  observedAt: string,
  name: string
): FieldEvidence<SearchQuota> {
  if (value === undefined || value === null) return missing(source, observedAt, `${name} missing`)
  if (!Array.isArray(value)) {
    return evidence({
      availability: 'invalid',
      source,
      confidence: 0,
      observedAt,
      reason: `${name} is not an array`
    })
  }
  if (value.length === 0) {
    return evidence({
      availability: 'empty',
      source,
      confidence: 0,
      observedAt,
      reason: `${name} is empty`
    })
  }

  let completed = 0
  let total = 0
  for (const item of value) {
    if (!isRecord(item)) {
      return evidence({
        availability: 'invalid',
        source,
        confidence: 0,
        observedAt,
        reason: `${name} contains a non-object entry`
      })
    }
    const itemTotal = safeNonNegativeInteger(item.pointProgressMax)
    const itemCompleted = safeNonNegativeInteger(item.pointProgress)
    if (itemTotal === undefined || itemCompleted === undefined || itemCompleted > itemTotal) {
      return evidence({
        availability: 'invalid',
        source,
        confidence: 0,
        observedAt,
        reason: `${name} contains an invalid progress entry`
      })
    }
    completed += itemCompleted
    total += itemTotal
  }

  return evidence({
    availability: 'valid',
    source,
    confidence: source === 'bing-flyout' ? 0.95 : 0.9,
    observedAt,
    value: { completed, total, remaining: total - completed }
  })
}

function attributeStrings(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
      ? [[key, String(item)] as const]
      : []
  )
  return entries.length ? Object.fromEntries(entries) : undefined
}

function normalizeOffer(
  item: RecordValue,
  source: RewardOffer['source'],
  type: RewardOffer['type'],
  parentOfferId?: string
): RewardOffer | undefined {
  const attributes = attributeStrings(item.attributes)
  const sourceTaskId =
    stringValue(item.offerId) ?? stringValue(item.id) ?? attributes?.offerid ?? attributes?.offerId
  if (!sourceTaskId) return undefined

  const total = safeNonNegativeInteger(
    item.pointProgressMax ??
      item.points ??
      attributes?.max ??
      attributes?.pointmax ??
      attributes?.activitymax ??
      attributes?.pointProgressMax
  )
  const completed =
    safeNonNegativeInteger(
      item.pointProgress ??
        attributes?.progress ??
        attributes?.pointprogress ??
        attributes?.activityprogress
    ) ?? 0
  const completeValue = item.complete ?? item.isCompleted ?? attributes?.complete
  const completeText = stringValue(completeValue)
  const complete =
    completeValue === true ||
    completeText?.toLowerCase() === 'true' ||
    (total !== undefined && total > 0 && completed >= total)
  const hash = stringValue(item.hash)
  const locked = item.isLocked === true || item.isDisabled === true
  const destinationUrl = stringValue(item.destinationUrl ?? item.destination)
  const activityType = safeNonNegativeInteger(
    item.activityType ?? item.activity_type ?? attributes?.activityType
  )
  const promotional = item.isPromotional ?? attributes?.promotional
  const hasReportMetadata =
    hash !== undefined &&
    (activityType !== undefined ||
      total !== undefined ||
      attributes !== undefined ||
      parentOfferId !== undefined)

  return {
    sourceTaskId,
    type,
    source,
    displayName:
      stringValue(item.title) ?? stringValue(item.name) ?? attributes?.title ?? sourceTaskId,
    completed,
    total: total ?? null,
    complete,
    executable:
      !locked && Boolean(destinationUrl || hasReportMetadata || source === 'app-dashboard'),
    ...(destinationUrl === undefined ? {} : { destinationUrl }),
    ...(hash === undefined ? {} : { hash }),
    ...(parentOfferId === undefined ? {} : { parentOfferId }),
    ...(activityType === undefined ? {} : { activityType }),
    ...(typeof promotional !== 'boolean' && typeof promotional !== 'string'
      ? {}
      : { isPromotional: promotional === true || String(promotional).toLowerCase() === 'true' }),
    ...(attributes === undefined ? {} : { attributes })
  }
}

function collectArrayOffers(
  value: unknown,
  source: RewardOffer['source'],
  type: RewardOffer['type']
): RewardOffer[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = asRecord(item)
    const offer = record ? normalizeOffer(record, source, type) : undefined
    return offer ? [offer] : []
  })
}

function normalizedDailyDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  const year = Number(iso?.[1] ?? us?.[3])
  const month = Number(iso?.[2] ?? us?.[1])
  const day = Number(iso?.[3] ?? us?.[2])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined
  }
  const candidate = new Date(year, month - 1, day)
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    return undefined
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function matchesDailyBusinessDate(offer: RewardOffer, businessDate: string): boolean {
  if (offer.type !== 'daily-set') return true
  const offerDate = normalizedDailyDate(offer.attributes?.daily_set_date)
  return offerDate === undefined || offerDate === businessDate
}

function collectDashboardOffers(
  root: RecordValue,
  source: RewardOffer['source'],
  businessDate: string
): RewardOffer[] {
  const offers: RewardOffer[] = []
  const daily = asRecord(root.dailySetPromotions)
  if (daily) {
    for (const [date, items] of Object.entries(daily)) {
      const groupDate = normalizedDailyDate(date)
      if (groupDate !== undefined && groupDate !== businessDate) continue
      offers.push(
        ...collectArrayOffers(items, source, 'daily-set').filter((offer) =>
          matchesDailyBusinessDate(offer, businessDate)
        )
      )
    }
  }
  offers.push(...collectArrayOffers(root.morePromotions, source, 'more-promotion'))
  offers.push(
    ...collectArrayOffers(root.morePromotionsWithoutPromotionalItems, source, 'more-promotion')
  )
  offers.push(...collectArrayOffers(root.highValueActionPromotions, source, 'special-promotion'))
  offers.push(...collectArrayOffers(root.promotionalItems, source, 'special-promotion'))
  offers.push(
    ...collectArrayOffers(root.edgeHighValueActionPromotions, source, 'special-promotion')
  )
  offers.push(...collectArrayOffers(root.exploreOnBingPromotions, source, 'special-promotion'))
  offers.push(...collectArrayOffers(root.exploreOnOutlookPromotions, source, 'special-promotion'))
  offers.push(
    ...collectArrayOffers(root.onboardingChecklistPromotions, source, 'special-promotion')
  )

  if (Array.isArray(root.punchCards)) {
    for (const rawCard of root.punchCards) {
      const card = asRecord(rawCard)
      if (!card) continue
      const parent = asRecord(card.parentPromotion)
      const parentOffer = parent ? normalizeOffer(parent, source, 'punch-card') : undefined
      if (parentOffer) offers.push(parentOffer)
      const parentId = parentOffer?.sourceTaskId
      for (const child of collectArrayOffers(card.childPromotions, source, 'punch-card')) {
        offers.push(parentId ? { ...child, parentOfferId: parentId } : child)
      }
    }
  }

  return offers
}

function collectAppOffers(response: RecordValue, observedAt: string): RewardOffer[] {
  if (!Array.isArray(response.promotions)) return []
  return response.promotions.flatMap((raw) => {
    const item = asRecord(raw)
    const attributes = item ? attributeStrings(item.attributes) : undefined
    if (!item || !attributes) return []
    const offerId = (attributes.offerid ?? attributes.offerId ?? '').toLowerCase()
    const appType = attributes.type?.toLowerCase() ?? ''
    let type: RewardOffer['type'] = 'unknown'
    if (appType === 'msnreadearn' || /readarticle|read.to.earn/.test(offerId)) {
      type = 'read-to-earn'
    } else if (appType === 'checkin' || /check.?in|daily.?check/.test(offerId)) {
      type = 'app-check-in'
    } else if (appType === 'sapphire') {
      type = 'app-activity'
    }
    const offer = normalizeOffer(item, 'app-dashboard', type)
    if (!offer) return []
    if (type === 'unknown') return [{ ...offer, executable: false }]

    const hidden = attributes.hidden?.toLowerCase() === 'true'
    if (type !== 'app-check-in') {
      return [
        {
          ...offer,
          executable: !offer.complete && !hidden
        }
      ]
    }

    const lastUpdated = attributes.last_updated
    const lastUpdatedDate = lastUpdated ? new Date(lastUpdated) : undefined
    const completedToday =
      offer.complete ||
      (lastUpdatedDate !== undefined &&
        Number.isFinite(lastUpdatedDate.getTime()) &&
        localDateKey(lastUpdatedDate) === localDateKey(new Date(observedAt)))
    return [
      {
        ...offer,
        complete: completedToday,
        completed: completedToday ? 1 : 0,
        total: 1,
        executable: !completedToday && !hidden
      }
    ]
  })
}

function uniqueOffers(offers: readonly RewardOffer[]): RewardOffer[] {
  const byKey = new Map<string, RewardOffer>()
  for (const offer of offers) {
    const key = `${offer.source}:${offer.sourceTaskId}`
    const current = byKey.get(key)
    if (!current || (!current.executable && offer.executable)) byKey.set(key, offer)
  }
  return [...byKey.values()]
}

export function parseDashboardPayload(
  payload: unknown,
  source: RewardOffer['source'],
  observedAt = new Date().toISOString(),
  businessDate = localDateKey(new Date(observedAt))
): RewardsObservation {
  const envelope = asRecord(payload)
  if (!envelope) throw new TypeError('Dashboard payload is not an object')
  if (envelope.isError === true) throw new Error('Dashboard payload reports an error')

  const dashboard = asRecord(envelope.dashboard)
  const flyout = asRecord(envelope.flyoutResult)
  const appResponse = asRecord(envelope.response)
  const root = dashboard ?? flyout ?? appResponse
  if (!root) throw new TypeError('Dashboard payload has no recognized root')

  const userStatus = asRecord(root.userStatus)
  const userInfo = asRecord(envelope.userInfo)
  const counters = asRecord(userStatus?.counters)
  const sourceName: EvidenceSource = source
  const offers = appResponse
    ? collectAppOffers(appResponse, observedAt)
    : collectDashboardOffers(root, source, businessDate)

  return {
    source,
    rewardsUser: parseRewardsUser(sourceName, observedAt, userStatus, userInfo, appResponse),
    market: parseMarket(sourceName, observedAt, root, userStatus, userInfo, appResponse),
    availablePoints: parseBalance(sourceName, observedAt, userStatus, userInfo, appResponse),
    pcSearch: parseCounterArray(
      counters?.pcSearch ?? counters?.PCSearch,
      sourceName,
      observedAt,
      'pcSearch'
    ),
    mobileSearch: parseCounterArray(
      counters?.mobileSearch ?? counters?.MobileSearch,
      sourceName,
      observedAt,
      'mobileSearch'
    ),
    offers: uniqueOffers(offers),
    topLevelFields: Object.keys(envelope).sort()
  }
}

function decodeFlightChunks(html: string): string {
  const pushPattern = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g
  let combined = ''
  for (const match of html.matchAll(pushPattern)) {
    const encoded = match[1]
    if (!encoded) continue
    try {
      combined += JSON.parse(`"${encoded}"`) as string
    } catch {
      continue
    }
  }
  return combined
}

function extractAnchoredObjects(text: string, anchor: string): RecordValue[] {
  const found: RecordValue[] = []
  let cursor = 0
  while (cursor < text.length) {
    const anchorIndex = text.indexOf(anchor, cursor)
    if (anchorIndex < 0) break
    cursor = anchorIndex + anchor.length
    let start = text.lastIndexOf('{', anchorIndex)
    while (start >= 0) {
      let depth = 0
      let inString = false
      let escaped = false
      let end = -1
      for (let index = start; index < text.length; index += 1) {
        const character = text[index]
        if (escaped) {
          escaped = false
          continue
        }
        if (inString && character === '\\') {
          escaped = true
          continue
        }
        if (character === '"') {
          inString = !inString
          continue
        }
        if (inString) continue
        if (character === '{') depth += 1
        if (character === '}' && --depth === 0) {
          end = index
          break
        }
      }
      if (end >= anchorIndex) {
        try {
          const parsed = JSON.parse(
            text.slice(start, end + 1).replace(/"\$undefined"/g, 'null')
          ) as unknown
          if (isRecord(parsed) && Object.hasOwn(parsed, anchor.replaceAll('"', ''))) {
            found.push(parsed)
            cursor = Math.max(cursor, end + 1)
            break
          }
        } catch {
          // Try the next enclosing object.
        }
      }
      start = text.lastIndexOf('{', start - 1)
    }
  }
  return found
}

function classifyRscOffer(item: RecordValue): RewardOffer['type'] {
  const offerId = (stringValue(item.offerId) ?? '').toLowerCase()
  const name = (stringValue(item.name) ?? '').toLowerCase()
  if (offerId.includes('pcparent') || offerId.includes('pcchild')) return 'punch-card'
  if (/daily|quiz|poll/.test(offerId) || /daily/.test(name)) return 'daily-set'
  if (/special|highvalue|searchonbing/.test(offerId + name)) return 'special-promotion'
  return 'more-promotion'
}

export type RewardsRouteSegment = 'earn' | 'dashboard'

export function buildRewardsRouterStateTree(segment: RewardsRouteSegment): string {
  const refreshFlag = 4096
  return encodeURIComponent(
    JSON.stringify([
      '',
      {
        children: [
          '(nav)',
          {
            children: [
              segment,
              { children: ['PAGE', {}, null, null, refreshFlag] },
              null,
              null,
              refreshFlag
            ]
          },
          null,
          null,
          refreshFlag
        ]
      },
      null,
      null,
      refreshFlag + 16
    ])
  )
}

export function buildRewardsQuestRouterStateTree(questId: string): string {
  return encodeURIComponent(
    JSON.stringify([
      '',
      {
        children: [
          '(nav)',
          {
            children: [
              'earn',
              {
                children: [
                  'quest',
                  {
                    children: [
                      ['questId', questId, 'd', null],
                      { children: ['__PAGE__', {}, null, null, 0] },
                      null,
                      null,
                      0
                    ]
                  },
                  null,
                  null,
                  0
                ]
              },
              null,
              null,
              0
            ]
          },
          null,
          null,
          0
        ]
      },
      null,
      null,
      16
    ])
  )
}

export function parseRewardsHtml(
  html: string,
  routeSegment?: RewardsRouteSegment,
  businessDate = localDateKey()
): {
  offers: readonly RewardOffer[]
  availablePoints: FieldEvidence<number>
  deploymentId?: string
  routerStateTree?: string
} {
  const observedAt = new Date().toISOString()
  const flight = decodeFlightChunks(html)
  const normalized = flight || html.replaceAll('\\"', '"')
  const offers = uniqueOffers(
    extractAnchoredObjects(normalized, '"offerId"').flatMap((item) => {
      const offer = normalizeOffer(item, 'rsc', classifyRscOffer(item))
      return offer ? [offer] : []
    })
  ).filter((offer) => matchesDailyBusinessDate(offer, businessDate))
  const pointsMatches = [...normalized.matchAll(/"availablePoints"\s*:\s*(\d+)/g)]
  const points = safeNonNegativeInteger(pointsMatches.at(-1)?.[1])
  const deploymentId =
    html.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1] ??
    normalized.match(/"buildId":"([A-Za-z0-9._-]+)"/)?.[1]

  return {
    offers,
    availablePoints:
      points === undefined
        ? missing('rsc', observedAt, 'availablePoints missing from Flight data')
        : evidence({
            availability: 'valid',
            source: 'rsc',
            confidence: 0.8,
            observedAt,
            value: points
          }),
    ...(deploymentId === undefined ? {} : { deploymentId }),
    ...(routeSegment === undefined
      ? {}
      : { routerStateTree: buildRewardsRouterStateTree(routeSegment) })
  }
}

export function extractActionIds(scripts: readonly string[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = {}
  const hex = '[a-f0-9]{40,64}'
  const pattern = new RegExp(
    `(?:create|register)ServerReference\\s*\\)?\\s*\\([^)]*?"(${hex})"([\\s\\S]{0,800}?)\\)`,
    'gi'
  )
  for (const script of scripts) {
    for (const match of script.matchAll(pattern)) {
      const actionId = match[1]
      const tail = match[2]
      if (!actionId || !tail) continue
      const names = [...tail.matchAll(/"([A-Za-z_$][\w$]{3,})"/g)]
        .map((item) => item[1])
        .filter(Boolean)
      const name = names.at(-1)
      if (name) output[name] = actionId
    }
    for (const match of script.matchAll(new RegExp(`\\$ACTION_ID_(${hex})`, 'gi'))) {
      if (match[1]) output[`anonymous-${String(Object.keys(output).length + 1)}`] = match[1]
    }
  }
  return output
}
