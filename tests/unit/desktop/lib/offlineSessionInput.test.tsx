// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer } from '../../../support/composerEditor'
import { stubVisibleIntersection } from '../../../support/visibleIntersection'
import { SessionInputOutboxHost } from '../../../../apps/desktop/src/hooks/useSessionInputOutbox'
import { SessionTimelinePage } from '../../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { handoffNativeComposer } from '../../../../apps/desktop/src/lib/nativeComposerHandoff'
const scope = vi.hoisted(() => ({ pendingPrompt: null as import('@session-chat/state/pending-prompt').PendingPrompt | null, devices: [{ device_id: 'offline-host', is_online: false, capabilities: {} }] }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', async original => ({ ...await original<object>(), getRendererSession: () => ({ user: { id: 'offline-owner' } }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => false }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ SessionpageRpcError: class extends Error {}, fetchSessionOptions: vi.fn(() => new Promise(() => {})), setSessionOption: vi.fn() }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: emptyAgentWatchTimeline(), phase: 'error', error: 'Host unreachable', pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord', () => ({ useNativeSessionRecord: () => ({ record: null, error: null, followTail() {}, loadNewer() {}, loadOlder: async () => undefined }) }))
vi.mock('../../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: ({ composerContent, pendingPrompt }: { composerContent: import('react').ReactNode; pendingPrompt: import('@session-chat/state/pending-prompt').PendingPrompt | null }) => { scope.pendingPrompt = pendingPrompt; return <div>{composerContent}</div> } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { enabledTabContributions: [] } }))
vi.mock('../../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/localization/locale-store', () => ({ translateSessionMessage: () => 'Waiting for host' }))
const harness = createReactHarness()
afterEach(() => { harness.cleanup(); localStorage.clear(); vi.unstubAllGlobals() })
it('accepts and visibly retains a native message without any mounted remote workspace', async () => {
  stubVisibleIntersection()
  const session = { conversationId: 'cold-session', projectId: 'project', title: 'Offline task', runtime: 'acp', nativeInputVersion: 2, agentStatus: 'idle', status: { status: 'idle', detail: null } } as SessionpageSessionSummary
  await renderWithAppProviders(harness, <><SessionInputOutboxHost accountId="offline-owner" /><SessionTimelinePage device={device('offline-host', [], { is_online: false })} session={session} onBack={() => {}} /></>)
  const field = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
  await vi.waitFor(() => expect(field()).not.toBeNull())
  await act(async () => { await handoffNativeComposer('cold-session', { text: 'Send when the host returns' }) })
  await vi.waitFor(() => expect(readComposer(field())).toBe('Send when the host returns'))
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-actions-end"] > button')!.click() })
  await vi.waitFor(() => expect(scope.pendingPrompt).toMatchObject({ text: 'Send when the host returns', delivery: { state: 'waiting', retryable: false } }))
  expect(scope.pendingPrompt?.delivery).toMatchObject({ state: 'waiting', error: expect.any(String), reason: expect.any(String) })
  // The transcript owns this ordinary input, so the footer must not draw a second copy.
  expect(harness.container.querySelector('[data-native-input-id]')).toBeNull()
  expect(readComposer(field())).toBe('')
})
