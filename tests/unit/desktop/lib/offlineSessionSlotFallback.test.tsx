// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { SessionInputOutboxHost } from '@/hooks/useSessionInputOutbox'
import { OfflineSessionSlotHost } from '@/components/chat/OfflineSessionSlotHost'
import { OfflineSessionSlot } from '@renderer/lib/offline-session-slot'
import { handoffNativeComposer } from '@/lib/nativeComposerHandoff'
import { readNativeOfflineDraft } from '@/lib/nativeOfflineDraft'
import { readShellSlots } from '@/lib/shellSlots'

const scope = vi.hoisted(() => ({ account: 'fallback-owner', devices: [{
  device_id: 'offline-host', label: 'Offline host', is_online: false, capabilities: {}, session_digest: [] as unknown[],
}] }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: scope.account } }) }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/components/chat/ChatSummariesHost', () => ({ ChatSummariesHost: () => null }))
vi.mock('@/components/chat/NativeConversationReadHost', () => ({ NativeConversationReadHost: () => null }))
vi.mock('@/mobile/agent-watch/SessionTimelinePage', () => ({ SessionTimelinePage: () => <output data-shared-native-timeline="">Native timeline</output> }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: () => 'Waiting for host' }))

let harness: ReturnType<typeof createReactHarness>
let sessionId: string
let serial = 0
const render = (label = 'Offline · 3 minutes ago') => renderWithAppProviders(harness, <>
  <SessionInputOutboxHost accountId={scope.account} />
  <OfflineSessionSlotHost />
  <OfflineSessionSlot deviceId="offline-host" sessionId={sessionId} label={label} />
</>, { auth: { id: scope.account } })
const field = () => harness.container.querySelector<HTMLTextAreaElement>('textarea')
beforeEach(() => {
  scope.account = `fallback-owner-${++serial}`
  scope.devices[0].session_digest = []
  sessionId = `unlisted-task-${serial}`
  localStorage.clear()
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); localStorage.clear() })

it.each(['absent', 'missing-version'])('accepts durable input when the Peek row is %s', async row => {
  if (row === 'missing-version') scope.devices[0].session_digest = [{ conversationId: sessionId, title: 'Offline task', runtime: 'acp', supported: true }]
  await render()
  await vi.waitFor(() => expect(field()).not.toBeNull())
  expect(harness.container.querySelector('[data-shared-native-timeline]')).toBeNull()
  await act(async () => { await handoffNativeComposer(sessionId, { text: 'Keep exactly one offline message' }) })
  expect(field()?.value).toBe('Keep exactly one offline message')
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-native-offline-input] button')!.click() })
  await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id]')?.textContent).toContain('Keep exactly one offline message'))
  await vi.waitFor(() => expect(harness.container.querySelector('[data-native-input-id] [role="alert"]')).not.toBeNull())
  expect(harness.container.querySelectorAll('[data-native-input-id]')).toHaveLength(1)
  expect(harness.container.querySelector('[data-native-input-id] button')).toBeNull()
  expect(field()?.value).toBe('')
})

it('updates the offline label without remounting the focused input or losing its text', async () => {
  await render()
  await vi.waitFor(() => expect(field()).not.toBeNull())
  const input = field()!
  input.focus()
  await act(async () => { await handoffNativeComposer(sessionId, { text: 'Still typing' }) })
  const keys = [...readShellSlots()!.getSlots().keys()]
  await render('Offline · 12 minutes ago')
  expect(field()).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('Still typing')
  expect(readNativeOfflineDraft('offline-host', sessionId)).toBe('Still typing')
  expect(harness.container.textContent).toContain('Offline · 12 minutes ago')
  expect([...readShellSlots()!.getSlots().keys()]).toEqual(keys)
})

it('keeps the fallback draft scoped to the signed-in account', async () => {
  const owner = scope.account
  await render()
  await vi.waitFor(() => expect(field()).not.toBeNull())
  await act(async () => { await handoffNativeComposer(sessionId, { text: 'Owner draft' }) })
  scope.account = `${owner}-other`
  await render()
  await vi.waitFor(() => expect(field()?.value).toBe(''))
  scope.account = owner
  await render()
  await vi.waitFor(() => expect(field()?.value).toBe('Owner draft'))
})

it.each([1, 2])('uses the existing shared timeline for native input version %s', async nativeInputVersion => {
  scope.devices[0].session_digest = [{ conversationId: sessionId, title: 'Native task', runtime: 'acp', supported: true, nativeInputVersion }]
  await render()
  expect(harness.container.querySelector('[data-shared-native-timeline]')).not.toBeNull()
  expect(field()).toBeNull()
})
