// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'
import { SessionTimelinePage } from '../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
const scope = vi.hoisted(() => ({ enqueue: vi.fn(async () => undefined) }))
vi.mock('../../../apps/desktop/src/lib/sessionInputOutboxBridge', () => ({ enqueueSessionInput: scope.enqueue, useQueuedSessionInputs: () => [] }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: emptyAgentWatchTimeline(), phase: 'error', error: 'Host unreachable', pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord', () => ({ useNativeSessionRecord: () => ({ record: null, error: null, followTail() {}, loadNewer() {}, loadOlder: async () => undefined }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/SessionConversation', () => ({ SessionConversation: ({ onSend }: { onSend: (text: string) => Promise<void> }) => <button data-cold-native-composer="" onClick={() => { void onSend('Cold native input') }}>Send</button> }))
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { enabledTabContributions: [] } }))
vi.mock('../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))
const harness = createReactHarness()
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); scope.enqueue.mockClear() })
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
