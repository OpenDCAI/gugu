// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { SessionInputOutboxHost } from '../../../../apps/desktop/src/hooks/useSessionInputOutbox'
import { OfflineSessionInput } from '../../../../apps/desktop/src/components/chat/OfflineSessionInput'
import { handoffNativeComposer } from '../../../../apps/desktop/src/lib/nativeComposerHandoff'
const scope = vi.hoisted(() => ({ devices: [{ device_id: 'offline-host', is_online: false, capabilities: {} }] }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: 'offline-owner' } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({ translateSessionMessage: () => 'Waiting for host' }))
const harness = createReactHarness()
afterEach(() => { harness.cleanup(); localStorage.clear() })
it('accepts and visibly retains a native message without any mounted remote workspace', async () => {
  await harness.render(<><SessionInputOutboxHost accountId="offline-owner" /><OfflineSessionInput deviceId="offline-host" sessionId="cold-session" label="Host offline" /></>)
  await vi.waitFor(() => expect(harness.container.querySelector('textarea')).not.toBeNull())
  await act(async () => { await handoffNativeComposer('cold-session', { text: 'Send when the host returns' }) })
  expect(harness.container.querySelector('textarea')?.value).toBe('Send when the host returns')
  await act(async () => { harness.container.querySelector('button')!.click() })
  await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id] > div')?.textContent).toBe('Send when the host returns'))
  expect(harness.container.querySelector('textarea')?.value).toBe('')
})
