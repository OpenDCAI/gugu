import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { AgentConnectionDetails } from '@renderer/features/settings/agents-page/AgentConnectionDetails'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

const mocks = vi.hoisted(() => ({
  connections: [] as HarnessConnection[],
  select: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  login: vi.fn(),
  catalog: vi.fn()
}))
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { agents: {} },
  rpcOn: () => ({ agents: {} }),
  events: { on: () => () => {} },
  onMachineEvent: () => () => {}
}))
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => mocks.login }))
vi.mock('@renderer/features/sessions/session-config/platform-model-catalog', () => ({
  usePlatformModelCatalog: () => ({ models: [{ id: 'test-model' }], settled: true })
}))
vi.mock('@renderer/lib/stores/use-harness-model-catalog', () => ({
  forceRefreshHarnessModelCatalog: () => mocks.catalog()
}))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    listConnections: async () => ({ success: true, data: mocks.connections }),
    refreshAuthStatus: async ({ connectionId }: { connectionId?: string }) => ({
      success: true,
      data:
        connectionId === 'other'
          ? { kind: 'authenticated', account: 'other@example.test' }
          : { kind: 'unauthenticated' }
    }),
    readSubscription: async () => ({ success: true, data: { payer: 'not-signed-in' } }),
    readSubscriptionUsage: async () => ({
      success: true,
      data: { kind: 'unavailable', reason: 'not-signed-in' }
    }),
    selectConnection: async (input: { connectionId: string }) => {
      mocks.select(input)
      mocks.connections = mocks.connections.map((c) => ({
        ...c,
        current: c.id === input.connectionId
      }))
      return { success: true }
    },
    removeConnection: async (input: { connectionId: string }) => {
      mocks.remove(input)
      mocks.connections = mocks.connections.filter((c) => c.id !== input.connectionId)
      return { success: true }
    },
    createConnection: async (input: unknown) => {
      mocks.create(input)
      return { success: true, data: { id: 'new-account', kind: (input as { kind: string }).kind } }
    }
  })
}))
let root: Root, host: HTMLDivElement, client: QueryClient
const agent = {
  id: 'codex',
  name: 'Codex',
  status: 'available',
  reading: 'installed',
  capabilities: {
    auth: {
      kind: 'supported',
      methods: [{ id: 'codex-login', kind: 'cli-login', name: 'ChatGPT', args: ['login'] }]
    }
  }
} as AgentPayload
beforeEach(() => {
  mocks.connections = [
    { id: 'native', kind: 'native', name: 'CLI', current: true },
    { id: 'other', kind: 'account', name: 'Other account', current: false }
  ]
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  host.style.width = '528px'
  document.body.appendChild(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root.render(
    <QueryClientProvider client={client}>
      <SessionLocalizationProvider>
        <AgentConnectionDetails agent={agent} machine={null} />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
})
afterEach(() => {
  root.unmount()
  client.clear()
  host.remove()
  vi.clearAllMocks()
})
async function open() {
  await userEvent.click(page.getByRole('combobox', { name: 'Current connection', exact: true }))
}
it('keeps native configuration neutral and switches through the real select', async () => {
  await until(
    'native connection loads',
    () => host.textContent?.includes('Existing CLI configuration') === true
  )
  expect(host.textContent).toContain('Gugu models are available')
  expect(host.textContent).not.toContain('Not signed in')
  await open()
  await userEvent.click(page.getByRole('option', { name: /Other account/ }))
  await until('switch commits', () => mocks.select.mock.calls.length === 1)
  expect(mocks.select).toHaveBeenCalledWith({ providerId: 'codex', connectionId: 'other' })
  await until(
    'selected connection updates',
    () =>
      page
        .getByRole('combobox', { name: 'Current connection', exact: true })
        .query()
        ?.textContent?.includes('Other account') === true
  )
})
it('retains removal of an inactive account inside its existing options menu', async () => {
  await until(
    'native connection loads',
    () => host.textContent?.includes('Existing CLI configuration') === true
  )
  await open()
  await userEvent.click(
    page.getByRole('button', { name: 'Options for Other account', exact: true })
  )
  await userEvent.click(page.getByRole('menuitem', { name: 'Remove', exact: true }))
  await until('remove commits', () => mocks.remove.mock.calls.length === 1)
  expect(mocks.remove).toHaveBeenCalledWith({ providerId: 'codex', connectionId: 'other' })
  expect(mocks.select).not.toHaveBeenCalled()
})
it('adds an account from the inline form and only then opens the existing login flow', async () => {
  await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))
  expect(mocks.login).not.toHaveBeenCalled()
  await userEvent.click(page.getByRole('button', { name: 'Add and sign in', exact: true }))
  await until('account creation commits', () => mocks.create.mock.calls.length === 1)
  expect(mocks.create.mock.calls[0][0]).toMatchObject({ providerId: 'codex', kind: 'account' })
  await until('existing sign-in opens', () => mocks.login.mock.calls.length === 1)
  expect(mocks.login.mock.calls[0][0]).toMatchObject({
    providerId: 'codex',
    connectionId: 'new-account'
  })
})

it('saves an API connection without starting account authentication', async () => {
  await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))
  await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }))
  await userEvent.fill(
    page.getByRole('textbox', { name: 'API Key', exact: true }),
    'test-key-not-a-credential'
  )
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until('API creation commits', () => mocks.create.mock.calls.length === 1)
  expect(mocks.create.mock.calls[0][0]).toMatchObject({
    providerId: 'codex',
    kind: 'api-key',
    apiKey: 'test-key-not-a-credential'
  })
  expect(mocks.login).not.toHaveBeenCalled()
})

it('aligns the connection group heading with the card edge', async () => {
  await until('connection section is mounted', () => !!host.querySelector('.gg-section-label span'))
  const heading = host.querySelector('.gg-section-label span')!
  const card = host.querySelector('.gg-settings-card')!
  expect(heading.getBoundingClientRect().left).toBeCloseTo(card.getBoundingClientRect().left, 1)
})
