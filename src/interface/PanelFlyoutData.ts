export interface PanelFlyoutData {
  userInfo: UserInfo
  flyoutConfig: FlyoutConfig
  isError: boolean
  isUnsupportedCountry: boolean
  errorMessage: any
  isRewardsUser: boolean
  isDarkMode: boolean
  flyoutResult: FlyoutResult
  channel: string
  userId: string
  testHookDate: any
  isVisualParityTest: boolean
  loggingContext: LoggingContext
  partnerId: string
  language: string
  partnerInfo: PartnerInfo
  localizedStrings: LocalizedStrings
  additionalParameters: any
  additionalParametersStringForEnrollUrl: any
  additionalParametersStringForOfferUrl: any
  additionalParametersStringForAjaxCall: any
  isLiftedSearchCapAutoClaimEnabled: number
  isLiftedSearchCapAutoClaimSuccessful: boolean
  showAADLinkingExperience: boolean
  featureNames: string
  isMobileOnlyPartner: boolean
}

export interface UserInfo {
  isRewardsUser: boolean
  balance: number
  lifetimeGivingPoints: number
  profile: Profile
  counters: Counters
  promotions: Promotion[]
  catalogItems: CatalogItem[]
  orders: any[]
  catalogGoal: CatalogGoal
  giveUserProfile: any
  rebateProfile: any
  thirdPartyProfile: any
  autoRedeemProfile: AutoRedeemProfile
  autoRedeemItem: any
  errorCode: number
  errorMessage: any
  activities: any
  rewardsCountry: string
}

export interface Profile {
  ruid: string
  attributes: Attributes
}

export interface Attributes {
  ismsaautojoined: string
  created: string
  creative: string
  publisher: string
  program: string
  country: string
  target: string
  epuid: string
  level: string
  level_upd: string
  iris_segmentation: string
  iris_segmentation_upd: string
  waitlistattributes: string
  waitlistattributes_upd: string
  creative_upd: string
  publisher_upd: string
  previous_creative: string
  previous_creative_upd: string
  previous_publisher: string
  previous_publisher_upd: string
  iscashbackeligible: string
}

export interface Counters {}

export interface Promotion {
  name: string
  priority: number
  attributes: Attributes2
}

