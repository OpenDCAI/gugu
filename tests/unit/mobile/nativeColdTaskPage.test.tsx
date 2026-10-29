// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'
import { SessionTimelinePage } from '../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { SessionInput } from '../../../apps/desktop/src/lib/sessionInputOutbox'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
const scope = vi.hoisted(() => ({ enqueue: vi.fn(async () => undefined), pending: [] as SessionInput[] }))
vi.mock('../../../apps/desktop/src/lib/sessionInputOutboxBridge', () => ({ enqueueSessionInput: scope.enqueue, useQueuedSessionInputs: (sessionId: string) => scope.pending.filter(input => input.sessionId === sessionId) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: emptyAgentWatchTimeline(), phase: 'error', error: 'Host unreachable', pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord', () => ({ useNativeSessionRecord: () => ({ record: null, error: null, followTail() {}, loadNewer() {}, loadOlder: async () => undefined }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/SessionConversation', () => ({ SessionConversation: ({ onSend, footerNotice }: { onSend: (text: string) => Promise<void>; footerNotice?: ReactNode }) => <>{footerNotice}<button data-cold-native-composer="" onClick={() => { void onSend('Cold native input') }}>Send</button></> }))
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { enabledTabContributions: [] } }))
vi.mock('../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); scope.enqueue.mockClear(); scope.pending = [] })
it('shows one reconnect hint beside the queued input while the phone is offline', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  scope.pending = [{ id: 'input', accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'Queued original words', createdAt: 1 }]
  const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'acp', nativeInputVersion: 1, agentStatus: 'idle', status: { status: 'idle', detail: null } } as SessionpageSessionSummary
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('host', [], { is_online: true })} session={session} onBack={() => undefined} />)
  const text = harness.container.textContent ?? ''
  const hints = ['composer.waitingForHost', 'conversation.connectionUnavailable'].map(key => translateSessionMessage(key))
  expect(hints.reduce((count, hint) => count + text.split(hint).length - 1, 0)).toBe(1)
  expect(harness.container.querySelector('[data-native-input-queue]')?.textContent).toContain('Queued original words')
  expect(harness.container.querySelector('[data-cold-native-composer]')).not.toBeNull()
})
it('keeps the same native task composer when the phone is cold and offline, without blaming a healthy remote host', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'acp', nativeInputVersion: 1, agentStatus: 'idle', status: { status: 'idle', detail: null } } as SessionpageSessionSummary
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('host', [], { is_online: true })} session={session} onBack={() => undefined} />)
  expect(harness.container.querySelector('[data-cold-native-composer]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="agent-watch-local-offline"]')).not.toBeNull()
  expect(harness.container.textContent).not.toContain('Host unreachable')
  expect(harness.container.querySelector('[data-testid="agent-watch-session-status"]')).toBeNull()
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-cold-native-composer]')!.click() })
  expect(scope.enqueue).toHaveBeenCalledWith({ deviceId: 'host', sessionId: 'session', text: 'Cold native input' })
})
