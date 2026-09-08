export async function readFinalBalance(read: () => Promise<number>, unavailable: (error: unknown) => void): Promise<number | null> {
    try {
        const balance = await read()
        if (!Number.isFinite(balance) || balance < 0) throw new Error('最终余额不可用')
        return balance
    } catch (error) {
        unavailable(error)
        return null
    }
}
