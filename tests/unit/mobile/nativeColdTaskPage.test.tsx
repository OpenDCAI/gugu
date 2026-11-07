// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'
import { SessionTimelinePage } from '../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { applySnapshot, applyTimelineResult, emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { SessionInput } from '../../../apps/desktop/src/lib/sessionInputOutbox'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
const scope = vi.hoisted(() => ({ enqueue: vi.fn(async () => undefined), pending: [] as SessionInput[], timeline: null as ReturnType<typeof emptyAgentWatchTimeline> | null,
  composer: null as null | { timeline?: ReturnType<typeof emptyAgentWatchTimeline>; agentWorking?: boolean; onBeforeSend?: () => void; onSend: (text: string) => Promise<void> },
  nativeRecord: null as { turns: ReturnType<typeof emptyAgentWatchTimeline>['turns']; activeTurn: ReturnType<typeof emptyAgentWatchTimeline>['turns'][number] | null; nextCursor: null } | null }))
vi.mock('../../../apps/desktop/src/lib/sessionInputOutboxBridge', () => ({ enqueueSessionInput: scope.enqueue, retrySessionInputs: vi.fn(), useQueuedSessionInputs: (sessionId: string) => scope.pending.filter(input => input.sessionId === sessionId) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: scope.timeline ?? emptyAgentWatchTimeline(), phase: 'error', error: 'Host unreachable', pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord', () => ({ useNativeSessionRecord: () => ({ record: scope.nativeRecord, error: null, followTail() {}, loadNewer() {}, loadOlder: async () => undefined }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/SessionConversation', () => ({ SessionConversation: (props: { timeline: ReturnType<typeof emptyAgentWatchTimeline>; onBeforeSend?: () => void; onSend: (text: string) => Promise<void>; footerNotice?: ReactNode }) => { scope.composer = props; return <>{props.footerNotice}<button data-cold-native-composer="" onClick={() => { void props.onSend('Cold native input') }}>Send</button></> } }))
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
  expect(scope.enqueue).toHaveBeenCalledWith({ deviceId: 'host', sessionId: 'session', text: 'Cold native input', composer: true, queued: false, baseline: [], afterTurnId: undefined })
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


it.each([
  { mobile: true, busy: true, identity: undefined, blocked: true },
  { mobile: true, busy: false, identity: undefined, blocked: false },
  { mobile: true, busy: true, identity: true, blocked: false },
  { mobile: false, busy: true, identity: undefined, blocked: false },
])('checks the phone queued handoff before enqueue: %j', async ({ mobile, busy, identity, blocked }) => {
  vi.stubGlobal('innerWidth', mobile ? 390 : 1200)
  scope.timeline = { ...emptyAgentWatchTimeline(), turns: busy ? [{ id: 'working', seq: 0, initiator: 'user', items: [] }] : [] }
  scope.nativeRecord = { turns: [], activeTurn: busy ? scope.timeline.turns[0] : null, nextCursor: null }
  const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'acp', nativeInputVersion: 2,
    ...(identity ? { nativeInputIdentity: true } : {}), agentStatus: busy ? 'working' : 'idle' } as SessionpageSessionSummary
  const render = () => renderWithAppProviders(harness, <SessionTimelinePage device={device('host', [], { is_online: true })} session={session} onBack={() => undefined} />)
  await render()
  if (blocked) {
    expect(() => scope.composer!.onBeforeSend?.()).toThrow(/Update|更新/)
    await expect(scope.composer!.onSend('keep the whole draft')).rejects.toThrow(/Update|更新/)
    expect(scope.enqueue).not.toHaveBeenCalled()
    Object.assign(session, { nativeInputIdentity: true })
    await render()
  }
  expect(() => scope.composer!.onBeforeSend?.()).not.toThrow()
  await scope.composer!.onSend('keep the whole draft')
  expect(scope.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'keep the whole draft', queued: busy }))
})

it.each([false, true])('uses the native foreground instead of the provider boundary (native busy=%s)', async busy => {
  vi.stubGlobal('innerWidth', 390)
  const done = { id: 'native', seq: 1, initiator: 'user' as const, items: [], outcome: { kind: 'done' as const } }
  scope.timeline = { ...emptyAgentWatchTimeline(), turns: [{ ...done, id: 'provider', outcome: busy ? done.outcome : undefined }] }
  scope.nativeRecord = { turns: busy ? [] : [done], activeTurn: busy ? { ...done, outcome: undefined } : null, nextCursor: null }
  const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'acp', nativeInputVersion: 2,
    nativeInputIdentity: true, agentStatus: 'idle' } as SessionpageSessionSummary
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('host', [], { is_online: true })} session={session} onBack={() => undefined} />)
  expect(scope.composer!.agentWorking).toBe(busy)
  await scope.composer!.onSend('whole input')
  expect(scope.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'whole input', queued: busy }))
})


it.each(['epoch_changed', 'cursor_ahead', 'source_replaced', 'source_unreadable', 'gap', 'gap_too_large'] as const)('keeps a recovered %s timeline available without a persistent reload notice', async reason => {
  vi.stubGlobal('innerWidth', 390)
  const turns = [{ id: 'recovered-turn', seq: 1, initiator: 'user' as const, outcome: { kind: 'done' as const }, items: [
    { kind: 'message' as const, id: 'retained-message', role: 'user' as const, seq: 0, text: 'Retained record content' },
  ] }]
  const old = applySnapshot(emptyAgentWatchTimeline(), { cursor: { epoch: 'before-restart', seq: 1 }, turns: [], settlements: [], hasOlder: false })
  scope.timeline = applyTimelineResult(old, { ok: false, reset: reason, snapshot: { cursor: { epoch: 'after-restart', seq: 1 }, turns, settlements: [], hasOlder: false } })
  scope.nativeRecord = { turns, activeTurn: null, nextCursor: null }
  const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'acp', nativeInputVersion: 2, nativeInputIdentity: true, agentStatus: 'idle' } as SessionpageSessionSummary
  const toast = vi.fn()
  const page = <SessionTimelinePage device={device('host', [], { is_online: true })} session={session} onBack={() => undefined} />
  await renderWithAppProviders(harness, page, { toast })
  await renderWithAppProviders(harness, page, { toast })
  expect(toast).toHaveBeenCalledExactlyOnceWith('Host unreachable', 'error')
  expect(harness.container.querySelector('[data-testid="agent-watch-reset-note"]')).toBeNull()
  expect(harness.container.querySelector('[data-testid="agent-watch-timeline-error"]')).toBeNull()
  expect(scope.composer?.timeline?.turns).toEqual(turns)
  expect(scope.timeline.cursor).toEqual({ epoch: 'after-restart', seq: 1 })
  expect(scope.timeline.needsSnapshot).toBeNull()
})
