// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { clickElement, createReactHarness, renderWithAppProviders, device } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const mocks = vi.hoisted(() => ({ devices: [] as Device[], phones: [] as Device[], rows: [] as { deviceId: string; summary: SessionpageSessionSummary; live: boolean }[], localWorker: false, transport: vi.fn(), dm: vi.fn(), identities: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', async original => ({ ...await original<object>(), readRequiredDisplayIdentities: mocks.identities }))
vi.mock('../../../../apps/desktop/src/components/assistant/useAssistantDm', () => ({ useAssistantDm: mocks.dm }))
vi.mock('../../../../apps/desktop/src/components/ChatAreaPanel', () => ({ ChatAreaPanel: ({ viewportKey }: { viewportKey: string }) => <div data-testid="task-chat-panel" data-viewport-key={viewportKey} /> }))
vi.mock('../../../../apps/desktop/src/components/assistant/TaskChatScope', () => ({ TaskChatScope: ({ chatId, children }: { chatId: string; children: React.ReactNode }) => <div data-chat-id={chatId}>{children}</div> }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: mocks.devices.map((device) => device.device_id === 'worker' ? { ...device, is_current_device: device.is_current_device || mocks.localWorker } : device), phones: mocks.phones }) }))
vi.mock('../../../../apps/desktop/src/components/assistant/taskExchangeTransport', () => ({ taskExchangeTransport: mocks.transport }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { allListedSessions: () => mocks.rows, device: () => ({ label: 'Worker' }) } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions', () => ({
  homeTarget: () => 'home', homeSessions: () => ({ sessions: mocks.rows.map((row) => row.summary), live: true }), localHomeSessions: { loaded: false, sessions: [], error: null },
}))

