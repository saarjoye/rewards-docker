export const REWARDS_ORIGIN = 'https://rewards.bing.com'
export const BING_ORIGIN = 'https://www.bing.com'
export const PLATFORM_ORIGIN = 'https://prod.rewardsplatform.microsoft.com'

export const REWARDS_URLS = {
  login: `${REWARDS_ORIGIN}/auth/login`,
  dashboard: `${REWARDS_ORIGIN}/dashboard`,
  earn: `${REWARDS_ORIGIN}/earn`,
  userInfo: `${REWARDS_ORIGIN}/api/getuserinfo?type=1`,
  quest: (offerId: string): string => `${REWARDS_ORIGIN}/earn/quest/${encodeURIComponent(offerId)}`,
  flyout: `${BING_ORIGIN}/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards`,
  bingSignIn: `${BING_ORIGIN}/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F`,
  appDashboard: `${PLATFORM_ORIGIN}/dapi/me?channel=SAIOS&options=613`,
  appActivities: `${PLATFORM_ORIGIN}/dapi/me/activities`,
  oauthAuthorize: 'https://login.live.com/oauth20_authorize.srf',
  oauthRedirect: 'https://login.live.com/oauth20_desktop.srf',
  oauthToken: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
} as const