export interface Attributes2 {
  animated_icon?: string
  bg_image?: string
  complete?: string
  description?: string
  destination?: string
  hidden?: string
  icon?: string
  image?: string
  link_text?: string
  max?: string
  offerid?: string
  progress?: string
  sc_bg_image?: string
  sc_bg_large_image?: string
  small_image?: string
  State?: string
  title?: string
  type?: string
  give_eligible: string
  activeLevel?: string
  benefits?: string
  hva_dailyset_completed_amount?: string
  hva_dailyset_days?: string
  hva_dailystreaks_bing_completed_amount?: string
  hva_dailystreaks_mobile_completed_amount?: string
  hva_dse_completed_amount?: string
  hva_dse_days?: string
  hva_gamepass_completed?: string
  hva_puzzle_pieces_completed_amount?: string
  is_new_levels_feature_available?: string
  level_up_actions_progress?: string
  levelMedallion?: string
  levelRequirements?: string
  levelTitleMobile?: string
  supportedLevelKeys?: string
  supportedLevelTitle?: string
  bing_search_daily_points?: string
  claimable_points_breakdown?: string
  hva_dailyset_completed_max?: string
  hva_dailyset_days_max?: string
  hva_dailyset_display?: string
  hva_dailyset_progress?: string
  hva_dailystreaks_bing_completed_max?: string
  hva_dailystreaks_bing_days?: string
  hva_dailystreaks_bing_days_max?: string
  hva_dailystreaks_bing_display?: string
  hva_dailystreaks_bing_progress?: string
  hva_dailystreaks_mobile_completed_max?: string
  hva_dailystreaks_mobile_days?: string
  hva_dailystreaks_mobile_days_max?: string
  hva_dailystreaks_mobile_display?: string
  hva_dailystreaks_mobile_progress?: string
  hva_dse_completed_max?: string
  hva_dse_days_max?: string
  hva_dse_display?: string
  hva_dse_progress?: string
  hva_gamepass_completed_amount?: string
  hva_gamepass_completed_max?: string
  hva_gamepass_display?: string
  hva_gamepass_progress?: string
  hva_seven_day_link?: string
  is_new_levels_feature_with_searchcap_lifted?: string
  last_month_level_estimate?: string
  level?: string
  level_keys?: string
  level_privilege_urls?: string
  level_privileges?: string
  level_task_urls?: string
  level_tasks?: string
  level_values?: string
  monthly_bonus_distribution_chart_src?: string
  passive_blocked?: string
  pointclaim_progress_dsebonus?: string
  pointclaim_progress_gooduserbonus?: string
  pointclaim_progress_levelbonus?: string
  points_per_pc_search?: string
  points_per_pc_search_new_levels?: string
  program_restructure_good_user_bonus_max?: string
  program_restructure_good_user_bonus_state?: string
  program_restructure_monthly_dse_bonus_max?: string
  program_restructure_monthly_dse_bonus_state?: string
  program_restructure_monthly_level_bonus_max?: string
  program_restructure_monthly_level_bonus_state?: string
  rebates_only?: string
  todays_points?: string
  wave2_hvas_flight?: string
  activity_progress?: string
  last_updated?: string
  break_image?: string
  lifetime_max?: string
  bonus_points?: string
  "cp--BCxES1#DisplayPosition"?: string
  "cp--BCxES1#RedDotNotification"?: string
  "cp--BCxES1#RedeemUrl"?: string
  "cp--BCxES1#RewardsUrl"?: string
  "cp--BSxES1#DefaultCardHeader"?: string
  "cp--CLOxES1#ChecklistCurrentEarnedPoints"?: string
  "cp--CLOxES1#ChecklistDescription"?: string
  "cp--CLOxES1#ChecklistRemainingSeconds"?: string
  "cp--CLOxES1#ChecklistTitle"?: string
  "cp--CLOxES1#ChecklistTotalPoints"?: string
  "cp--CLOxES1#ShouldShowChecklistCelebration"?: string
  "cp--EGxHVAxES1#DefaultCardHeader"?: string
  "cp--EGxxCHVAxES1#DefaultCardHeader"?: string
  "cp--EXBxES3#CompletionImageUrl"?: string
  "cp--GxES1#BonusPointsValue"?: string
  "cp--GxES1#CatalogItemImageUrlFormat"?: string
  "cp--GxES1#ChevronIconDarkModeUrl"?: string
  "cp--GxES1#ChevronIconRtlDarkModeUrl"?: string
  "cp--GxES1#ChevronIconRtlUrl"?: string
  "cp--GxES1#ChevronIconUrl"?: string
  "cp--GxES1#GoalProgressText"?: string
  "cp--GxES1#GoalTitle"?: string
  "cp--GxES1#RedeemGoalLongText"?: string
  "cp--GxES1#RedeemGoalText"?: string
  "cp--GxES1#RedeemGoalUrlFormat"?: string
  "cp--GxES1#SetGoalAnimatedImageUrl"?: string
  "cp--GxES1#SetGoalLongText"?: string
  "cp--GxES1#SetGoalText"?: string
  "cp--GxES1#SetGoalTitle"?: string
  "cp--GxES1#SetGoalUrl"?: string
  "cp--GxES1#ShouldOpenInNewTab"?: string
  "cp--GxES1#ShouldShowAnimation"?: string
  "cp--GxES1#SparklesAnimatedImageUrl"?: string
  "cp--HVAxES1#HvaRenderIndex"?: string
  "cp--HVAxES2#HvaRenderIndex"?: string
  "cp--THOxES1#AlertImpressions"?: string
  "cp--THOxES1#IconUrl"?: string
  "cp--THOxES1#IsShowStreak"?: string
  "cp--ULxES1#ULNCloseImpression"?: string
  "cp--ULxES1#ULNDisplayPosition"?: string
  "cp--ULxES1#UnsupportedLangNoteIcon"?: string
  "cp--ULxES1#UnsupportedLangNoteText"?: string
  layout_name?: string
  "lp#ImpressionPromotion"?: string
  "ls#body"?: string
  shouldOpenInNewTab?: string
  shouldReorderCompletedPromotions?: string
  shouldUseSlimStyleForCompletedPromotions?: string
  activity_max?: string
  bonus_earned?: string
  break_description?: string
  description_localizedkey?: string
  activityProgress?: string
  dsetCompletionTextKey?: string
  isActive?: string
  isLocalized?: string
  isNewDashFlight?: string
  partner_bing_cardPriority?: string
  partner_bing_claimingEnabled?: string
  partner_bing_claimingPending?: string
  partner_bing_completed?: string
  partner_bing_currentStep?: string
  partner_bing_destinationUrl?: string
  partner_bing_points?: string
  partner_bing_streakEnabled?: string
  partner_bing_title?: string
  partner_bing_titleArg0?: string
  partner_bing_titleArg1?: string
  partner_bing_totalSteps?: string
  partner_bing_url?: string
  partner_dset_cardPriority?: string
  partner_dset_completed?: string
  partner_dset_currentStep?: string
  partner_dset_destinationUrl?: string
  partner_dset_points?: string
  partner_dset_scrollToElement?: string
  partner_dset_streakEnabled?: string
  partner_dset_title?: string
  partner_dset_titleArg0?: string
  partner_dset_titleArg1?: string
  partner_dset_totalSteps?: string
  partner_dset_url?: string
  partner_edge_activationOffer?: string
  partner_edge_cardPriority?: string
  partner_edge_completed?: string
  partner_edge_currentStep?: string
  partner_edge_destinationUrl?: string
  partner_edge_hasToggle?: string
  partner_edge_hasTooltip?: string
  partner_edge_isEnabled?: string
  partner_edge_points?: string
  partner_edge_streakEnabled?: string
  partner_edge_title?: string
  partner_edge_titleArg0?: string
  partner_edge_titleArg1?: string
  partner_edge_toggleDescription?: string
  partner_edge_tooltipDescription?: string
  partner_edge_totalSteps?: string
  partner_edge_url?: string
  partner_ntp_cardPriority?: string
  partner_ntp_completed?: string
  partner_ntp_currentStep?: string
  partner_ntp_destinationUrl?: string
  partner_ntp_hasToggle?: string
  partner_ntp_hasTooltip?: string
  partner_ntp_points?: string
  partner_ntp_streakEnabled?: string
  partner_ntp_title?: string
  partner_ntp_titleArg0?: string
  partner_ntp_titleArg1?: string
  partner_ntp_toggleDescription?: string
  partner_ntp_tooltipDescription?: string
  partner_ntp_totalSteps?: string
  partner_ntp_url?: string
  partner_outlook_cardPriority?: string
  partner_outlook_completed?: string
  partner_outlook_currentStep?: string
  partner_outlook_destinationUrl?: string
  partner_outlook_hasToggle?: string
  partner_outlook_hasTooltip?: string
  partner_outlook_points?: string
  partner_outlook_streakEnabled?: string
  partner_outlook_title?: string
  partner_outlook_titleArg0?: string
  partner_outlook_titleArg1?: string
  partner_outlook_toggleDescription?: string
  partner_outlook_tooltipDescription?: string
  partner_outlook_totalSteps?: string
  partner_outlook_url?: string
  partner_sapphire_cardPriority?: string
  partner_sapphire_completed?: string
  partner_sapphire_currentStep?: string
  partner_sapphire_destinationUrl?: string
  partner_sapphire_points?: string
  partner_sapphire_streakEnabled?: string
  partner_sapphire_title?: string
  partner_sapphire_titleArg0?: string
  partner_sapphire_titleArg1?: string
  partner_sapphire_totalSteps?: string
  partner_sapphire_url?: string
  partner_visualsearch_activationOffer?: string
  partner_visualsearch_cardPriority?: string
  partner_visualsearch_completed?: string
  partner_visualsearch_currentStep?: string
  partner_visualsearch_destinationUrl?: string
  partner_visualsearch_isEnabled?: string
  partner_visualsearch_points?: string
  partner_visualsearch_streakEnabled?: string
  partner_visualsearch_title?: string
  partner_visualsearch_totalSteps?: string
  partner_visualsearch_url?: string
  point_max?: string
  progressIcon?: string
  reset_complete?: string
  streakCounter?: string
  title_side_txt?: string
  partner_edge_hash?: string
  partner_visualsearch_hash?: string
  dashboardImpressionPromo?: string
  machineTranslation?: string
  noteDisplayPosition?: string
  showNoteInDashboard?: string
  daily_set_date?: string
  description_comment?: string
  modern_image?: string
  query_comment?: string
  title_comment?: string
  translation_prompt?: string
  cardHeader?: string
  noEarningDescription?: string
  noEarningTitle?: string
  CardHeader?: string
  enable_hva_card?: string
  HVA_BG_static?: string
  HVA_BG_type?: string
  HVA_primary_asset?: string
  HVA_text_color?: string
  IsHvaV2Compatible?: string
  promotional?: string
  isStreakProtectionOnEligible?: string
  streakProtectionStatus?: string
  remainingDays?: string
  isFirstTime?: string
  streakCount?: string
  isTodayStreakComplete?: string
  autoTurnOn?: string
  bannerImpressionOffer?: string
  claimedPointsFrom1stLayer?: string
  claimedPointsFrom2ndLayer?: string
  dailyDirectDepositPoints?: string
  dailyEarningPointsCap?: string
  eduBannerEnabled?: string
  eventEndDate?: string
  eventStartDate?: string
  firstLayerDailySearchCount?: string
  firstLayerDailySearchUser?: string
  firstLayerRefereeCount?: string
  isBigBlueBtn?: string
  isNewString?: string
  isOneLayer?: string
  isRafStatusBanner?: string
  isTwoLayer?: string
  limitedTimeOfferBanner?: string
  maxSearchPoints?: string
  nudgingTopBanner?: string
  nudgingTopBannerImpressionPromotion?: string
  pendingPointsFrom1stLayer?: string
  pendingPointsFrom2ndLayer?: string
  rafBannerTreatment?: string
  refereeCouponFlight?: string
  SapphireRefereeCount?: string
  searchAwardCount?: string
  secondLayerDailySearchCount?: string
  secondLayerDailySearchUser?: string
  secondLayerRefereeCount?: string
  showRedDot?: string
  showTopBanner?: string
  showUnusualActivityBanner?: string
  totalClaimedPoints?: string
  totalClaimedPointsFromSapphire?: string
  totalDeclinedPoints?: string
  totalPendingPoints?: string
  layout_theme?: string
  "lp#section_footer-2X_header"?: string
  "lp#section_footer-3X_header"?: string
  "lp#section_footer-2X_header_key"?: string
  "lp#section_footer-3X_header_key"?: string
  "ls#header"?: string
  "ls#upperfixed"?: string
  "ls#footer-2X"?: string
  "ls#footer-3X"?: string
  "cp--F2xES1#Counter"?: string
  "cp--F2xES2#Counter"?: string
  "cp--F2xES1#Mode"?: string
  "cp--F2xES2#Mode"?: string
  "cp--F2xES3#Counter"?: string
  "cp--F2xES4#Counter"?: string
  "cp--F2xES5#Counter"?: string
  "cp--F2xES3#Mode"?: string
  "cp--F2xES4#Mode"?: string
  "cp--F2xES5#Mode"?: string
  "lp#AccordionIndex"?: string
  "lp#IsAccordionExpanded"?: string
  "lp#UseIndependentToggles"?: string
  user_level?: string
  is_unlocked?: string
  locked_category_criteria?: string
}

export interface CatalogItem {
  name: string
  provider: string
  price: number
  attributes: Attributes3
  displayOrder: number
  isWinnerItem: boolean
  isHidden: boolean
  isRoundupItem: boolean
}

export interface Attributes3 {
  category: string
  CategoryDescription: string
  "desc.group_text": string
  "desc.legal_text"?: string
  "desc.sc_description"?: string
  "desc.sc_title"?: string
  display_order: string
  ExtraLargeImage?: string
  group?: string
  group_image: string
  group_sc_image: string
  group_title: string
  hidden?: string
  large_image: string
  large_sc_image: string
  medium_image: string
  MobileImage: string
  original_price: string
  Remarks?: string
  ShortText?: string
  showcase?: string
  small_image: string
  title: string
  cimsid: string
  balanceManagementTransferPointsDestination?: string
  balanceManagementTransferPointsSource?: string
  points_destination?: string
  points_source?: string
  "desc.large_text"?: string
  disable_email?: string
  english_title?: string
  coupon_discount?: string
  variableItem_title?: string
  variableItemPointsToCurrencyConversionRatio?: string
  discounted_price?: string
  CauseId?: string
  CauseName?: string
  comingsoon_flag?: string
  etid?: string
  showcase_in_all?: string
  sku?: string
  disable_bot_redemptions?: string
  modern_image?: string
  "auto_donate.counterpart_id"?: string
  sustained_identifier?: string
  "auto_donate.cadence"?: string
  "auto_donate.item"?: string
  "auto_donate.legal"?: string
}

export interface CatalogGoal {
  name: string
  provider: string
  price: number
  attributes: Attributes4
  displayOrder: number
  isWinnerItem: boolean
  isHidden: boolean
  isRoundupItem: boolean
}

