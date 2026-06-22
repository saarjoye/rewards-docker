export interface BrowserEarnablePoints {
    desktopSearchPoints: number
    mobileSearchPoints: number
    dailySetPoints: number
    morePromotionsPoints: number
    totalEarnablePoints: number
}

export interface AppEarnablePoints {
    readToEarn: number
    checkIn: number
    totalEarnablePoints: number
}

export type SearchCounterStatus = 'ok' | 'missing-counter' | 'empty-counter' | 'invalid-counter' | 'completed'

export type SearchCounterSource = 'dashboard' | 'dashboard-html' | 'panel-flyout'

export interface SearchCounterInfo {
    detected: boolean
    status: SearchCounterStatus
    message: string
    completed: number
    total: number
    remaining: number
    itemCount: number
    source: SearchCounterSource
}

export interface MissingSearchPoints {
    mobilePoints: number
    desktopPoints: number
    edgePoints: number
    totalPoints: number
    mobileDetected: boolean
    mobileStatus: SearchCounterStatus
    mobileMessage: string
    mobileCounter: SearchCounterInfo
    desktopCounter: SearchCounterInfo
    edgeCounter: SearchCounterInfo
    counterKeys: string[]
    source: SearchCounterSource
}
