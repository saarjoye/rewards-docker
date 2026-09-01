export async function ensureSuccessfulLogin(login: () => Promise<void>): Promise<void> {
    await login()
}