export interface Attributes4 {
  category: string
  CategoryDescription: string
  "desc.group_text": string
  "desc.legal_text": string
  "desc.sc_description": string
  "desc.sc_title": string
  display_order: string
  ExtraLargeImage: string
  group: string
  group_image: string
  group_sc_image: string
  group_title: string
  hidden: string
  large_image: string
  large_sc_image: string
  medium_image: string
  MobileImage: string
  original_price: string
  Remarks: string
  ShortText: string
  showcase: string
  small_image: string
  title: string
  cimsid: string
  user_defined_goal: string
}

export interface AutoRedeemProfile {
  country: string
  subscriptions: any[]
}

export interface FlyoutConfig {
  enabled: boolean
  layouts: string[]
  layoutConfig: LayoutConfig
  controls: string[]
  controlConfig: ControlConfig
  defaultLayoutByPartner: DefaultLayoutByPartner
  flyoutPartnerInfo: FlyoutPartnerInfo
  defaultCreative: string
  defaultLinkHandlingMode: number
  defaultFormCode: string
  defaultReturnUrl: string
  defaultPublisher: string
  defaultProgramName: string
  rewardsFDAuthSigninUrl: string
  newFlyoutEnrollUrlFormat: string
  fdAuthSourceForRewardsSignup: string
  rewardsFDAuthSigninUrlAbsolute: string
  newFlyoutEnrollUrlFormatAbsolute: string
  rewardsFDAuthLinkUrl: string
  rewardsFDAuthLinkUrlAbsolute: string
  enabledGoBigsoftRefreshFeatures: string[]
  mobileOnlyPartners: string[]
  flyoutSuggestedSeachesConfig: FlyoutSuggestedSeachesConfig
  autoOpenFlyoutCreative: string
}

export interface LayoutConfig {
  Acquisition: Acquisition
  Engagement: Engagement
  Onboarding: Onboarding
}

export interface Acquisition {
  name: string
  enabled: boolean
  sections: string[]
  properties: Properties
}

export interface Properties {}

export interface Engagement {
  name: string
  enabled: boolean
  sections: string[]
  properties: Properties2
}

export interface Properties2 {
  FetchDataAfterVisibilityChange: string
}

export interface Onboarding {
  name: string
  enabled: boolean
  sections: string[]
  properties: Properties3
}

export interface Properties3 {}

export interface ControlConfig {
  AcquisitionCard: AcquisitionCard
  AutoRedeemCard: AutoRedeemCard
  BalanceCard: BalanceCard
  BingTrialStreakWrapper: BingTrialStreakWrapper
  BrowseStreakCard: BrowseStreakCard
  ChecklistOffersCard: ChecklistOffersCard
  DailyCheckInCard: DailyCheckInCard
  EdgeAcquisitionCard: EdgeAcquisitionCard
  EdgeCoreHVACard: EdgeCoreHvacard
  EdgeHVACardList: EdgeHvacardList
  EdgeSurveyCard: EdgeSurveyCard
  EdgeUserProfileCard: EdgeUserProfileCard
  ExploreOnBingEngagementCard: ExploreOnBingEngagementCard
  FixedBalanceCard: FixedBalanceCard
  GoalCard: GoalCard
  HalfUnitCard: HalfUnitCard
  HighValueActionCard: HighValueActionCard
  NewLevelInfoCard: NewLevelInfoCard
  OnboardingPanel: OnboardingPanel
  OneTimeStreakWrapper: OneTimeStreakWrapper
  PointClaimCard: PointClaimCard
  SearchEarningCard: SearchEarningCard
  SearchStreakCard: SearchStreakCard
  ThreeOffersCard: ThreeOffersCard
  UnsupportedLangNoteCard: UnsupportedLangNoteCard
  UserProfileCard: UserProfileCard
  VersusCard: VersusCard
}

