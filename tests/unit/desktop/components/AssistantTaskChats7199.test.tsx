// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { clickElement, createReactHarness, renderWithAppProviders, device } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const mocks = vi.hoisted(() => ({ devices: [] as Device[], phones: [] as Device[], rows: [] as { deviceId: string; summary: SessionpageSessionSummary; live: boolean }[], localWorker: false, listed: true, transport: vi.fn(), identities: vi.fn(),work:vi.fn(),wake:vi.fn(),refresh:null as null|(()=>void) }))
vi.mock('../../../../apps/desktop/src/hooks/useWakeCloudComputer',()=>({useCloudComputerWake:(target:unknown)=>{mocks.wake(target);return {issue:null,dropped:false,retry:vi.fn()}}}))
vi.mock('../../../../apps/desktop/src/lib/assistantWork',()=>({assistantWorkCloud:{get:mocks.work},watchAssistantWork:(_o:string,_a:string,refresh:()=>void)=>{mocks.refresh=refresh;return ()=>{}}}))
vi.mock('../../../../apps/desktop/src/components/assistant/TaskExchangeBubble',()=>({TaskExchangeBubble:({message}:{message:{content:string}})=><div>{message.content}</div>}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', async original => ({ ...await original<object>(), readRequiredDisplayIdentities: mocks.identities }))
// The window shows the task's session through the phone task page (PeekSessionTimeline); its own reads are covered there.
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/PeekSessionTimeline', () => ({ PeekSessionTimeline: ({ sessionId, local, onBack, fallback }: { sessionId: string; local?: boolean; onBack: () => void; fallback?: React.ReactNode }) =>
  mocks.listed ? <div data-testid="task-chat-panel" data-session-id={sessionId} data-local={String(!!local)}><button type="button" data-testid="assistant-task-chat-close" onClick={onBack} /></div> : <>{fallback}</> }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: mocks.devices.map((device) => device.device_id === 'worker' ? { ...device, is_current_device: device.is_current_device || mocks.localWorker } : device), phones: mocks.phones }) }))
vi.mock('../../../../apps/desktop/src/components/assistant/taskExchangeTransport', () => ({ taskExchangeTransport: mocks.transport }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { allListedSessions: () => mocks.rows, device: () => ({ label: 'Worker' }) } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions', () => ({
  homeTarget: () => 'home', homeSessions: () => ({ sessions: mocks.rows.map((row) => row.summary), live: true }), localHomeSessions: { loaded: false, sessions: [], error: null },
}))

import { AssistantTaskChatOpener } from '../../../../apps/desktop/src/components/assistant/AssistantTaskChatOpener'
import { OPEN_ASSISTANT_TASK_CHAT,openAssistantTaskChat, readAssistantTaskChat, showAssistantTaskChat } from '../../../../apps/desktop/src/lib/assistantTaskChat'
import { installAssistantShellBridge } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { publishDirectoryDevices, retainDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

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
  mocks.listed = true
  mocks.identities.mockReset()
  mocks.work.mockReset();mocks.wake.mockReset();mocks.refresh=null
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
  for (const row of mocks.rows) updateDeviceSessions(row.deviceId, { sessions: [row.summary], cached: false, connected: true, loading: false, error: null })
})
afterEach(() => { harness.cleanup(); showAssistantTaskChat(null); retainDeviceSessions([]); publishDirectoryDevices([]) })

