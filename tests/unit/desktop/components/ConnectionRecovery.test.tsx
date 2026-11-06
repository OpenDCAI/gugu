// @vitest-environment jsdom
import { act,createElement } from 'react'
import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useConnectionRecovery } from '@/components/connections/useConnectionRecovery'
import type { ConnectionMetadataStore } from '@/components/connections/connection-metadata'
const fixture = vi.hoisted(() => ({ retry: vi.fn(),owner: 'owner' }))
vi.mock('@/lib/connectionBridge',() => ({ connectionBridge: () => ({ accountId: () => fixture.owner,retryOperation: fixture.retry }) }))
const rows = [
  { resourceKey: 'platform-key',operationId: 'original-platform-uuid',operation: 'remove',status: 'pending',terminal: false },
  { resourceKey: 'platform-key',operationId: 'original-unknown-uuid',operation: 'remove',status: 'failed',terminal: true,errorCode: 'CONNECTION_OUTCOME_UNKNOWN' },
  { resourceKey: 'device-key',operationId: 'original-device-uuid',operation: 'remove',status: 'pending',terminal: false },
]
const store = { ownerId: 'owner',invalidate: vi.fn(),peekSnapshot: () => ({ items: [{ resource_key: 'platform-key',source: { scopeKey: 'platform' } },
  { resource_key: 'device-key',source: { scopeKey: 'device:mac' } }],application: rows }) } as unknown as ConnectionMetadataStore
let harness: ReturnType<typeof createReactHarness>
function Probe({ allowed = true }) { useConnectionRecovery(store,allowed); return null }
beforeEach(() => { harness = createReactHarness(); vi.useFakeTimers(); fixture.retry.mockReset(); fixture.owner = 'owner' })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })
it('automatically retries the exact platform UUID with backoff while never replaying unknown or device effects',async () => {
  fixture.retry.mockRejectedValue(new Error('OFFLINE'))
  await harness.render(createElement(Probe))
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(fixture.retry).toHaveBeenCalledExactlyOnceWith('original-platform-uuid')
  await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
  expect(fixture.retry).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(fixture.retry.mock.calls).toEqual([['original-platform-uuid'],['original-platform-uuid']])
})
it('does not start recovery during a transition or after an account switch',async () => {
  await harness.render(createElement(Probe,{ allowed: false }))
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(fixture.retry).not.toHaveBeenCalled()
  await harness.render(createElement(Probe,{ allowed: true }))
  fixture.owner = 'other'
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(fixture.retry).not.toHaveBeenCalled()
})
