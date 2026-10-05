import type { QuestRow } from '../rewards/RewardsModel.js'
import type { OfferAnchor } from './OfferMatching.js'

/** Serialized into the browser; all evidence is scoped to a single visible task row. */
export function readQuestRows(): QuestRow[] {
  return [...document.querySelectorAll<HTMLElement>('h3')].flatMap((heading) => {
    if (
      !heading.getClientRects().length ||
      window.getComputedStyle(heading).visibility === 'hidden'
    )
      return []
    const row = heading.closest('div.flex.flex-row')
    const title = heading.textContent.trim()
    if (!row || !title || row.querySelectorAll('h3').length !== 1) return []
    const actions = [...row.querySelectorAll('a[href], button')]
    const successes = row.querySelectorAll(
      '.bg-statusSuccessRewardsBg svg path[d="m1.147 2.919 1.788 1.953 3.25-3.743"]'
    ).length
    const locked =
      [...row.querySelectorAll('svg path')].some((path) =>
        path.getAttribute('d')?.startsWith('M5 3.5a3 3 0 0 1 6 0V4h.5')
      ) ||
      actions.some(
        (node) =>
          node.getAttribute('aria-disabled') === 'true' ||
          node.hasAttribute('disabled') ||
          node.hasAttribute('data-disabled')
      )
    const state =
      successes === 1 && !locked && actions.length === 0
        ? 'completed'
        : successes > 0
          ? 'unknown'
          : locked
            ? 'locked'
            : actions.length === 1
              ? 'open'
              : 'unknown'
    return [{ title, state, actionCount: actions.length }]
  })
}

export interface QuestAnchor extends OfferAnchor {
  rowTitle: string
  disabled: boolean
}

/** Uses the same anchor snapshot both during discovery and immediately before activation. */
export function readQuestAnchor(node: HTMLElement | SVGElement): QuestAnchor {
  const anchor = node as HTMLAnchorElement
  const row = anchor.closest('div.flex.flex-row')
  const headings = row?.querySelectorAll('h3')
  return {
    href: anchor.href,
    ariaLabel: anchor.getAttribute('aria-label') ?? '',
    rowTitle: headings?.length === 1 ? (headings[0]?.textContent.trim() ?? '') : '',
    offerId: anchor.getAttribute('data-offer-id') ?? '',
    visible:
      anchor.isConnected &&
      anchor.getClientRects().length > 0 &&
      window.getComputedStyle(anchor).visibility !== 'hidden',
    disabled:
      anchor.getAttribute('aria-disabled') === 'true' ||
      anchor.hasAttribute('disabled') ||
      anchor.hasAttribute('data-disabled')
  }
}