import { AssistantTaskChatOpener } from '../../../../apps/desktop/src/components/assistant/AssistantTaskChatOpener'
import { PhoneTasks } from '../../../../apps/desktop/src/mobile/assistant/PhoneTasks'
import type { PhonePageProps } from '../../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import { AssistantTasksPage } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-tasks'
import type { AssistantContext } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-context'
import { OPEN_ASSISTANT_TASK_CHAT, openAssistantTaskChat, readAssistantTaskChat, rememberAssistantTaskChat, showAssistantTaskChat } from '../../../../apps/desktop/src/lib/assistantTaskChat'
import { installAssistantShellBridge } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { useTaskChatRows } from '../../../../apps/desktop/src/components/assistant/useTaskChatRows'
import { publishDirectoryDevices, retainDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { APP_SHOW_SESSION_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

let harness: ReturnType<typeof createReactHarness>
const summary = (conversationId: string, userId: string, parentConversationId: string | null = null): SessionpageSessionSummary => ({
  conversationId, projectId: 'p', title: conversationId, harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: '2026-10-16T12:00:00Z', supported: false, agent: { userId }, parentConversationId,
})
const assistant = { id: 'assistant', display_name: '咕咕', avatar: null, created_at: null }
beforeEach(() => {
  harness = createReactHarness()
  installAssistantShellBridge()
  installShellSlots()
  showAssistantTaskChat(null)
  mocks.localWorker = false
  mocks.identities.mockReset()
  mocks.dm.mockReset().mockReturnValue({ chatId: 'task-dm', failed: false, retry: vi.fn() })
  mocks.transport.mockReset().mockResolvedValue({
    read: async () => ({ entries: [], cursor: 0, hasMore: false }),
    subscribe: async () => ({ entries: [], cursor: 0, hasMore: false }),
    unsubscribe: async () => {}, onPage: () => () => {},
  })
  mocks.rows = [{ deviceId: 'home', summary: summary('assistant-session', 'assistant'), live: true }, { deviceId: 'worker', summary: summary('task-session', 'task-agent', 'assistant-session'), live: false }]
  mocks.devices = [device('worker', [], { label: 'Worker', is_online: false, session_digest: [{ conversationId: 'task-session', projectId: 'p', projectName: 'Project', title: 'task-session', agentUserId: 'task-agent', parentConversationId: 'assistant-session', agentStatus: 'idle', lastInteractedAt: '2026-10-16T12:00:00Z', harness: 'codex', supported: false }] }), device('home', [], { label: 'Home' })]
  mocks.phones = []
  retainDeviceSessions([])
  publishDirectoryDevices(mocks.devices)
  for (const row of mocks.rows) updateDeviceSessions(row.deviceId, { sessions: [row.summary], cached: false, loading: false, error: null })
})
afterEach(() => { harness.cleanup(); showAssistantTaskChat(null); retainDeviceSessions([]); publishDirectoryDevices([]) })

describe('assistant task rows open the task chat on both shells', () => {
  it('reads this computer’s saved collaboration even when its cloud presence is offline', async () => {
    mocks.localWorker = true
    rememberAssistantTaskChat('offline-owner', { assistantId: 'assistant', taskAgentId: 'offline-task', task: { deviceId: 'worker', sessionId: 'local-task' }, assistants: [{ deviceId: 'worker', sessionId: 'local-assistant' }] })
    function LocalChat() {
      const { notice } = useTaskChatRows([], 'offline-owner', 'offline-task', true, '')
      return notice
    }
    await renderWithAppProviders(harness, <LocalChat />)
    expect(mocks.transport).toHaveBeenCalledTimes(2)
    expect(mocks.transport).toHaveBeenCalledWith('worker', true)
    expect(harness.container.querySelector('[data-testid="task-collaboration-status"]')?.textContent).toContain('含个人助理的协作记录')
  })
  it('a collaboration read failure says the record is incomplete and retries the same endpoints (keeps what was read)', async () => {
    mocks.localWorker = true
    rememberAssistantTaskChat('retry-owner', { assistantId: 'assistant', taskAgentId: 'retry-task', task: { deviceId: 'worker', sessionId: 'local-task' }, assistants: [{ deviceId: 'worker', sessionId: 'local-assistant' }] })
    const subscribe = vi.fn().mockRejectedValueOnce(new Error('no handler for sessionTimeline.taskExchangesSubscribe')).mockResolvedValue({ entries: [], cursor: 0, hasMore: false })
    mocks.transport.mockResolvedValue({ read: async () => ({ entries: [], cursor: 0, hasMore: false }), subscribe, unsubscribe: async () => {}, onPage: () => () => {} })
    function RetryChat() {
      const { notice } = useTaskChatRows([], 'retry-owner', 'retry-task', true, '')
      return notice
    }
    await renderWithAppProviders(harness, <RetryChat />)
    await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="task-collaboration-retry"]')).not.toBeNull())
    expect(harness.container.querySelector('[data-testid="task-collaboration-status"]')?.textContent).toContain('暂时无法读取完整的协作记录')
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="task-collaboration-retry"]')!)
    await vi.waitFor(() => expect(harness.container.querySelector('[data-testid="task-collaboration-status"]')?.textContent).toContain('含个人助理的协作记录'))
    expect(harness.container.querySelector('[data-testid="task-collaboration-retry"]')).toBeNull()
    expect(subscribe.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
  it.each(['phone', 'desktop'])('%s opens a chat even when the worker is offline or its transcript format is unsupported', async (shell) => {
    const opened = vi.fn()
    const showSession = vi.fn()
    window.addEventListener(OPEN_ASSISTANT_TASK_CHAT, opened)
    window.addEventListener(APP_SHOW_SESSION_EVENT, showSession)
    try {
      const common: PhonePageProps = { assistant, chatId: 'assistant-dm', ownerName: 'Owner', home: { kind: 'cloud', deviceId: 'home' }, machine: { state: 'opening' }, homeDeviceId: 'home', cloudDeviceId: 'home', readiness: 'ready', askInChat: vi.fn(), sub: null, go: vi.fn(), open: vi.fn() }
      const context: AssistantContext = { assistant, chatId: common.chatId, ownerName: common.ownerName, home: { kind: 'cloud', deviceId: 'home' }, homeDeviceId: 'home', snapshot: null, readiness: 'ready', machine: undefined, machineLoading: false, machineError: null, retryMachine: vi.fn(), askInChat: vi.fn(), route: { tab: 'tasks' }, go: vi.fn() }
      await renderWithAppProviders(harness, shell === 'phone'
        ? <PhoneTasks {...common} />
        : <AssistantTasksPage context={context} />)
      const row = harness.container.querySelector('[data-testid="assistant-subagent-task-session"]')
      expect(row).not.toBeNull()
      await clickElement(row as HTMLElement)
      expect(opened).toHaveBeenCalledOnce()
      expect(opened.mock.calls[0]![0].detail).toEqual({ assistantId: 'assistant', taskAgentId: 'task-agent', task: { deviceId: 'worker', sessionId: 'task-session' }, assistants: [{ deviceId: 'home', sessionId: 'assistant-session' }] })
      expect(showSession).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(OPEN_ASSISTANT_TASK_CHAT, opened)
      window.removeEventListener(APP_SHOW_SESSION_EVENT, showSession)
    }
  })
  it.each(['phone', 'desktop'])('%s lists phone work from the shared directory and labels devices relative to the viewer', async (shell) => {
    const phone = device('phone-worker', [], { label: 'My phone', platform: 'android', is_current_device: shell === 'phone', capabilities: { terminals: [], runtimes: ['pi'], host_kind: 'phone', host_runtime_capability: 1 } })
    mocks.devices = [device('worker', [], { label: 'My computer', is_current_device: shell === 'desktop' }), device('home', [], { label: 'Assistant home' }), phone]
    publishDirectoryDevices(mocks.devices)
    const computer = summary('computer-task', 'computer-agent', 'assistant-session')
    const phoneTask = { ...summary('phone-task', 'phone-agent', 'assistant-session'), harness: 'pi', status: { status: 'working', detail: 'running' } }
    updateDeviceSessions('worker', { sessions: [computer], cached: false })
    updateDeviceSessions('phone-worker', { sessions: [phoneTask], cached: false, loading: false })
    // The workspace-only store still cannot see the phone. The pane must use the shared directory.
    expect(mocks.rows.some((row) => row.deviceId === 'phone-worker')).toBe(false)
    const common: PhonePageProps = { assistant, chatId: 'assistant-dm', ownerName: 'Owner', home: { kind: 'cloud', deviceId: 'home' }, machine: { state: 'opening' }, homeDeviceId: 'home', cloudDeviceId: 'home', readiness: 'ready', askInChat: vi.fn(), sub: null, go: vi.fn(), open: vi.fn() }
    const context: AssistantContext = { assistant, chatId: common.chatId, ownerName: 'Owner', home: { kind: 'cloud', deviceId: 'home' }, homeDeviceId: 'home', snapshot: null, readiness: 'ready', machine: undefined, machineLoading: false, machineError: null, retryMachine: vi.fn(), askInChat: vi.fn(), route: { tab: 'tasks' }, go: vi.fn() }
    await renderWithAppProviders(harness, shell === 'phone' ? <PhoneTasks {...common} /> : <AssistantTasksPage context={context} />)
    const phoneRow = () => harness.container.querySelector('[data-testid="assistant-subagent-phone-task"]')
    const computerRow = harness.container.querySelector('[data-testid="assistant-subagent-computer-task"]')
    expect(phoneRow()).not.toBeNull()
    expect(computerRow).not.toBeNull()
    expect(phoneRow()!.textContent?.includes('My phone')).toBe(shell !== 'phone')
    expect(computerRow!.textContent?.includes('My computer')).toBe(shell !== 'desktop')
    expect(phoneRow()!.querySelector(shell === 'phone' ? '[data-tone="running"]' : '[data-agent-status="working"]')).not.toBeNull()
    act(() => updateDeviceSessions('phone-worker', { sessions: [{ ...phoneTask, agentStatus: 'idle', status: { status: 'idle', detail: 'done' } }] }))
    expect(phoneRow()!.querySelector('[data-tone="running"], [data-agent-status="working"]')).toBeNull()
  })
  it('opens the task chat inside its pane without a modal or shell navigation, and returns to the same draft', async () => {
    const open = vi.fn()
    const contacts = [assistant, { id: 'task-agent', display_name: '报告任务', avatar: null }].map((contact) => ({ ...contact, bio: null, type: 'agent' as const, owner_user_id: 'user-1' }))
    await renderWithAppProviders(harness, <><input data-testid="assistant-draft" defaultValue="未发完的交代" /><section data-testid="task-pane" ref={(node) => readShellSlots()?.setSlot('assistant:task-chat', node)} /><AssistantTaskChatOpener visible onOpenUserChat={open} /></>, { contacts: { contacts } })
    act(() => openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows))
    expect(open).not.toHaveBeenCalled()
    const popup = document.querySelector<HTMLElement>('[data-testid="assistant-task-chat-window"]')!
    expect(harness.container.querySelector('[data-testid="task-pane"]')?.contains(popup)).toBe(true)
    expect(document.querySelector('[role="dialog"], [aria-modal="true"], [data-slot="sheet-backdrop"]')).toBeNull()
    expect(popup?.textContent).toContain('报告任务')
    expect(popup?.querySelector('[data-testid="task-chat-panel"]')?.parentElement?.getAttribute('data-chat-id')).toBe('task-dm')
    expect(popup?.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-viewport-key')).toBe('assistant:task-chat')
    expect(mocks.dm).toHaveBeenCalledWith('task-agent')
    expect(readAssistantTaskChat('user-1', 'task-agent')?.task.sessionId).toBe('task-session')
    expect(readAssistantTaskChat('different-owner', 'task-agent')).toBeNull()
    await clickElement(popup.querySelector<HTMLElement>('[data-testid="assistant-task-chat-close"]')!)
    expect(document.querySelector('[data-testid="assistant-task-chat-window"]')).toBeNull()
    expect(harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-draft"]')?.value).toBe('未发完的交代')
  })
  it('refuses an agent owned by another person', async () => {
    const open = vi.fn(), toast = vi.fn()
    const contacts = [assistant, { id: 'task-agent', display_name: 'Someone else', avatar: null }].map((contact) => ({ ...contact, bio: null, type: 'agent' as const, owner_user_id: contact.id === 'assistant' ? 'user-1' : 'different-owner' }))
    await renderWithAppProviders(harness, <AssistantTaskChatOpener visible onOpenUserChat={open} />, { contacts: { contacts }, toast })
    act(() => openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows))
    expect(open).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error', 'Task identity is not owned by the signed-in account')
  })
  it('opens a newly spawned agent before its contacts snapshot arrives, after checking its canonical owner', async () => {
    let finish!: (contacts: unknown[]) => void
    mocks.identities.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const contacts = [{ ...assistant, bio: null, type: 'agent' as const, owner_user_id: 'user-1' }]
    const toast = vi.fn()
    await renderWithAppProviders(harness, <><section ref={node => readShellSlots()?.setSlot('assistant:task-chat', node)} /><AssistantTaskChatOpener visible /></>, { contacts: { contacts }, toast })
    act(() => { openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows); openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows) })
    expect(mocks.identities).toHaveBeenCalledOnce()
    expect(mocks.identities).toHaveBeenCalledWith(['task-agent'])
    await act(async () => { finish([{ id: 'task-agent', display_name: '新调研', avatar: null, bio: null, type: 'agent', owner_user_id: 'user-1' }]) })
    expect(document.querySelector('[data-testid="assistant-task-chat-window"]')?.textContent).toContain('新调研')
    expect(toast).not.toHaveBeenCalled()
  })
  it('does not use a freshly read identity owned by someone else', async () => {
    mocks.identities.mockResolvedValue([{ id: 'task-agent', display_name: 'Foreign task', type: 'agent', owner_user_id: 'someone-else' }])
    const toast = vi.fn()
    const contacts = [{ ...assistant, bio: null, type: 'agent' as const, owner_user_id: 'user-1' }]
    await renderWithAppProviders(harness, <AssistantTaskChatOpener visible />, { contacts: { contacts }, toast })
    act(() => openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows))
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), 'error', 'Task identity is not owned by the signed-in account'))
    expect(document.querySelector('[data-testid="assistant-task-chat-window"]')).toBeNull()
  })
})
