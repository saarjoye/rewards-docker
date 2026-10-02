import { REWARDS_ORIGIN, REWARDS_URLS } from './Urls.js'

export interface ClaimControlSnapshot {
  index: number
  texts: readonly string[]
  contextTexts: readonly string[]
  expanded: string | null
  controls: string | null
  href?: string | null
  popup?: string | null
  disabled: boolean
  visible: boolean
}

const claimKeyword = /\bclaim(?:able)?\b|\bcollect\b|领取|領取/i
const allKeyword = /\b(?:all|everything)\b|全部|所有/i
// A Star card may mention an unclaimed reward while showing only its maximum capacity.
// The cap is not evidence of an amount that can actually be claimed.
const nonClaimAmountLabel =
  /(?:积分|積分|点数|點數)上限|上限(?:积分|積分|点数|點數)|\b(?:points?\s+(?:cap|limit)|(?:max(?:imum)?|cap|limit)\s+points?)\b/i
const claimableAmountLabel = String.raw`(?:可(?:领取|領取)(?:积分|積分|点数|點數)?|待(?:领取|領取)(?:积分|積分|点数|點數)?|\bclaimable(?:\s+points)?\b|\bunclaimed(?:\s+points)?\b|\bpending\s+points\b|\bpoints\s+to\s+claim\b|\bavailable\s+to\s+claim\b)`
// Capture the whole token before validating so malformed amounts cannot become partial integers.
const amountToken = String.raw`[+\-\u2212]?\s*\d+(?:[.,，\u00a0\u202f]\s*\d+)*`

function controlText(control: ClaimControlSnapshot): string {
  // Keep nonbreaking thousands separators intact when joining accessible and visible labels.
  return control.texts.join(' ').trim()
}

function supportedClaimLink(href: string | null | undefined): boolean {
  if (href === null || href === undefined) return true
  try {
    const url = new URL(href, REWARDS_URLS.dashboard)
    return url.origin === REWARDS_ORIGIN && ['/dashboard', '/earn'].includes(url.pathname)
  } catch {
    return false
  }
}

function isClaimControl(control: ClaimControlSnapshot): boolean {
  const text = controlText(control)
  return (
    supportedClaimLink(control.href) &&
    claimKeyword.test(text) &&
    !/\bredeem\b|兑换|兌換/i.test(text)
  )
}

function uniqueAmount(text: string): number | undefined {
  const tokens = [...text.matchAll(new RegExp(amountToken, 'g'))].map(([token]) =>
    token.trim().replace(/[，\u00a0\u202f]/g, ',')
  )
  if (!tokens.length || tokens.some((token) => !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(token)))
    return undefined
  const amounts = tokens.map((token) => Number(token.replaceAll(',', '')))
  return amounts.every(
    (amount) => Number.isSafeInteger(amount) && amount >= 0 && amount === amounts[0]
  )
    ? amounts[0]
    : undefined
}

export function claimControlPoints(control: ClaimControlSnapshot): number | undefined {
  if (!isClaimControl(control)) return undefined
  const text = controlText(control)
  const hasNonClaimAmount = nonClaimAmountLabel.test(text)
  const direct = hasNonClaimAmount ? undefined : uniqueAmount(text)
  if (!hasNonClaimAmount && /\d/.test(text) && direct === undefined) return undefined
  const contexts: number[] = []
  const labeledTexts = hasNonClaimAmount ? [text, ...control.contextTexts] : control.contextTexts
  for (const context of labeledTexts) {
    const prefix = new RegExp(`${claimableAmountLabel}\\s*[:：]?\\s*(${amountToken})`, 'gi')
    const suffix = new RegExp(
      String.raw`(?<![\d.,，\u00a0\u202f+\-\u2212])(${amountToken})\s*(?:待领取|待領取|\bpoints\s+to\s+claim\b)`,
      'gi'
    )
    for (const match of [...context.matchAll(prefix), ...context.matchAll(suffix)]) {
      const points = uniqueAmount(match[1] ?? '')
      if (points === undefined) return undefined
      contexts.push(points)
    }
  }
  if (contexts.some((points) => points !== (direct ?? contexts[0]))) return undefined
  return direct ?? contexts[0]
}

export function claimablePointsFromControls(
  controls: readonly ClaimControlSnapshot[]
): number | undefined {
  const visible = controls.filter(
    (control) => control.visible && isClaimControl(control) && !isCapOnlyControl(control)
  )
  const summaries = visible.filter(
    (control) => control.expanded !== null || allKeyword.test(controlText(control))
  )
  const candidates = (summaries.length ? summaries : visible)
    .map((control) => claimControlPoints(control))
    .filter((points): points is number => points !== undefined)
  return summaries.length &&
    candidates.length &&
    candidates.every((points) => points === candidates[0])
    ? candidates[0]
    : candidates.length === 1
      ? candidates[0]
      : undefined
}

function isCapOnlyControl(control: ClaimControlSnapshot): boolean {
  const text = controlText(control)
  if (!nonClaimAmountLabel.test(text) || claimControlPoints(control) !== undefined) return false
  const combined = [text, ...control.contextTexts].join(' ')
  const labeled = new RegExp(claimableAmountLabel + String.raw`\s*[:：]?\s*[+\-\u2212]?\s*\d`, 'i')
  const trailing = /\d\s*(?:待领取|待領取|\bpoints\s+to\s+claim\b)/i
  return !labeled.test(combined) && !trailing.test(combined)
}

export function selectClaimAction(
  controls: readonly ClaimControlSnapshot[],
  expectedPoints: number
): ClaimControlSnapshot | undefined {
  if (!Number.isSafeInteger(expectedPoints) || expectedPoints <= 0) return undefined
  const candidates = controls.filter((control) => {
    if (
      !control.visible ||
      control.disabled ||
      control.expanded !== null ||
      control.href != null ||
      control.popup === 'dialog' ||
      !isClaimControl(control)
    )
      return false
    const text = controlText(control)
    const points = claimControlPoints(control)
    return (
      points === expectedPoints ||
      (points === undefined &&
        allKeyword.test(text) &&
        !/\d/.test(text) &&
        !control.contextTexts.some((context) =>
          new RegExp(claimableAmountLabel, 'i').test(context)
        ))
    )
  })
  const aggregate = candidates.filter((control) => allKeyword.test(controlText(control)))
  return aggregate.length === 1
    ? aggregate[0]
    : aggregate.length === 0 && candidates.length === 1
      ? candidates[0]
      : undefined
}