export interface AcquisitionCard {
  name: string
  enabled: boolean
  properties: Properties4
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties4 {}

export interface AutoRedeemCard {
  name: string
  enabled: boolean
  properties: Properties5
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties5 {}

export interface BalanceCard {
  name: string
  enabled: boolean
  properties: Properties6
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties6 {}

export interface BingTrialStreakWrapper {
  name: string
  enabled: boolean
  properties: Properties7
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties7 {}

export interface BrowseStreakCard {
  name: string
  enabled: boolean
  properties: Properties8
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties8 {}

export interface ChecklistOffersCard {
  name: string
  enabled: boolean
  properties: Properties9
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties9 {}

export interface DailyCheckInCard {
  name: string
  enabled: boolean
  properties: Properties10
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties10 {}

export interface EdgeAcquisitionCard {
  name: string
  enabled: boolean
  properties: Properties11
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties11 {}

export interface EdgeCoreHvacard {
  name: string
  enabled: boolean
  properties: Properties12
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties12 {}

export interface EdgeHvacardList {
  name: string
  enabled: boolean
  properties: Properties13
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties13 {}

export interface EdgeSurveyCard {
  name: string
  enabled: boolean
  properties: Properties14
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties14 {}

export interface EdgeUserProfileCard {
  name: string
  enabled: boolean
  properties: Properties15
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties15 {}

export interface ExploreOnBingEngagementCard {
  name: string
  enabled: boolean
  properties: Properties16
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties16 {
  CompletionImageUrl: string
}

export interface FixedBalanceCard {
  name: string
  enabled: boolean
  properties: Properties17
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties17 {}

export interface GoalCard {
  name: string
  enabled: boolean
  properties: Properties18
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties18 {}

export interface HalfUnitCard {
  name: string
  enabled: boolean
  properties: Properties19
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties19 {}

export interface HighValueActionCard {
  name: string
  enabled: boolean
  properties: Properties20
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties20 {
  HvaRenderIndex: string
}

export interface NewLevelInfoCard {
  name: string
  enabled: boolean
  properties: Properties21
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties21 {}

export interface OnboardingPanel {
  name: string
  enabled: boolean
  properties: Properties22
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties22 {}

export interface OneTimeStreakWrapper {
  name: string
  enabled: boolean
  properties: Properties23
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties23 {}

export interface PointClaimCard {
  name: string
  enabled: boolean
  properties: Properties24
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties24 {}

export interface SearchEarningCard {
  name: string
  enabled: boolean
  properties: Properties25
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties25 {}

export interface SearchStreakCard {
  name: string
  enabled: boolean
  properties: Properties26
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: EducationPageConfig
}

export interface Properties26 {}

export interface EducationPageConfig {
  panelHeaderTitleKey: string
  titleKey: string
  subtitleKey: string
  steps: Steps
}

export interface Steps {
  "0": N0
  "1": N1
}

export interface N0 {
  stepIndex: number
  stepHeadingKey: string
  stepTextKey: string
  stepImage: string
  stepImageAltTextKey: string
}

export interface N1 {
  stepIndex: number
  stepHeadingKey: string
  stepTextKey: string
  stepImage: string
  stepImageAltTextKey: string
}

export interface ThreeOffersCard {
  name: string
  enabled: boolean
  properties: Properties27
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties27 {
  IsShowStreak: string
  IconUrl: string
  MachineTranslationIcon: string
}

export interface UnsupportedLangNoteCard {
  name: string
  enabled: boolean
  properties: Properties28
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties28 {}

export interface UserProfileCard {
  name: string
  enabled: boolean
  properties: Properties29
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties29 {}

export interface VersusCard {
  name: string
  enabled: boolean
  properties: Properties30
  headerTextKey: string
  isCollapsible: boolean
  educationPageConfig: any
}

export interface Properties30 {}

export interface DefaultLayoutByPartner {
  BingRewards: BingRewards
  BingTravel: BingTravel
  DefaultLayoutPartner: DefaultLayoutPartner
  EdgeSidebar: EdgeSidebar
}

export interface BingRewards {
  signedInLayout: string
  signedOutLayout: string
  signedInControls: SignedInControls
  signedOutControls: SignedOutControls
}

export interface SignedInControls {
  body: string
}

export interface SignedOutControls {
  body: string
}

export interface BingTravel {
  signedInLayout: string
  signedOutLayout: string
  signedInControls: SignedInControls2
  signedOutControls: SignedOutControls2
}

export interface SignedInControls2 {
  body: string
}

export interface SignedOutControls2 {
  body: string
}

export interface DefaultLayoutPartner {
  signedInLayout: string
  signedOutLayout: string
  signedInControls: SignedInControls3
  signedOutControls: SignedOutControls3
}

export interface SignedInControls3 {
  body: string
}

export interface SignedOutControls3 {
  body: string
}

export interface EdgeSidebar {
  signedInLayout: string
  signedOutLayout: string
  signedInControls: SignedInControls4
  signedOutControls: SignedOutControls4
}

export interface SignedInControls4 {
  body: string
}

export interface SignedOutControls4 {
  body: string
}

export interface FlyoutPartnerInfo {
  OutlookMini: OutlookMini
}

export interface OutlookMini {
  partnerDetails: PartnerDetails
  flyoutParameterInfo: FlyoutParameterInfo
}

export interface PartnerDetails {
  linkHandlingMode: string
  creative: string
  formCode: string
  returnUrl: string
  publisher: string
  programName: string
}

export interface FlyoutParameterInfo {}

export interface FlyoutSuggestedSeachesConfig {
  defaultFlyoutTSFormCode: string
}

export interface FlyoutResult {
  userStatus: UserStatus
  userGoal: any
  userAutoRedeemItem: any
  userAutoRedeemType: any
  userOrders: any[]
  isAutoRedeemEligible: boolean
  highValueActionPromotions: HighValueActionPromotion[]
  edgeHighValueActionPromotions: any[]
  browseStreakPromotions: any[]
  edgeAcquisitionPromotion: any
  dailySetPromotions: { [key: string]: PromotionalItem[] }
  streakPromotion: StreakPromotion
  acquisitionPromotion: any
  onboardingPromotion: any
  searchAndEarnPromotion: SearchAndEarnPromotion
  streakBonusPromotions: StreakBonusPromotion[]
  exploreOnBingPromotions: any[]
  impressionPromotions: ImpressionPromotion[]
  searchStreakPromotion: any
  dailyCheckInPromotion: DailyCheckInPromotion
  bingTrialStreakPromotion: any
  oneTimeStreakPromotion: any
  morePromotions: MorePromotion[]
  machineTranslationPromo: MachineTranslationPromo
  streakProtectionPromo: StreakProtectionPromo
  autoRedeemPromotion: any
  onboardingChecklistPromotions: any[]
  goalCardPromotion: any
  onboardingChecklistBonusPromotion: any
  l2Context: any
  layout: Layout
  traceId: string
  joinUrl: string
  rebatesJoinUrl: any
  profile: Profile2
  flyoutCatalogItem: any
  exploreOnBingAnyCardCompletionPromotion: any
  isExploreOnBingChecklistCardActivated: boolean
  shouldUseSlimStyleForCompletedPromotions: boolean
  shouldOpenInNewTab: any
  pointClaimCardPromotion: any
  suggestedSearches: SuggestedSearches
  featureNames: string
  isLiftSearchCapAutoClaimEnabled: number
  isLiftSearchCapAutoClaimSuccessful: boolean
  levelInfoPromotion: LevelInfoPromotion
  levelBenefitsPromotion: LevelBenefitsPromotion
}

export interface UserStatus {
  availablePoints: number
  lifetimePoints: number
  lifetimeGivingPoints: number
  lifetimePointsRedeemed: number
  counters: Counters2
  rebateProfile: any
  oldBalance: number
  totalBalance: number
  goalBalance: number
  balanceUpdated: boolean
  isRewardsUser: boolean
}

export interface Counters2 {
  ActivityAndQuiz: ActivityAndQuiz[]
  DailyPoint: DailyPoint[]
}

export interface ActivityAndQuiz {
  name: any
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: any
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface DailyPoint {
  name: any
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: any
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface HighValueActionPromotion {
  primaryAsset: string
  bgType: string
  cardHeader: string
  bgStatic: string
  bgAnimated: string
  textColor: string
  termsText: string
  termsLink: string
  isHvaV2Compatible: boolean
  customImageEnabled: boolean
  max: number
  currentProgress: number
  levelMax: number
  name: string
  priority: number
  isRewardable: boolean
  activityType: string
  hash: string
  attributes: Attributes5
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes5 {
  CardHeader: string
  description: string
  destination: string
  enable_hva_card: string
  HVA_BG_static: string
  HVA_BG_type: string
  HVA_primary_asset: string
  HVA_text_color: string
  IsHvaV2Compatible: string
  machineTranslation: string
  max: string
  promotional: string
  State: string
  title: string
  type: string
  give_eligible: string
  progress: string
  complete: string
  offerid: string
}

export interface PromotionalItem {
  name: string
  priority: number
  isRewardable: boolean
  activityType: string
  hash: string
  attributes: Attributes6
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes6 {
  animated_icon: string
  bg_image: string
  complete: string
  daily_set_date: string
  description: string
  description_comment: string
  destination: string
  icon: string
  image: string
  link_text: string
  max: string
  modern_image: string
  offerid: string
  progress: string
  query_comment?: string
  sc_bg_image: string
  sc_bg_large_image: string
  small_image: string
  State: string
  title: string
  title_comment: string
  translation_prompt: string
  type: string
  give_eligible: string
}

export interface N01252026 {
  name: string
  priority: number
  isRewardable: boolean
  activityType: string
  hash: string
  attributes: Attributes7
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes7 {
  animated_icon: string
  bg_image: string
  complete: string
  daily_set_date: string
  description: string
  description_comment: string
  destination: string
  icon: string
  image: string
  link_text: string
  max: string
  modern_image: string
  offerid: string
  progress: string
  query_comment?: string
  sc_bg_image: string
  sc_bg_large_image: string
  small_image: string
  State: string
  title: string
  title_comment: string
  translation_prompt: string
  type: string
  give_eligible: string
}

export interface StreakPromotion {
  lastUpdatedDate: string
  breakImageUrl: string
  lifetimeMaxValue: number
  bonusPointsEarned: number
  name: string
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: Attributes8
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes8 {
  hidden: string
  type: string
  title: string
  image: string
  activity_progress: string
  last_updated: string
  break_image: string
  lifetime_max: string
  bonus_points: string
  give_eligible: string
}

export interface SearchAndEarnPromotion {
  name: string
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: Attributes9
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes9 {
  animated_icon: string
  cardHeader: string
  description: string
  destination: string
  hidden: string
  noEarningDescription: string
  noEarningTitle: string
  offerid: string
  State: string
  title: string
  type: string
  give_eligible: string
}

export interface StreakBonusPromotion {
  name: string
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: Attributes10
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes10 {
  activity_max: string
  activity_progress: string
  animated_icon: string
  bonus_earned?: string
  break_description?: string
  description: string
  description_localizedkey: string
  hidden: string
  image: string
  title: string
  type: string
  give_eligible: string
}

export interface ImpressionPromotion {
  name: string
  priority: number
  isRewardable: boolean
  activityType: string
  hash: string
  attributes: Attributes11
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes11 {
  hidden: string
  type: string
  offerid: string
  activity_progress: string
  give_eligible: string
  progress: string
  max: string
  complete: string
  description?: string
  destination?: string
  link_text?: string
  title?: string
}

export interface DailyCheckInPromotion {
  name: string
  priority: number
  isRewardable: boolean
  activityType: string
  hash: any
  attributes: Attributes12
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes12 {
  activity_max: string
  activityProgress: string
  description: string
  destination: string
  dsetCompletionTextKey: string
  isActive: string
  isLocalized: string
  isNewDashFlight: string
  partner_bing_cardPriority: string
  partner_bing_claimingEnabled: string
  partner_bing_claimingPending: string
  partner_bing_completed: string
  partner_bing_currentStep: string
  partner_bing_destinationUrl: string
  partner_bing_points: string
  partner_bing_streakEnabled: string
  partner_bing_title: string
  partner_bing_titleArg0: string
  partner_bing_titleArg1: string
  partner_bing_totalSteps: string
  partner_bing_url: string
  partner_dset_cardPriority: string
  partner_dset_completed: string
  partner_dset_currentStep: string
  partner_dset_destinationUrl: string
  partner_dset_points: string
  partner_dset_scrollToElement: string
  partner_dset_streakEnabled: string
  partner_dset_title: string
  partner_dset_titleArg0: string
  partner_dset_titleArg1: string
  partner_dset_totalSteps: string
  partner_dset_url: string
  partner_edge_activationOffer: string
  partner_edge_cardPriority: string
  partner_edge_completed: string
  partner_edge_currentStep: string
  partner_edge_destinationUrl: string
  partner_edge_hasToggle: string
  partner_edge_hasTooltip: string
  partner_edge_isEnabled: string
  partner_edge_points: string
  partner_edge_streakEnabled: string
  partner_edge_title: string
  partner_edge_titleArg0: string
  partner_edge_titleArg1: string
  partner_edge_toggleDescription: string
  partner_edge_tooltipDescription: string
  partner_edge_totalSteps: string
  partner_edge_url: string
  partner_ntp_cardPriority: string
  partner_ntp_completed: string
  partner_ntp_currentStep: string
  partner_ntp_destinationUrl: string
  partner_ntp_hasToggle: string
  partner_ntp_hasTooltip: string
  partner_ntp_points: string
  partner_ntp_streakEnabled: string
  partner_ntp_title: string
  partner_ntp_titleArg0: string
  partner_ntp_titleArg1: string
  partner_ntp_toggleDescription: string
  partner_ntp_tooltipDescription: string
  partner_ntp_totalSteps: string
  partner_ntp_url: string
  partner_outlook_cardPriority: string
  partner_outlook_completed: string
  partner_outlook_currentStep: string
  partner_outlook_destinationUrl: string
  partner_outlook_hasToggle: string
  partner_outlook_hasTooltip: string
  partner_outlook_points: string
  partner_outlook_streakEnabled: string
  partner_outlook_title: string
  partner_outlook_titleArg0: string
  partner_outlook_titleArg1: string
  partner_outlook_toggleDescription: string
  partner_outlook_tooltipDescription: string
  partner_outlook_totalSteps: string
  partner_outlook_url: string
  partner_sapphire_cardPriority: string
  partner_sapphire_completed: string
  partner_sapphire_currentStep: string
  partner_sapphire_destinationUrl: string
  partner_sapphire_points: string
  partner_sapphire_streakEnabled: string
  partner_sapphire_title: string
  partner_sapphire_titleArg0: string
  partner_sapphire_titleArg1: string
  partner_sapphire_totalSteps: string
  partner_sapphire_url: string
  partner_visualsearch_activationOffer: string
  partner_visualsearch_cardPriority: string
  partner_visualsearch_completed: string
  partner_visualsearch_currentStep: string
  partner_visualsearch_destinationUrl: string
  partner_visualsearch_isEnabled: string
  partner_visualsearch_points: string
  partner_visualsearch_streakEnabled: string
  partner_visualsearch_title: string
  partner_visualsearch_totalSteps: string
  partner_visualsearch_url: string
  point_max: string
  progressIcon: string
  reset_complete: string
  streakCounter: string
  title: string
  title_side_txt: string
  type: string
  give_eligible: string
  progress: string
  max: string
  complete: string
  offerid: string
  partner_edge_hash: string
  partner_visualsearch_hash: string
}

export interface MorePromotion {
  name: string
  priority: number
  isRewardable: boolean
  activityType: string
  hash: string
  attributes: Attributes13
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes13 {
  animated_icon: string
  bg_image: string
  complete: string
  description: string
  destination: string
  icon: string
  image: string
  link_text: string
  max: string
  offerid: string
  progress: string
  sc_bg_image: string
  sc_bg_large_image: string
  small_image: string
  State: string
  title: string
  type: string
  give_eligible: string
  user_level?: string
  is_unlocked?: string
  locked_category_criteria?: string
  promotional?: string
}

export interface MachineTranslationPromo {
  name: string
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: Attributes14
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes14 {
  dashboardImpressionPromo: string
  hidden: string
  machineTranslation: string
  noteDisplayPosition: string
  showNoteInDashboard: string
  type: string
  give_eligible: string
}

export interface StreakProtectionPromo {
  name: string
  priority: number
  isRewardable: boolean
  activityType: string
  hash: string
  attributes: Attributes15
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes15 {
  hidden: string
  type: string
  offerid: string
  isStreakProtectionOnEligible: string
  streakProtectionStatus: string
  remainingDays: string
  isFirstTime: string
  streakCount: string
  isTodayStreakComplete: string
  autoTurnOn: string
  give_eligible: string
}

export interface Layout {
  layoutName: string
  customProperties: CustomProperties
  controls: Controls
}

export interface CustomProperties {
  FetchDataAfterVisibilityChange: string
  ImpressionPromotion: string
}

export interface Controls {
  body: Body[]
}

export interface Body {
  name: string
  customProperties: CustomProperties2
}

export interface CustomProperties2 {
  DisplayPosition?: string
  RedDotNotification?: string
  RedeemUrl?: string
  RewardsUrl?: string
  BonusPointsValue?: string
  CatalogItemImageUrlFormat?: string
  ChevronIconDarkModeUrl?: string
  ChevronIconRtlDarkModeUrl?: string
  ChevronIconRtlUrl?: string
  ChevronIconUrl?: string
  GoalProgressText?: string
  GoalTitle?: string
  RedeemGoalLongText?: string
  RedeemGoalText?: string
  RedeemGoalUrlFormat?: string
  SetGoalAnimatedImageUrl?: string
  SetGoalLongText?: string
  SetGoalText?: string
  SetGoalTitle?: string
  SetGoalUrl?: string
  ShouldOpenInNewTab?: string
  ShouldShowAnimation?: string
  SparklesAnimatedImageUrl?: string
  HvaRenderIndex?: string
  AlertImpressions?: string
  IconUrl?: string
  IsShowStreak?: string
  MachineTranslationIcon?: string
  CompletionImageUrl?: string
}

export interface Profile2 {
  defaultAddress: any
  birthDate: any
  displayName: string
  firstName: any
  lastName: any
  email: any
  phoneNumber: string
  profilePicture: string
  hasValidEmail: boolean
  birthdate: any
  userIdType: string
}

export interface SuggestedSearches {
  suggestedItems: SuggestedItem[]
}

export interface SuggestedItem {
  query: string
  url: string
}

export interface LevelInfoPromotion {
  name: string
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: Attributes16
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface Attributes16 {
  bing_search_daily_points: string
  claimable_points_breakdown: string
  hidden: string
  hva_dailyset_completed_amount: string
  hva_dailyset_completed_max: string
  hva_dailyset_days: string
  hva_dailyset_days_max: string
  hva_dailyset_display: string
  hva_dailyset_progress: string
  hva_dailystreaks_bing_completed_amount: string
  hva_dailystreaks_bing_completed_max: string
  hva_dailystreaks_bing_days: string
  hva_dailystreaks_bing_days_max: string
  hva_dailystreaks_bing_display: string
  hva_dailystreaks_bing_progress: string
  hva_dailystreaks_mobile_completed_amount: string
  hva_dailystreaks_mobile_completed_max: string
  hva_dailystreaks_mobile_days: string
  hva_dailystreaks_mobile_days_max: string
  hva_dailystreaks_mobile_display: string
  hva_dailystreaks_mobile_progress: string
  hva_dse_completed_amount: string
  hva_dse_completed_max: string
  hva_dse_days: string
  hva_dse_days_max: string
  hva_dse_display: string
  hva_dse_progress: string
  hva_gamepass_completed: string
  hva_gamepass_completed_amount: string
  hva_gamepass_completed_max: string
  hva_gamepass_display: string
  hva_gamepass_progress: string
  hva_puzzle_pieces_completed_amount: string
  hva_seven_day_link: string
  is_new_levels_feature_available: string
  is_new_levels_feature_with_searchcap_lifted: string
  last_month_level_estimate: string
  level: string
  level_keys: string
  level_privilege_urls: string
  level_privileges: string
  level_task_urls: string
  level_tasks: string
  level_up_actions_progress: string
  level_values: string
  max: string
  monthly_bonus_distribution_chart_src: string
  passive_blocked: string
  pointclaim_progress_dsebonus: string
  pointclaim_progress_gooduserbonus: string
  pointclaim_progress_levelbonus: string
  points_per_pc_search: string
  points_per_pc_search_new_levels: string
  program_restructure_good_user_bonus_max: string
  program_restructure_good_user_bonus_state: string
  program_restructure_monthly_dse_bonus_max: string
  program_restructure_monthly_dse_bonus_state: string
  program_restructure_monthly_level_bonus_max: string
  program_restructure_monthly_level_bonus_state: string
  progress: string
  rebates_only: string
  todays_points: string
  wave2_hvas_flight: string
  give_eligible: string
}

export interface LevelBenefitsPromotion {
  levelRequirements: LevelRequirements
  supportedLevelKeys: string[]
  supportedLevelTitles: string[]
  supportedLevelMedallion: string[]
  activeLevel: string
  name: string
  priority: number
  isRewardable: boolean
  activityType: any
  hash: any
  attributes: Attributes17
  offerId: string
  complete: boolean
  activityProgress: number
  activityProgressMax: number
  pointProgressMax: number
  pointProgress: number
  promotionType: string
  promotionSubtype: string
  title: string
  description: string
  descriptionParam: string
  showcaseTitle: string
  showcaseDescription: string
  imageUrl: string
  smallImageUrl: string
  backgroundImageUrl: string
  showcaseBackgroundImageUrl: string
  showcaseBackgroundLargeImageUrl: string
  iconUrl: string
  animatedIconUrl: string
  animatedLargeBackgroundImageUrl: string
  destinationUrl: string
  linkText: string
  isRecurring: boolean
  isHidden: boolean
  level: string
  slidesCount: number
  legalText: string
  legalLinkText: string
  machineTranslation: string
  showUnsupportedLangNote: string
  target: string
  rewardable: boolean
  exclusiveLockedFeatureCategory: string
  exclusiveLockedFeatureStatus: string
  exclusiveLockedFeatureDestinationUrl: string
  lockedImage: string
  shouldScrollToTarget: boolean
  inProgress: string
  sectionalOrdering: number
  isAnimatedRewardEnabled: boolean
}

export interface LevelRequirements {
  newLevel2: NewLevel2
  newLevel3: NewLevel3
}

export interface NewLevel2 {
  pointsRequired: number
  completeActivities: any
}

export interface NewLevel3 {
  pointsRequired: number
  completeActivities: number
}

export interface Attributes17 {
  activeLevel: string
  benefits: string
  hidden: string
  hva_dailyset_completed_amount: string
  hva_dailyset_days: string
  hva_dailystreaks_bing_completed_amount: string
  hva_dailystreaks_mobile_completed_amount: string
  hva_dse_completed_amount: string
  hva_dse_days: string
  hva_gamepass_completed: string
  hva_puzzle_pieces_completed_amount: string
  is_new_levels_feature_available: string
  level_up_actions_progress: string
  levelMedallion: string
  levelRequirements: string
  levelTitleMobile: string
  supportedLevelKeys: string
  supportedLevelTitle: string
  give_eligible: string
}

export interface LoggingContext {
  impressionId: string
  sessionId: string
  anaheimId: any
  loggingKey: string
}

export interface PartnerInfo {
  linkHandlingMode: number
  creative: string
  formCode: string
  signupReturnUrl: string
  publisher: string
  programName: string
}

export interface LocalizedStrings {
  AutoRedeem_unavailable_text: string
  WW_Hva_RAF_Share_And_Win_Redirection_CTA: string
  Onboarding_Checklist_Redemption_Title: string
  Complete_Text: string
  CI_ShortTitle: string
  Redeem_Back_To_Rewards: string
  HVA_StreakProtectionOff_Description: string
  OneTimeStreak_Swiftkey_DSE_Title_Completed: string
  UNCONSCIOUS_CONGRATZ_HVA_TITLE_500_POINTS: string
  Onboarding_Checklist_BingEdgeSearch_Description: string
  OneTimeStreak_Swiftkey_ExpiryText: string
  mobileonly_locked_tooltip_message: string
  AC_Redeem_Text: string
  SearchStreakCold: string
  Expand_Text: string
  DailyStreaks_exp2_lvl2_mobile_us: string
  Sync_Description: string
  DailyCheckIn_ClaimingPending_TooltipLinkText: string
  ExploreOnBing_Spotlight_button_Key: string
  WW_Hva_RAF_Search_And_Earn_Redirection_description: string
  OnboardingSelectGiftCard_Description: string
  DailyCheckIn_Title_OnGoing: string
  OneTimeStreak_BIC_ButtonText: string
  OneTimeStreak_Swiftkey_DSE_Title_Ongoing: string
  UNCONSCIOUS_CONGRATZ_HVA_TEXT_500_POINTS: string
  level2_locked_tooltip_link_cta: string
  DailyCheckIn_Edge_tooltipDescription_Activated: string
  OnboardingSelectGiftCard_Subtitle: string
  OneTimeStreak_BIC_Description_BeforeActivation1: string
  StreakProtectionToggleOn: string
  Sync_Title: string
  UserProfile_DefaultName: string
  SI_Description: string
  EdgeHva_ViewYourRewards: string
  StreakProtectionHeader: string
  Claimable_Points_hva_V1_Title: string
  AutoRedeem_name: string
  BD_Title: string
  LI_Description: string
  NewOffer: string
  OneTimeStreak_Bilibili_ExpiryText: string
  ExploreOnBing_ORCA_Realestate_Promotion_Title: string
  OneTimeStreak_BIC_Wrapper_Title: string
  reactivationButtonText_key: string
  OneTimeStreak_BIC_Title_BeforeActivation1: string
  Edge_BStreak_ViewMore_Text: string
  dayOfWeek_Thursday_locked_required_text: string
  partnerEdge_key: string
  Privacy_Text: string
  L2_Close: string
  Edge_BStreak_Popup_Description: string
  NoThanksButton_Label: string
  autopen_exp1_title: string
  HVA_RedemptionCoupon_Title: string
  HVA_retain_to_work_t3_202503_Description: string
  Redeem_Terms_And_Policies: string
  DailyStreaks_exp2_lvl1_desktop_us: string
  Edge_BStreak_Popup_Header: string
  EdgeAcquisition_SignIn_Title: string
  DailyStreaks_exp1_lvl1_desktop_nous: string
  Redeem_ButtonText: string
  DailyCheckIn_Title_Completed: string
  HVA_StreakProtectionAutoTurnOn_Description: string
  SearchStreak_Cold_AltText: string
  level2_unlocked_tooltip_message: string
  DailyCheckIn_Title_Progress: string
  OnboardingShowSelection_Description: string
  newLevel3_locked_required_text_prefix: string
  Redeem_Continue_Button_Text: string
  RewardsPoints: string
  Edge_User_Profile_Card_Text: string
  newLevel3_locked_required_text_suffix: string
  level2_locked_required_text_prefix: string
  DailyCheckIn_Title_Start: string
  DailyCheckIn_Description_Completed: string
  DailyStreaks_exp1_lvl1_desktop_us: string
  HVA_retain_to_work_all_202503_Complete_Title: string
  ExploreOnBing_ORCA_Health_Promotion_Cta: string
  OneTimeStreak_BIC_Description_RewardEligible: string
  ExploreOnBing_Spotlight_Title_Key: string
  OneTimeStreak_Swiftkey_StreakTitle: string
  AutoRedeem_redeeming_on_date: string
  Checklist_Description: string
  OnboardingSelectGiftCard_ButtonText: string
  Edge_BStreak_SignIn_Cta_Text: string
  Edge_AC_Survey_Description: string
  Redeem_Goal_Text: string
  HVA_TodayInHistory_Card_Title: string
  Points_Description: string
  MR_Title: string
  AutoRedeem_unsubscribed_text: string
  level2_locked_required_text_suffix: string
  WW_Hva_mobile_search_QRCode_Level2_Jan25: string
  OnboardingShowSelection_Description1: string
  OneTimeStreak_Bilibili_StreakTitle: string
  Onboarding_Checklist_EarnFaster_Description: string
  Edge_BStreak_Popup_Close_Text: string
  DailyCheckIn_Sapphire_Title: string
  Daily_Search_Counter: string
  OneTimeStreak_Swiftkey_DSE_Title_RewardEligible: string
  Checklist_Celebration_Header: string
  brokenStreakBannerText_key: string
  ExploreOnBing_ORCA_Hotel_Promotion_Cta: string
  Claimable_Points_hva_V2_Title: string
  OnboardingSelectGiftCard_Title: string
  ExploreOnBing_in_progress_tooltips_Key: string
  Goal_Progress_Text: string
  LI_CompletedDescription: string
  Set_Goal_Title_Variant: string
  HVA_StreakProtectionOff_Title: string
  OneTimeStreak_BIC_Description_Ongoing1: string
  OneTimeStreak_Swiftkey_DSE_Description_BeforeActivation: string
  OneTimeStreak_Swiftkey_DSE_Description_RewardEligible: string
  Day_Count_Plural: string
  REFRESHING_TO_LEVEL: string
  Daily_Search_Text: string
  Onboarding_Checklist_EarnFaster_Title: string
  autopen_exp2_body_us: string
  DailyCheckIn_Text_ShowLess: string
  ExploreOnBing_ORCA_Realestate_Promotion_Desc: string
  OnboardingSelectGiftCard_Footnote: string
  SE_Earning_Desc_Default: string
  WW_HVA_Search_Cooldown_Tooltip_202503_Title: string
  Edge_BStreak_Popup_Switch_Cta: string
  OneTimeStreak_Bilibili_Description_RewardEligible: string
  MR_ShortTitle: string
  HVA_retain_to_work_t1_202503_Title: string
  Welcome_Text: string
  String: string
  SearchStreakHot: string
  AutoRedeem_points_to_go: string
  Prizes: string
  Point_Count_Text: string
  DailyCheckIn_DailySet_DailyCompletion: string
  headerTextWelcomeNewUser_key: string
  HVA_StreakProtectionOn_2DayLeftTitle: string
  ineligibleText_key: string
  OneTimeStreak_Swiftkey_DSE_Title_BeforeActivation: string
  MyPoints_Key: string
  EdgeHva_TaskNotStarted: string
  DailyCheckIn_Outlook_toggleDescription: string
  Refresh_Button_Alt: string
  Onboarding_Checklist_Divider_Text: string
  Edge_Microsoft_Edge_Text: string
  OneTimeStreak_BIC_Description_Ongoing: string
  Redeem_Order_Status: string
  OnboardingSelectGiftCard_DescriptionVariant: string
  DailyCheckIn_DailySet_WeeklyCompletion: string
  HVA_retain_to_work_all_202503_Complete_Description: string
  BD_ShortTitle: string
  HVA_TodayInHistory_Card_Description: string
  MR_Description: string
  DailyStreaks_exp1_lvl2_desktop_nous: string
  CoreHVAL2GoBackBtnText: string
  OneTimeStreak_BIC_Description_Completed1: string
  Checklist_Title: string
  HVA_RedemptionCoupon_Description: string
  OneTimeStreak_BIC_Title_BeforeActivation: string
  EdgeHva_TaskComplete: string
  DailyCheckIn_Edge_Inactive_Subtitle: string
  Step_Complete_Status_Text: string
  OneTimeStreak_BIC_Description_Completed: string
  OneTimeStreak_Bilibili_Description_Ongoing: string
  OneTimeStreak_Swiftkey_DSE_Wrapper_Title: string
  OnboardingShowSelection_ButtonText: string
  SE_Earning_Desc_Uptiering: string
  headerTextbrokenStreak_key: string
  EdgeCoreHVA_Description: string
  SE_No_Earning_Title_Default: string
  OneTimeStreak_Swiftkey_Description_Completed: string
  HVA_retain_to_work_t1_202503_Description: string
  CI_Title: string
  Search_And_Earn_Text: string
  HVA_StreakProtectionOn_Title: string
  Redeem_Congratulations: string
  BD_CompletedDescription: string
  DailyStreaks_exp1_lvl2_desktop_us: string
  EdgeHva_L2_ComeBack: string
  BD_Description: string
  dayOfWeek_Monday_locked_required_text: string
  SaerchStreak_Header_Text: string
  MR_PrivacyLink_Text: string
  dayOfWeek_Wednesday_locked_required_text: string
  OneTimeStreak_Bilibili_Title_BeforeActivation: string
  DailyStreaks_exp2_lvl2_desktop_nous: string
  Incomplete_Text: string
  OneTimeStreak_Swiftkey_DSE_ExpiryText: string
  EdgeAcquisition_SignIn_Cta: string
  SI_ButtonText: string
  DailyCheckIn_Description_OnGoing: string
  OneTimeStreak_Bilibili_Title_Completed: string
  WW_Hva_mobile_search_QRCode_Level1_Jan25_description: string
  OnboardingSelectGiftCard_PointsToRedeem_Text: string
  HVA_StreakProtectionOn_2DayLeftDescription: string
  PointsCount: string
  OneTimeStreak_Bilibili_Title_RewardEligible: string
  Redeem_Checkout_Btn_Text: string
  PointsAdded: string
  HVA_RedemptionCoupon_Header: string
  Onboarding_Checklist_MoreActivities_Title: string
  Onboarding_Checklist_ExploreOnBing_Title: string
  OneTimeStreak_Swiftkey_Wrapper_Title: string
  EdgeCoreHVA_Title: string
  DailyCheckIn_NTP_Title: string
  WW_exclusivesearchandearn_global_level1_mobile_description: string
  Edge_AC_Survey_Footer: string
  descriptionTextCompletion_key: string
  EdgeAcquisition_Footer: string
  PrivacyLink_Text: string
  DashboardLink_Text: string
  OneTimeStreak_Swiftkey_Title_Completed: string
  EdgeHva_Popup_Cta_Text: string
  referAndEarnSubtitle: string
  completionHeaderText_key: string
  DailyCheckIn_Edge_tooltipDescription_Deactivated: string
  OneTimeStreak_Swiftkey_Description_BeforeActivation: string
  ExploreOnBing_ORCA_Health_Promotion_Title: string
  DailyCheckIn_Bing_Title: string
  Onboarding_Checklist_Redemption_Description: string
  OneTimeStreak_Swiftkey_ButtonText: string
  Edge_ProfileCard_AdditionalText: string
  Edge_BStreak_JoinRewards_Cta_Text: string
  MachineTranlationHint: string
  HVA_Amazon_Sweepstakes_Holiday_Push_Title: string
  WW_HVA_Search_Cooldown_Tooltip_202503_Description: string
  SearchStreak_L2Title: string
  CI_ButtonText: string
  WW_exclusivesearchandearn_global_level1_mobile_title: string
  Redeem_Points_Text: string
  Edge_AC_Survey_Cancel: string
  OnboardingShowSelection_Subtitle: string
  Edge_AC_Survey_Privacy_Statement: string
  OnboardingShowSelection_Subtitle1: string
  SI_ShortTitle: string
  DailyStreaks_WillBeBackSoon: string
  Claimable_Points_hva_V2_Description: string
  SearchStreak_Warm_AltText: string
  CI_CompletedDescription: string
  OneTimeStreak_BIC_Title_Ongoing: string
  Redeem_Goal_LongText: string
  ThreeOfferCardHeader: string
  AboutPageLink_Text: string
  Claimable_Points_hva_V1_Description: string
  WW_HVA_Form_Cooldown_Tooltip_202503_Title: string
  newLevel3_unlocked_tooltip_message: string
  MachineTransIconAltText: string
  Checklist_Celebration_Title: string
  OnboardingSelectGiftCard_Alert_TextVariant: string
  AutoRedeem_unsubscribed_title: string
  Day_Count: string
  Expanded_Text: string
  Redeem_Back: string
  Redeem_Home: string
  ExploreOnBing_Spotlight_Completion_Key: string
  MR_FooterText: string
  headerTextWarning_key: string
  Edge_Default_Welcome_Text: string
  OneTimeStreak_Bilibili_Wrapper_Title: string
  LI_SettingsLink_Text: string
  OnboardingSelectGiftCard_ZeroPoint_Subtitle: string
  warningBannerText_key: string
  OneTimeStreak_Swiftkey_Title_RewardEligible: string
  Edge_BStreak_JoinRewards_Footer_Text: string
  OneTimeStreak_BIC_ButtonText1: string
  dayOfWeek_unlocked_tooltip_message: string
  Redeem_Order_Details_Will_Be_Sent_To: string
  StreakprotectionTooltipDesp3: string
  StreakprotectionTooltipDesp2: string
  StreakprotectionTooltipDesp1: string
  StreakprotectionTooltipDesp5: string
  StreakprotectionTooltipDesp4: string
  AAD_Flyout_Title: string
  EdgeHva_TaskInProgress: string
  Onboarding_Checklist_SetGoal_Title: string
  newLevel2_unlocked_tooltip_message: string
  CI_Description: string
  DailyCheckIn_Edge_Title: string
  Trending_Searches_Text: string
  partnerBing_key: string
  OnboardingSelectGiftCard_Select_Text: string
  Edge_AC_Survey_Option_Other_Placeholder: string
  UNCONSCIOUS_CONGRATZ_HVA_TITLE_250_POINTS: string
  OnboardingShowSelection_ChangeGoalOption_Text: string
  Set_Goal_LongText: string
  Locked_Img_Alt: string
  AutoRedeem_subscribed_item_image_alt_text: string
  UNCONSCIOUS_CONGRATZ_HVA_TEXT_250_POINTS: string
  VersusHeader: string
  HVACardDefaultHeader: string
  UNCONSCIOUS_CONGRATZ_HVA_CTA: string
  Onboarding_Checklist_ExploreOnBing_Description: string
  WW_Hva_RAF_Search_And_Earn_Redirection_title: string
  Collapsed_Text: string
  Edge_AC_Survey_Submit: string
  PanelHeader_Title: string
  autopen_exp1_body_nous: string
  EdgeHva_Header_Text: string
  Set_Goal_Text_Variant: string
  autopen_exp1_body_us: string
  L2BackButton_Label: string
  SI_FooterText: string
  autopen_CTAtext: string
  "Pointclaim-banner-title": string
  WW_Hva_mobile_search_QRCode_Level1_Jan25_title: string
  AAD_Flyout_CTA: string
  LearnMore_Text: string
  HVA_StreakProtectionOn_Description: string
  OnboardingShowSelection_Title: string
  Sync_ShortTitle: string
  LearnMore: string
  ACTIVITIES_NEEDED: string
  RedeemNow: string
  Sync_SettingsLink_Text: string
  WW_Hva_RAF_Search_And_Earn_Redirection_title_v1: string
  TermsLink_Text: string
  DailyCheckIn_Card_Title: string
  SE_Default_Header: string
  OneTimeStreak_BIC_ExpiryText: string
  SE_No_Earning_Title_Uptiering: string
  dayOfWeek_Tuesday_locked_required_text: string
  AutoRedeem_order_completed_text: string
  SearchStreak_L2Step1_Title: string
  EdgeBrowsingStreak_TaskComplete: string
  ExploreOnBing_ORCA_Realestate_Promotion_Cta: string
  SearchStreak_L2Heading: string
  referAndEarnTitle: string
  ineligibleUserButtonText_key: string
  Redeem_Your_Reward: string
  autopen_exp2_body_nous: string
  Onboarding_Checklist_BingRafSearch_Title: string
  Goal_Title: string
  Edge_AC_Survey_Option_5_Placeholder: string
  EdgeHva_Popup_Description: string
  descriptionTextWelcomeNewUser_key: string
  HVA_retain_to_work_t1_202503_Linktext: string
  Redeem_Try_Redeem_Again: string
  OneTimeStreak_BIC_Title_RewardEligible: string
  HVA_Amazon_Sweepstakes_Holiday_Push_Description: string
  newLevel2_locked_required_text_prefix: string
  SI_SettingsLink_Text: string
  DailyStreaks_exp2_lvl2_edge_us: string
  EdgeAcquisition_JoinRewards_Cta: string
  Onboarding_Checklist_MoreActivities_Description: string
  FooterLinks_Separator: string
  Redeem_Product_Detail_Header: string
  DailyStreaks_exp1_lvl2_mobile_nous: string
  DailyCheckIn_Earning_Paused: string
  mobileonly_locked_required_text: string
  regularTrackerCardHeader_key: string
  Redeem_Quick: string
  Onboarding_Checklist_SetGoal_Description: string
  WW_Hva_RAF_Share_And_Win_Redirection_title: string
  RewardsDashboard: string
  newLevel2_locked_required_text_suffix: string
  LI_ShortTitle: string
  OneTimeStreak_Swiftkey_DSE_ButtonText: string
  DailyStreaks_exp1_lvl2_edge_nous: string
  Sync_CompletedDescription: string
  headerTextIneligible_key: string
  Redeem_Was_Not_Completed: string
  Checklist_Title_Raf: string
  SI_CompletedDescription: string
  DailyStreaks_exp2_lvl2_edge_nous: string
  AutoRedeem_warning_icon_alt_text: string
  level_values_new_level_1: string
  level_values_new_level_3: string
  level_values_new_level_2: string
  descriptionTextWarning_key: string
  WW_HVA_Form_Cooldown_Tooltip_202503_Description: string
  OneTimeStreak_Swiftkey_Description_RewardEligible: string
  ExploreOnBing_ORCA_Health_Promotion_Desc: string
  Redeem_Something_Went_Wrong: string
  Edge_AC_Survey_Option_Other: string
  HVA_retain_to_work_t2_202503_Description: string
  SearchStreak_L2Step2_Text: string
  Onboarding_Checklist_BingEdgeSearch_Title: string
  OneTimeStreak_Swiftkey_Title_Ongoing: string
  DailyCheckIn_VisualSearch_Title: string
  Edge_AC_Survey_Option_1: string
  Edge_AC_Survey_Option_0: string
  Edge_AC_Survey_Option_3: string
  Edge_AC_Survey_Option_2: string
  Edge_AC_Survey_Option_5: string
  Edge_AC_Survey_Option_4: string
  Edge_AC_Survey_Option_7: string
  Edge_AC_Survey_Option_6: string
  newOfferBannerText_key: string
  level2_locked_tooltip_message: string
  DailyCheckIn_ClaimingPending_TooltipDescription: string
  StreakProtectionToggleOff: string
  ExploreOnBing_ORCA_Hotel_Promotion_Title: string
  SearchStreak_L2Step1_Text: string
  Edge_BStreak_SignIn_Footer_Text: string
  DailyStreaks_exp1_lvl2_mobile_us: string
  WW_Hva_mobile_search_QRCode_Level2_Jan25_description1: string
  WW_Hva_mobile_search_QRCode_Level2_Jan25_description2: string
  EdgeAcquisition_JoinRewards_Description: string
  Rewards_Header_Text: string
  LI_ButtonText: string
  OneTimeStreak_BIC_Description_RewardEligible1: string
  EdgeHva_Popup_Title: string
  OneTimeStreak_Swiftkey_DSE_Description_Completed: string
  SearchStreak_L2Step2_Title: string
  OnboardingSelectGiftCard_Alert_Text: string
  HVA_StreakProtectionOn_UsedUpDescription: string
  Collapse_Text: string
  OneTimeStreak_Bilibili_Description_Completed: string
  RewardPoints_Text: string
  descriptionTextRegular_key: string
  Redeem_Order_Id: string
  OneTimeStreak_Swiftkey_Title_BeforeActivation: string
  OneTimeStreak_Bilibili_Title_Ongoing: string
  DailyStreaks_exp1_lvl2_edge_us: string
  SI_Title: string
  dayOfWeek_Sunday_locked_required_text: string
  BD_ButtonText: string
  DailyStreaks_exp2_lvl2_desktop_us: string
  WW_Hva_RAF_Search_And_Earn_Redirection_CTA: string
  autopen_exp2_title: string
  offerName_key: string
  DailyCheckIn_Description_Start: string
  HVA_StreakProtection_Header: string
  CI_SettingsLink_Text: string
  Redeem_Order_Still_Under_Review_Header: string
  DailyCheckIn_Description_First: string
  EdgeHva_L2_CompleteTask: string
  OneTimeStreak_Swiftkey_DSE_StreakTitle: string
  OneTimeStreak_BIC_Title_Completed: string
  Edge_BStreak_Popup_Keep_Cta: string
  DailyCheckIn_DailySet_Title: string
  AutoRedeem_unsubscribed_image_alt_text: string
  UserProfile_FirstName: string
  EdgeHva_L2_Timer: string
  DailyStreaks_exp2_lvl1_desktop_nous: string
  DailyCheckIn_Text_SeeAll: string
  WW_Hva_mobile_search_QRCode_Level2_Jan25_description: string
  OneTimeStreak_Swiftkey_DSE_Description_Ongoing: string
  L2_Default_Balance_Header: string
  dayOfWeek_Friday_locked_required_text: string
  regularHeaderText_key: string
  Redeem_Points: string
  DailyCheckIn_VisualSearch_Inactive_Subtitle: string
  Privacy_Statement_Text: string
  HVA_retain_to_work_all_202503_Complete_Linktext: string
  Redeem_Gift_Card_Will_Be_Sent: string
  MR_CompletedDescription: string
  MR_ButtonText: string
  Unlocked_Img_Alt: string
  Redeem_Processing: string
  WW_HVA_Search_Cooldown_Tooltip_202503_Linktext: string
  OneTimeStreak_Bilibili_ButtonText: string
  Set_Goal_Text: string
  redemptionButtonText_key: string
  OneTimeStreak_BIC_Description_BeforeActivation: string
  Claimable_Points_Claim_Now: string
  DailyCheckIn_Description_Progress: string
  EdgeAcquisition_SignIn_Description: string
  WW_HVA_Form_Cooldown_Tooltip_202503_Linktext: string
  EdgeAcquisition_JoinRewards_Title: string
  POINTS_TO_LEVEL: string
  dayOfWeek_Saturday_locked_required_text: string
  WW_Hva_RAF_Share_And_Win_Redirection_description: string
  AAD_Flyout_Description: string
  Sync_ButtonText: string
  CoreHVAL2CompletedFootNote: string
  OnboardingSelectGiftCard_GoalSelected_Text: string
  descriptionTextbrokenStreak_key: string
  Redeem_Account_Verification_Completed: string
  Redeem_Order_Still_Under_Review_Description: string
  UNCONSCIOUS_CONGRATZ_HVA_CTA2: string
  LI_Title: string
  ScrollBarButtonText: string
  ExploreOnBing_ORCA_Hotel_Promotion_Desc: string
  SE_No_Earning_Desc_Default: string
  SE_Earning_Title_Default: string
  DailyCheckIn_Outlook_Title: string
  OneTimeStreak_Swiftkey_Description_Ongoing: string
  "Pointclaim-banner-button-text": string
  OneTimeStreak_Bilibili_Description_BeforeActivation: string
  ExploreOnBing_Spotlight_Description_Key: string
  HVA_RedemptionCoupon_CTA: string
  OneTimeStreak_BIC_StreakTitle: string
  Set_Goal_Title: string
  DailyStreaks_exp2_lvl2_mobile_nous: string
  Edge_AC_Survey_Complete_Title: string
  BETA: string
  Edge_AC_Survey_Title: string
  EdgeHva_ClaimReward: string
  ExploreOnBing_Spotlight_CardHeader_Key: string
  HVA_StreakProtectionOn_UsedUpTitle: string
  Unsupported_Lang_Note_Text: string
}