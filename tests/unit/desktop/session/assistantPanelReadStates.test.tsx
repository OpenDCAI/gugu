// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickElement, createReactHarness } from '../../../support/testHarness'
import type { AssistantContext } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-context'
import type {AssistantPanelBridge,AssistantPanelWindow} from '../../../../apps/desktop/src/lib/assistantPanelBridge'
import type {AssistantWorkTask} from '@gugu/core/cloud/assistantWork'
vi.mock('react-i18next',async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()),useTranslation: () => ({ t: (key: string) => key,i18n: { language: 'en-US' } }) }))
vi.mock('@/lib/sessionPublication',() => ({ getRendererSession: () => ({ user: { id: 'owner' } }),getRendererAccessToken: () => null }))
vi.mock('@/session/shared/remote-sessions/session-directory',() => ({ useDirectoryDevices: () => [] }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store',() => ({ remoteHostsStore: { device: () => null } }))
vi.mock('@renderer/lib/components/agent-status-indicator',() => ({ AgentStatusIndicator: () => null }))
vi.mock('@renderer/lib/hooks/use-toast',() => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@renderer/lib/modal/modal-provider',() => ({ useShowModal: () => vi.fn() }))
vi.mock('@/components/assistant/assistant-app-client',() => ({ reportAssistantAppChange: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data',() => ({ assistantQueryKey: (...keys: unknown[]) => keys }))
const { AssistantTasksPage } = await import('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-tasks')
let harness: ReturnType<typeof createReactHarness>
let tasks:AssistantWorkTask[]=[]
beforeEach(() => { harness = createReactHarness();tasks=[]
  ;(window as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__={accountId:()=> 'owner',subscribeAccount:()=>()=>{},
    work:{client:{listAll:async()=>tasks},watch:()=>()=>{},presence:()=>({reading:{status:'idle'},payload:{agentType:'codex'},local:{unseen:true}}),subscribePresence:()=>()=>{}}} as unknown as AssistantPanelBridge
})
afterEach(() => {harness.cleanup();delete (window as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__})
const context = (patch: Partial<AssistantContext> = {}) => ({ assistant: { id: 'assistant',display_name: 'Assistant' },chatId: 'chat',homeDeviceId: 'home',
  home: { kind: 'cloud',deviceId: 'home' },readiness: 'ready',machineLoading: true,machineError: null,route: { tab: 'tasks' },askInChat: vi.fn(),go: vi.fn(),retryMachine: vi.fn(),...patch }) as AssistantContext
async function render(value: AssistantContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false,gcTime: 0 } } })
  await harness.render(createElement(QueryClientProvider,{ client },createElement(AssistantTasksPage,{ context: value })))
  return client
}
it('does not turn a disabled scheduled-task query into an empty list', async () => {
  await render(context())
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!)
  expect(harness.container.textContent).not.toContain('routines.emptyTitle')
  expect(harness.container.querySelector('[data-testid="loading-indicator"]')).not.toBeNull()
})
it('does not turn a disabled routine-detail query into a missing item', async () => {
  await render(context({ route: { tab: 'tasks',sub: 'routine:example' } }))
  expect(harness.container.textContent).not.toContain('routines.goneTitle')
  expect(harness.container.querySelector('[data-testid="loading-indicator"]')).not.toBeNull()
})
it('retains the formatted title and unread indicator in cloud task rows', async () => {
  tasks=[{work_id:'format-title',title:'codex (1)',coordinator_session_id:'assistant-session',coordinator_device_id:'home',executors:[{session_id:'task',device_id:'home',agent_user_id:'worker'}],executor_outcomes:{},outcome:'completed',updated_at:'2026-10-26T08:00:00Z'}] as AssistantWorkTask[]
  const client = await render(context())
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-tasks"]')!)
  await act(async () => { await vi.waitFor(() => {expect(client.isFetching()).toBe(0);expect(harness.container.textContent).toContain('Codex (1)')}) })
  expect(harness.container.textContent).toContain('Codex (1)')
  expect(harness.container.querySelector('.ta-unseen')).not.toBeNull()
})

it('names a failed schedule read instead of rendering the empty schedule list', async () => {
  const client = await render(context({ machineLoading: false,machine: { deviceId: 'home',panel: { collection: async () => { throw Object.assign(new Error('private server detail'),{ code: 'collection-unavailable' }) } } } as never }))
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!)
  await act(async () => {
    await vi.waitFor(() => expect(client.isFetching()).toBe(0))
    await new Promise(resolve => setTimeout(resolve,0))
  })
  expect(harness.container.textContent).toContain('routines.loadFailed')
  expect(harness.container.textContent).not.toContain('routines.emptyTitle')
  expect(harness.container.querySelector('[role="alert"]')).not.toBeNull()
})

it('silently preserves a previously read empty schedule list during network recovery',async()=>{
 vi.useFakeTimers()
 let client:QueryClient|undefined
 try {
  const collection=vi.fn().mockResolvedValueOnce([]).mockRejectedValue(new TypeError('network unavailable'))
  client=await render(context({machineLoading:false,machine:{deviceId:'home',panel:{collection}} as never}))
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-scheduled"]')!)
  await act(async()=>{await vi.advanceTimersByTimeAsync(0)})
  expect(harness.container.textContent).toContain('routines.emptyTitle')
  await act(async()=>{void client!.invalidateQueries({queryKey:['home','schedules']});await vi.advanceTimersByTimeAsync(6000)})
  expect(collection.mock.calls.length).toBeGreaterThan(1)
  expect(harness.container.textContent).toContain('routines.emptyTitle')
  expect(harness.container.textContent).not.toContain('routines.loadFailed')
  expect(harness.container.querySelector('[role="alert"],[role="status"]')).toBeNull()
 }finally{client?.clear();vi.useRealTimers()}
})
