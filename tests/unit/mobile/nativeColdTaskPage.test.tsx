// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'
import { SessionTimelinePage } from '../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { SessionInput } from '../../../apps/desktop/src/lib/sessionInputOutbox'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
const scope = vi.hoisted(() => ({ enqueue: vi.fn(async () => undefined), pending: [] as SessionInput[], timeline: null as ReturnType<typeof emptyAgentWatchTimeline> | null,
  nativeRecord: null as { turns: ReturnType<typeof emptyAgentWatchTimeline>['turns']; activeTurn: null; nextCursor: null } | null }))
vi.mock('../../../apps/desktop/src/lib/sessionInputOutboxBridge', () => ({ enqueueSessionInput: scope.enqueue, retrySessionInputs: vi.fn(), useQueuedSessionInputs: (sessionId: string) => scope.pending.filter(input => input.sessionId === sessionId) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: scope.timeline ?? emptyAgentWatchTimeline(), phase: 'error', error: 'Host unreachable', pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord', () => ({ useNativeSessionRecord: () => ({ record: scope.nativeRecord, error: null, followTail() {}, loadNewer() {}, loadOlder: async () => undefined }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/SessionConversation', () => ({ SessionConversation: ({ onSend, footerNotice }: { onSend: (text: string) => Promise<void>; footerNotice?: ReactNode }) => <>{footerNotice}<button data-cold-native-composer="" onClick={() => { void onSend('Cold native input') }}>Send</button></> }))
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { enabledTabContributions: [] } }))
vi.mock('../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); scope.enqueue.mockClear(); scope.pending = []; scope.timeline = null; scope.nativeRecord = null })
it('shows only the pending message and its sending indicator while the phone is offline', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  scope.pending = [{ id: 'input', accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'Queued original words', createdAt: 1 }]
  const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'acp', nativeInputVersion: 1, agentStatus: 'idle', status: { status: 'idle', detail: null } } as SessionpageSessionSummary
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('host', [], { is_online: true })} session={session} onBack={() => undefined} />)
  const text = harness.container.textContent ?? ''
  const hints = ['Sends when connected.', '连接后自动发送。', translateSessionMessage('conversation.connectionUnavailable')]
  expect(hints.reduce((count, hint) => count + text.split(hint).length - 1, 0)).toBe(0)
  expect(harness.container.querySelector('[data-native-input-queue]')?.textContent).toContain('Queued original words')
  expect(harness.container.querySelector('[data-native-input-id="input"] [data-send-state="sending"]')).not.toBeNull()
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
  expect(scope.enqueue).toHaveBeenCalledWith({ deviceId: 'host', sessionId: 'session', text: 'Cold native input', queued: false, baseline: [], afterTurnId: undefined })
})

it.each(['queue', 'transcript'] as const)('does not show a lost-acknowledgement failure when the host %s already owns that id', async location => {
  vi.stubGlobal('innerWidth', 390)
  const id = '11111111-1111-4111-8111-111111111111'
  const unrelatedId = '22222222-2222-4222-8222-222222222222'
  const failed: SessionInput = { id, accountId: 'owner', deviceId: 'host', sessionId: 'session', text: 'same words', createdAt: 1, queued: true,
    failure: { code: 'no-acknowledgement' } }
  scope.pending = [failed, { ...failed, id: unrelatedId }]
  scope.timeline = { ...emptyAgentWatchTimeline(), queuedPrompts: location === 'queue' ? [{ id, text: 'same words' }] : [] }
  scope.nativeRecord = { nextCursor: null, activeTurn: null, turns: location === 'transcript' ? [{ id: 'native-turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: `native-turn:message:${id}`, role: 'user', seq: 0, text: 'same words' },
  ] }] : [] }
  const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'acp', nativeInputVersion: 1, agentStatus: 'idle', status: { status: 'idle', detail: null } } as SessionpageSessionSummary
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('host', [], { is_online: true })} session={session} onBack={() => undefined} />)
  expect(harness.container.querySelector(`[data-native-input-id="${id}"]`)).toBeNull()
  expect(harness.container.querySelector(`[data-native-input-id="${unrelatedId}"] [data-send-state="failed"]`)).not.toBeNull()
  expect(scope.pending).toHaveLength(2)
})
