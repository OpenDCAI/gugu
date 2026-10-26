// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clickElement, createReactHarness } from '../../../support/testHarness'
import type { AssistantContext } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-context'
vi.mock('react-i18next',async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()),useTranslation: () => ({ t: (key: string) => key,i18n: { language: 'en-US' } }) }))
vi.mock('@/lib/sessionPublication',async original => ({ ...await original<object>(),getRendererSession: () => ({ user: { id: 'owner' } }) }))
const directory = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('@/session/shared/remote-sessions/session-directory',() => ({ useDirectoryDevices: () => [],useLiveDeviceSessions: () => ({}),usePhoneTaskDirectory: () => {},deviceSessionsOf: () => ({}) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-task-directory',() => ({ assistantTaskDeviceLabel: () => 'home',assistantTaskDirectory: () => directory.rows }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store',() => ({ remoteHostsStore: { device: () => null } }))
vi.mock('@renderer/lib/components/agent-status-indicator',() => ({ AgentStatusIndicator: () => null }))
vi.mock('@renderer/lib/hooks/use-toast',() => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@renderer/lib/modal/modal-provider',() => ({ useShowModal: () => vi.fn() }))
vi.mock('@/components/assistant/assistant-app-client',() => ({ reportAssistantAppChange: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data',() => ({ assistantQueryKey: (...keys: unknown[]) => keys }))
const { AssistantTasksPage } = await import('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-tasks')
let harness: ReturnType<typeof createReactHarness>
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions',() => ({ localHomeSessions: { use: () => () => {} } }))
beforeEach(() => { harness = createReactHarness(); directory.rows = [] })
afterEach(() => harness.cleanup())
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
it('retains the formatted title and unread indicator in directory task rows', async () => {
  directory.rows = [{ deviceId: 'home',live: false,summary: { conversationId: 'assistant-session',agent: { userId: 'assistant' } } },{ deviceId: 'home',live: false,summary: { conversationId: 'task',parentConversationId: 'assistant-session',agent: { userId: 'task-agent' },title: 'codex (1)',harness: 'codex',unseen: true,agentStatus: 'idle' } }]
  const marker = { domain: 'tasks',resource_key: '__collection__:home',device_id: 'home',data: { state: 'ready' } }
  const item = { domain: 'tasks',resource_key: 'task',device_id: 'home',data: { sessionId: 'task',title: 'codex (1)',harness: 'codex',unseen: true,status: 'idle' } }
  const client = await render(context({ machineLoading: false,machine: { deviceId: 'home',panel: { deviceId: 'home',collection: async () => [],snapshot: async () => ({ items: [marker,item],application: [] }) } } as never }))
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="assistant-seg-tasks"]')!)
  await act(async () => { await vi.waitFor(() => expect(client.isFetching()).toBe(0)) })
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
