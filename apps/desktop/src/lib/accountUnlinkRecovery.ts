import { rendererLogger } from './log'

export type UnlinkRecoveryPhase = 'revoke' | 'local'
const log = rendererLogger('auth/unlink-recovery')
const memory = new Map<string, UnlinkRecoveryPhase>()
const key = (userId: string) => `gugu-account-unlink-recovery:${userId}`

/** Only an account-scoped cleanup marker is persisted. Bearer tokens stay in memory. */
export const accountUnlinkRecovery = {
  read(userId: string): UnlinkRecoveryPhase | null {
    if (memory.has(userId)) return memory.get(userId)!
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(key(userId)) ?? 'null')
      if (saved === 'revoke' || saved === 'local') return saved
    } catch (error) { log.error({ error }, 'read pending unlink cleanup failed') }
    return null
  },
  write(userId: string, phase: UnlinkRecoveryPhase): void {
    memory.set(userId, phase)
    try { window.localStorage.setItem(key(userId), JSON.stringify(phase)) }
    catch (error) { log.error({ error }, 'persist pending unlink cleanup failed') }
  },
  clear(userId: string): void {
    memory.delete(userId)
    try { window.localStorage.removeItem(key(userId)) }
    catch (error) { log.error({ error }, 'clear pending unlink cleanup failed') }
  },
}
