export type SessionValidationFailure =
    | 'stored-session-challenge'
    | 'bing-session-invalid'
    | 'rewards-session-invalid'
    | 'dashboard-session-invalid'

export class SessionValidationError extends Error {
    readonly recoverable = true

    constructor(
        readonly reason: SessionValidationFailure,
        message: string
    ) {
        super(message)
        this.name = 'SessionValidationError'
    }
}

export function isSessionValidationError(error: unknown): error is SessionValidationError {
    return error instanceof SessionValidationError
}
