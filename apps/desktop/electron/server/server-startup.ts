/** Installation-wide startup contract. Account data and the account's own lock stay unchanged. */
import type { ServerAccount } from './server-layout'
export { EXIT_RESTART, EXIT_CONFIG, EXIT_SIGNED_OUT } from './server-exit'
// This standalone file is copied verbatim and also loaded by the launcher before server.js.
export { acquireHomeLock, claimHomeLock, ownsHomeLock, homeLockHolder, readPendingVerify, writePendingVerify, markServerReady, writeJson, readBadVersions, legacyGuardActive, inspectAccountLayout, assertAccountLayoutReady, prepareAccountLogin, readCurrentAccount } from './server-boot.cjs'
export type { PendingVerify } from './server-boot.cjs'

export function assertAccountLogin(account: ServerAccount | null, userId: string): void {
  if (account?.signedIn && account.userId !== userId) throw new Error(`Gugu server is signed in as ${account.email ?? account.userId}. Sign out first or install under another system user.`)
}
