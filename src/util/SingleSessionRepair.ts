export async function withSingleSessionRepair<T>(
    attempt: (loadStoredSession: boolean) => Promise<T>,
    shouldRepair: (error: unknown) => boolean,
    onRepair: (error: unknown) => Promise<void> | void
): Promise<T> {
    try {
        return await attempt(true)
    } catch (error) {
        if (!shouldRepair(error)) throw error
        await onRepair(error)
        return await attempt(false)
    }
}
