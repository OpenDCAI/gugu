import { withBoundedOperation } from '@gugu/core/cloud/boundedOperation'
import { integrationConnectionService } from '@main/core/integrations/integration-connection-service'
import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance'

type Checks = Awaited<ReturnType<typeof integrationConnectionService.checkAccounts>>
type Verified = { checkedAt: number; checks: Checks }
type Entry = { signature: string; expires: number; value: Verified | null; pending: boolean; listeners: Set<() => void> }
const saved = new Map<string,Entry>()
export function integrationAccountSignature(accounts: readonly { accountId: string; createdAt: number; updatedAt: number }[]) {
  return JSON.stringify(accounts.map(account => [account.accountId,account.createdAt,account.updatedAt]))
}

/** Called only by an already active host. Cache by credential generation, so
 * ordinary panel reads do not verify credentials or prepare a device. */
export function panelIntegrationChecks(provider: string, signature: string, ownerId: string,onVerified?: () => void): Verified | null {
  const key = `${ownerId}:${provider}`
  if (signature === '[]') { saved.delete(key); return null }
  let entry = saved.get(key)
  if (entry?.signature !== signature) {
    entry = { signature,expires: 0,value: null,pending: false,listeners: new Set() }
    saved.set(key,entry)
  }
  if (entry.pending) { if (onVerified) entry.listeners.add(onVerified); return entry.value }
  if (entry.expires > Date.now()) return entry.value
  if (onVerified) entry.listeners.add(onVerified)
  const current = entry
  current.pending = true
  // Publish the new credential generation without its predecessor's check.
  // Verification runs only on this already active host and never delays it.
  void withBoundedOperation(8000,() => new Error('PANEL_VERIFICATION_TIMEOUT'),async () => {
    const checks = await integrationConnectionService.checkAccounts(provider)
    const accounts = await providerAccountRegistry.listAccounts(provider)
    return { checks,current: integrationAccountSignature(accounts) === signature }
  }).then(result => {
    if (saved.get(key) !== current) return
    if (result.current) current.value = { checks: result.checks,checkedAt: Date.now() }
    else saved.delete(key) // A late result must not certify replaced credentials.
    current.expires = Date.now() + 300_000
    for (const listener of current.listeners) { try { listener() } catch { /* Publication retries independently. */ } }
  },() => { current.expires = Date.now() + 60_000 }).finally(() => { current.pending = false; current.listeners.clear() })
  return current.value
}
