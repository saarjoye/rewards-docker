import patchright from 'patchright'

import { DashboardClient } from '../src/browser/DashboardClient.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { RewardsDiscoveryService } from '../src/rewards/RewardsDiscoveryService.js'

const browser = await patchright.chromium.connectOverCDP(
  process.env.CDP_URL ?? 'http://127.0.0.1:9222'
)

try {
  const context = browser.contexts()[0]
  const page = context?.pages()[0]
  if (!context || !page) throw new Error('cdp-page-missing')
  const logger = { write: () => Promise.resolve() } as unknown as StructuredLogger
  const client = new DashboardClient(context, page, logger, 'read-only-check', 'account')
  const observation = await client.fetchFlyout()
  const bootstrap = await client.bootstrapRsc()
  const domOffers = await client.discoverDomOffers()
  const discovery = await new RewardsDiscoveryService().discover({
    accountId: 'read-only-account',
    localDate: 'read-only-date',
    client
  })
  const taskCounts = Object.fromEntries(
    [...new Set(discovery.tasks.map((task) => task.type))].sort().map((type) => [
      type,
      {
        count: discovery.tasks.filter((task) => task.type === type).length,
        statuses: [
          ...new Set(
            discovery.tasks.filter((task) => task.type === type).map((task) => task.status)
          )
        ].sort()
      }
    ])
  )
  const output = {
    source: observation?.source ?? 'unavailable',
    rewardsUser: observation?.rewardsUser.value === true,
    balanceAvailability: observation?.availablePoints.availability ?? 'unknown',
    pcAvailability: observation?.pcSearch.availability ?? 'unknown',
    pcProgress: observation?.pcSearch.value ?? null,
    mobileAvailability: observation?.mobileSearch.availability ?? 'unknown',
    discoveredOffers: observation?.offers.length ?? 0,
    rscOffers: bootstrap.offers.length,
    domOffers: domOffers.length,
    actionNames: Object.keys(bootstrap.actionIds).sort(),
    actionCount: Object.keys(bootstrap.actionIds).length,
    taskCounts
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
} finally {
  await browser.close()
}
