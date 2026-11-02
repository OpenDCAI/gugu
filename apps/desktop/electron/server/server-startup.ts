/** Installation-wide startup contract. Account data and the account's own lock stay unchanged. */
import type { ServerAccount } from './server-layout'
export { EXIT_RESTART, EXIT_CONFIG, EXIT_SIGNED_OUT } from './server-exit'
// This standalone file is copied verbatim and also loaded by the launcher before server.js.
export { acquireHomeLock, claimHomeLock, ownsHomeLock, readPendingVerify, writePendingVerify, markServerReady } from './server-boot.cjs'
export type { PendingVerify } from './server-boot.cjs'

export function onlySignedInAccount(accounts: readonly ServerAccount[]): ServerAccount | null {
  const signedIn = accounts.filter(account => account.signedIn)
  if (signedIn.length > 1) {
    throw new Error(`One system user can sign in to only one Gugu account. Signed in: ${signedIn.map(account => account.email ?? account.userId).join(', ')}. Run gugu-server logout <email> or use another system user. Account data was preserved.`)
  }
  return signedIn[0] ?? null
}

export function assertAccountLogin(accounts: readonly ServerAccount[], userId: string): void {
  const other = accounts.find(account => account.signedIn && account.userId !== userId)
  if (other) throw new Error(`Gugu server is signed in as ${other.email ?? other.userId}. Sign out first or install under another system user.`)
}
