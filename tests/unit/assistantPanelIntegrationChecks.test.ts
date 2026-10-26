import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ verify: vi.fn(), accounts: [{ accountId: 'one',createdAt: 10,updatedAt: 20 }] }))
vi.mock('@main/core/integrations/integration-connection-service',() => ({ integrationConnectionService: { checkAccounts: fixture.verify } }))
vi.mock('@main/core/provider-accounts/provider-account-registry-instance',() => ({ providerAccountRegistry: { listAccounts: async () => fixture.accounts } }))
import { panelIntegrationChecks } from '../../apps/desktop/electron/session/main/core/app/assistant-panel-integration-checks'
const signature = () => JSON.stringify(fixture.accounts.map(account => [account.accountId,account.createdAt,account.updatedAt]))
beforeEach(() => { vi.useFakeTimers(); fixture.verify.mockReset(); fixture.accounts = [{ accountId: 'one',createdAt: 10,updatedAt: 20 }] })
afterEach(() => { vi.useRealTimers() })

it('publishes unverified immediately for new credentials and only exposes their completed verification',async () => {
  const old = Promise.withResolvers<[{ accountId: string; connected: boolean }]>(), next = Promise.withResolvers<[{ accountId: string; connected: boolean }]>()
  fixture.verify.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const updated = vi.fn()
  expect(panelIntegrationChecks('changed',signature(),'owner',updated)).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  old.resolve([{ accountId: 'one',connected: true }])
  await vi.advanceTimersByTimeAsync(0)
  expect(panelIntegrationChecks('changed',signature(),'owner',updated)).toMatchObject({ checks: [{ connected: true }] })
  fixture.accounts[0]!.updatedAt = 30
  expect(panelIntegrationChecks('changed',signature(),'owner',updated)).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  next.resolve([{ accountId: 'one',connected: false }])
  await vi.advanceTimersByTimeAsync(0)
  expect(panelIntegrationChecks('changed',signature(),'owner',updated)).toMatchObject({ checks: [{ connected: false }] })
  expect(updated).toHaveBeenCalledTimes(2)
  expect(fixture.verify).toHaveBeenCalledTimes(2)
})

it('discards verification if credentials change before another publication notices them',async () => {
  const deferred = Promise.withResolvers<[{ accountId: string; connected: boolean }]>()
  fixture.verify.mockReturnValueOnce(deferred.promise)
  const updated = vi.fn()
  expect(panelIntegrationChecks('late',signature(),'owner',updated)).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  fixture.accounts[0]!.updatedAt = 30
  deferred.resolve([{ accountId: 'one',connected: true }])
  await vi.advanceTimersByTimeAsync(0)
  expect(updated).toHaveBeenCalledTimes(1)
  expect(panelIntegrationChecks('late',signature(),'owner')).toBeNull()
})

it('does not manufacture a failed result when verification times out',async () => {
  fixture.verify.mockReturnValue(new Promise(() => {}))
  expect(panelIntegrationChecks('timeout',signature(),'owner')).toBeNull()
  await vi.advanceTimersByTimeAsync(8001)
  expect(panelIntegrationChecks('timeout',signature(),'owner')).toBeNull()
})
