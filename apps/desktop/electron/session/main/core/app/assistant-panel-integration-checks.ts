import { withBoundedOperation } from '@gugu/core/cloud/boundedOperation'
import { integrationConnectionService } from '@main/core/integrations/integration-connection-service'

type Checks = Awaited<ReturnType<typeof integrationConnectionService.checkAccounts>>
const saved = new Map<string, { signature: string; expires: number; value: Promise<{ checkedAt: number; checks: Checks }> }>()

/** Called only by an already active host. Cache by credential generation, so
 * ordinary panel reads do not verify credentials or prepare a device. */
export function panelIntegrationChecks(provider: string, signature: string, ownerId: string) {
  const key = `${ownerId}:${provider}`
  const old = saved.get(key)
  if (old?.signature === signature && old.expires > Date.now()) return old.value
  const value = withBoundedOperation(8000,() => new Error('PANEL_VERIFICATION_TIMEOUT'),
    () => integrationConnectionService.checkAccounts(provider)).then(checks => ({ checks,checkedAt: Date.now() }),
    () => ({ checks: [] as Checks,checkedAt: Date.now() }))
  saved.set(key,{ signature,expires: Date.now() + 300_000,value })
  return value
}