describe('assistant task rows open the task chat on both shells', () => {
  it('retains a cloud task click while the assistant shell is still mounting its pane',async()=>{
    mocks.work.mockReturnValue(new Promise(()=>{}))
    await renderWithAppProviders(harness,<AssistantTaskChatOpener visible={false}/>)
    await act(async()=>{window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:{workId:'mounting-work',title:'Opening task',assistantId:'assistant',taskAgentId:'new-agent',task:{sessionId:'mounting',deviceId:'worker'},assistants:[]}}))})
    expect(readAssistantTaskChat('user-1','new-agent')).toMatchObject({workId:'mounting-work'})
  })
  it('shows an old completed task and its original file even when no executor identity can be loaded',async()=>{
    const work={work_id:'history-only-work',title:'Original file task',assistant_user_id:'assistant',owner_user_id:'user-1',outcome:'completed',executor_outcomes:{},executors:[{session_id:'historical',device_id:'offline',agent_user_id:null}],coordinator_session_id:'main',coordinator_device_id:'home'}
    mocks.work.mockResolvedValue({work,events:[{work_id:work.work_id,message_id:'result-event',kind:'completed',source_available:true,source_message_id:null,content:'Verified original result',attachment_refs:[{attachment_id:'10000000-0000-4000-8000-000000000001',file_name:'original.txt',sha256:'a'.repeat(64),size_bytes:21,content_type:'text/plain'}],from_session_id:'historical',to_session_id:'main',platform_received_at:'2026-10-26T08:00:00Z'}]})
    await renderWithAppProviders(harness,<><section ref={node=>readShellSlots()?.setSlot('assistant:task-chat',node)}/><AssistantTaskChatOpener visible/></>)
    await act(async()=>{window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:{workId:work.work_id,title:work.title,assistantId:'assistant',taskAgentId:null,task:{sessionId:'historical',deviceId:'offline'},assistants:[]}}))})
    await vi.waitFor(()=>expect(document.querySelector('[data-testid="task-cloud-history"]')?.textContent).toContain('original.txt'))
    const pane=document.querySelector('[data-testid="assistant-task-chat-window"]')!
    expect(pane.textContent).toContain('已完成')
    expect(pane.textContent).toContain('Verified original result')
    expect(pane.textContent).not.toContain('正在开始')
    expect(mocks.identities).not.toHaveBeenCalled()
    expect(mocks.transport).not.toHaveBeenCalled()
  })
  it('opens a sleeping cloud computer task as its session, waking the host',async()=>{
    const work={work_id:'sleeping-work',title:'Sleeping task',assistant_user_id:'assistant',owner_user_id:'user-1',outcome:'completed',executor_outcomes:{},executors:[{session_id:'task-session',device_id:'worker',agent_user_id:'task-agent'}],coordinator_session_id:'main',coordinator_device_id:'home'}
    mocks.work.mockResolvedValue({work,events:[]})
    mocks.devices=[device('worker',[],{is_online:true,cloud_computer:'asleep'})]
    const contacts=[assistant,{id:'task-agent',display_name:'Task',avatar:null}].map(row=>({...row,type:'agent' as const,owner_user_id:'user-1',bio:null}))
    await renderWithAppProviders(harness,<><section ref={node=>readShellSlots()?.setSlot('assistant:task-chat',node)}/><AssistantTaskChatOpener visible/></>,{contacts:{contacts}})
    const request={workId:work.work_id,title:work.title,assistantId:'assistant',taskAgentId:'task-agent',task:{sessionId:'task-session',deviceId:'worker'},assistants:[{sessionId:'main',deviceId:'home'}]}
    await act(async()=>{window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:request}))})
    await vi.waitFor(()=>expect(document.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-session-id')).toBe('task-session'))
    expect(mocks.wake).toHaveBeenCalledWith(expect.objectContaining({device_id:'worker',cloud_computer:'asleep'}))
    // A cloud computer is another machine: its session is read over device RPC, never as this computer's.
    expect(document.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-local')).toBe('false')
  })
  it('shows a prepared account task immediately, then connects when its real agent is admitted',async()=>{
    let finish!:(value:unknown)=>void
    mocks.work.mockReturnValue(new Promise(resolve=>{finish=resolve}))
    mocks.identities.mockResolvedValue([{id:'task-agent',display_name:'New agent',type:'agent',owner_user_id:'user-1',avatar:null}])
    const toast=vi.fn(),contacts=[{...assistant,type:'agent' as const,owner_user_id:'user-1',bio:null}]
    await renderWithAppProviders(harness,<><section ref={node=>readShellSlots()?.setSlot('assistant:task-chat',node)}/><AssistantTaskChatOpener visible/></>,{contacts:{contacts},toast})
    await act(async()=>{window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_TASK_CHAT,{detail:{workId:'new-work',title:'Preparing task',assistantId:'assistant',taskAgentId:null,task:{sessionId:'prepared',deviceId:'sleeping'},assistants:[{sessionId:'main',deviceId:'home'}]}}))})
    const pane=document.querySelector('[data-testid="assistant-task-chat-window"]')
    expect(pane?.textContent).toContain('Preparing task')
    expect(pane?.textContent).toContain('正在开始')
    const work={work_id:'new-work',title:'Preparing task',assistant_user_id:'assistant',owner_user_id:'user-1',outcome:'active',executor_outcomes:{},executors:[{session_id:'prepared',device_id:'sleeping',agent_user_id:null}],coordinator_session_id:'main',coordinator_device_id:'home'}
    await act(async()=>finish({work,events:[]}))
    mocks.work.mockResolvedValue({work:{...work,executors:[{session_id:'prepared',device_id:'sleeping',agent_user_id:'task-agent'}]},events:[]})
    await act(async()=>{mocks.refresh?.()})
    await vi.waitFor(()=>expect(document.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-session-id')).toBe('prepared'))
    expect(toast).not.toHaveBeenCalled()
    expect(mocks.transport).not.toHaveBeenCalled()
  })
  // Cloud task list and offline history contracts are covered by
  // AssistantAccountTaskLists / AssistantWorkHistory. Device-directory and
  // manual transcript retry cases no longer describe this pane's data source.
  it('opens the task chat inside its pane without a modal or shell navigation, and returns to the same draft', async () => {
    const open = vi.fn()
    const contacts = [assistant, { id: 'task-agent', display_name: '报告任务', avatar: null }].map((contact) => ({ ...contact, bio: null, type: 'agent' as const, owner_user_id: 'user-1' }))
    await renderWithAppProviders(harness, <><input data-testid="assistant-draft" defaultValue="未发完的交代" /><section data-testid="task-pane" ref={(node) => readShellSlots()?.setSlot('assistant:task-chat', node)} /><AssistantTaskChatOpener visible /></>, { contacts: { contacts } })
    act(() => openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows))
    expect(open).not.toHaveBeenCalled()
    const popup = document.querySelector<HTMLElement>('[data-testid="assistant-task-chat-window"]')!
    expect(harness.container.querySelector('[data-testid="task-pane"]')?.contains(popup)).toBe(true)
    expect(document.querySelector('[role="dialog"], [aria-modal="true"], [data-slot="sheet-backdrop"]')).toBeNull()
    expect(popup?.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-session-id')).toBe('task-session')
    expect(popup?.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-local')).toBe('false')
    expect(readAssistantTaskChat('user-1', 'task-agent')?.task.sessionId).toBe('task-session')
    expect(readAssistantTaskChat('different-owner', 'task-agent')).toBeNull()
    await clickElement(popup.querySelector<HTMLElement>('[data-testid="assistant-task-chat-close"]')!)
    expect(document.querySelector('[data-testid="assistant-task-chat-window"]')).toBeNull()
    expect(harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-draft"]')?.value).toBe('未发完的交代')
  })
  it('reads a task on this computer over IPC, the way the assistant progress footnote does', async () => {
    mocks.localWorker = true
    const contacts = [assistant, { id: 'task-agent', display_name: '本机任务', avatar: null }].map((contact) => ({ ...contact, bio: null, type: 'agent' as const, owner_user_id: 'user-1' }))
    await renderWithAppProviders(harness, <><section ref={(node) => readShellSlots()?.setSlot('assistant:task-chat', node)} /><AssistantTaskChatOpener visible /></>, { contacts: { contacts } })
    act(() => openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows))
    expect(document.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-local')).toBe('true')
  })
  it('keeps its own header and a loading state until the task session is listed', async () => {
    mocks.listed = false
    const contacts = [assistant, { id: 'task-agent', display_name: '报告任务', avatar: null }].map((contact) => ({ ...contact, bio: null, type: 'agent' as const, owner_user_id: 'user-1' }))
    await renderWithAppProviders(harness, <><section ref={(node) => readShellSlots()?.setSlot('assistant:task-chat', node)} /><AssistantTaskChatOpener visible /></>, { contacts: { contacts } })
    act(() => openAssistantTaskChat('assistant', mocks.rows[1]!, mocks.rows))
    const pane = document.querySelector<HTMLElement>('[data-testid="assistant-task-chat-window"]')!
    expect(pane.textContent).toContain('报告任务')
    await clickElement(pane.querySelector<HTMLElement>('[data-testid="assistant-task-chat-close"]')!)
    expect(document.querySelector('[data-testid="assistant-task-chat-window"]')).toBeNull()
  })
  it('refuses an agent owned by another person', async () => {
    const open = vi.fn(), toast = vi.fn()
    const contacts = [assistant, { id: 'task-agent', display_name: 'Someone else', avatar: null }].map((contact) => ({ ...contact, bio: null, type: 'agent' as const, owner_user_id: contact.id === 'assistant' ? 'user-1' : 'different-owner' }))
    await renderWithAppProviders(harness, <AssistantTaskChatOpener visible />, { contacts: { contacts }, toast })
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
    expect(document.querySelector('[data-testid="task-chat-panel"]')?.getAttribute('data-session-id')).toBe('task-session')
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
