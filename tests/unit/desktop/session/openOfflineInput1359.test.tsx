// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { SessionInputOutboxHost } from '@/hooks/useSessionInputOutbox'
import { OfflineSessionSlotHost } from '@/components/chat/OfflineSessionSlotHost'
import { handoffNativeComposer } from '@/lib/nativeComposerHandoff'

const task = vi.hoisted(() => ({
  sessionId: 'offline-entry-session',
  owner: 'offline-entry-owner',
  label: 'Task computer is offline',
  mount: vi.fn().mockResolvedValue(undefined),
  provision: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: task.owner } }), observeRendererSession: () => () => {} }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [{
  device_id: 'offline-host', label: task.label, is_online: false, capabilities: {}, session_digest: [],
}], phones: [] }) }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/components/chat/ChatSummariesHost', () => ({ ChatSummariesHost: () => null }))
vi.mock('@/components/chat/NativeConversationReadHost', () => ({ NativeConversationReadHost: () => null }))
vi.mock('@/mobile/agent-watch/SessionTimelinePage', () => ({ SessionTimelinePage: () => <output>Native timeline</output> }))
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: () => undefined,
  sessionViewKind: () => 'idle',
  asProvisioned: () => null,
  getSessionView: () => undefined,
  getSessionManagerStore: () => ({ provisionSession: task.provision }),
  sessionErrorMessage: () => null,
  projectMountErrorMessage: () => null,
}))
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({
  mountProject: task.mount, ensureMounted: task.mount,
}) }))
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useSessionViewContext: () => ({ projectId: 'offline-project', sessionId: task.sessionId }),
  useWorkspaceViewModel: () => ({}),
}))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: {
  device: () => ({ label: task.label }), cloudScope: () => null,
  findListedSession: () => { throw new Error('Opening offline input must not require a directory row') },
} }))
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => 'offline-host' } }))
vi.mock('@renderer/features/sessions/machine-unavailable-label', () => ({ machineUnavailableLabel: () => task.label }))
vi.mock('@renderer/features/sessions/use-cloud-computer-gate', () => ({ useCloudComputerGate: () => null }))
vi.mock('@renderer/features/sessions/session-tab-registry', () => ({ sessionTabView: {} }))
vi.mock('@renderer/features/sessions/view/session-main-column', () => ({ SessionMainColumn: () => null }))
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ leaveSessionView: vi.fn() }))
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: () => undefined } }))
vi.mock('@renderer/lib/ui/button', () => ({ Button: ({ children }: { children: ReactNode }) => <button>{children}</button> }))
vi.mock('@/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: ({ label }: { label: string }) => <span>{label}</span> }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn() }) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: () => 'Waiting for host' }))
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }))

import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session'
import { SessionContentGate } from '@renderer/features/sessions/main-panel'
import { toast } from '@renderer/lib/hooks/use-toast'

let harness: ReturnType<typeof createReactHarness>
let dispose: (() => void) | undefined
function TaskEntry() {
  const [opened, setOpened] = useState(false)
  return <>
    <button data-open-offline-task="" onClick={() => {
      dispose = openSessionInSessionWhenReady({
        projectId: 'offline-project', sessionId: task.sessionId, onReady: () => setOpened(true),
      })
    }}>Open task</button>
    {opened ? <SessionContentGate><span>Mounted workspace</span></SessionContentGate> : null}
  </>
}
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  harness = createReactHarness()
})
afterEach(() => { dispose?.(); dispose = undefined; harness.cleanup(); localStorage.clear() })

it('opens an offline task into the shared input page without a workspace or directory row', async () => {
  await renderWithAppProviders(harness, <>
    <SessionInputOutboxHost accountId={task.owner} />
    <OfflineSessionSlotHost />
    <TaskEntry />
  </>, { auth: { id: task.owner } })
  await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-open-offline-task]')!.click())
  await vi.waitFor(() => expect(harness.container.querySelector('[data-offline-session] textarea')).not.toBeNull())
  expect(harness.container.querySelector('[data-offline-session]')?.getAttribute('data-offline-session')).toBe(task.sessionId)
  await act(async () => { await handoffNativeComposer(task.sessionId, { text: 'Continue when the computer returns' }) })
  expect(harness.container.querySelector('textarea')?.value).toBe('Continue when the computer returns')
  expect(task.mount).not.toHaveBeenCalled()
  expect(task.provision).not.toHaveBeenCalled()
  expect(toast).not.toHaveBeenCalled()
})
