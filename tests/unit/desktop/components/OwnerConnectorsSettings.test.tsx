// @vitest-environment jsdom
import { act,createElement,type ReactNode } from 'react'
import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { clickElement,createReactHarness,renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const fixture = vi.hoisted(() => ({ data: {} as Record<string,unknown>,rows: [] as unknown[],change: vi.fn(async () => ({ status: 'pending' })),
  showSetup: vi.fn(),showGithub: vi.fn(),showConfirm: vi.fn(),retryOperation: vi.fn(async () => {}) }))
vi.mock('@/lib/useAssistantHome',() => ({ useAssistantHome() { throw new Error('Unexpected assistant initialization') } }))
vi.mock('@/hooks/useMobileShell',() => ({ useMobileShell: () => true }))
vi.mock('@/store/devicesContext',() => ({ useDevicesStore: () => ({ devices: [],loading: false,error: null }) }))
vi.mock('@/components/settings/channels/useChatChannels',() => ({ useChatChannels: () => ({ list: null }) }))
vi.mock('@/components/connections/useOwnerLibraryHost',() => ({ useOwnerLibraryHost: () => ({ key: 'owner:scope',remote: null,
  connectionMetadata: { ownerId: 'owner',collection: async () => fixture.rows,change: fixture.change,invalidate: vi.fn(),
    peekSnapshot: () => ({ items: fixture.rows }) } }) }))
vi.mock('@/lib/connectionBridge',() => ({ connectionBridge: () => ({ retryOperation: fixture.retryOperation }) }))
vi.mock('@/session/renderer/features/library/library-host',() => ({ LibraryHostProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/session/renderer/features/integrations/integrations-provider',() => ({ IntegrationsProvider: ({ children }: { children: ReactNode }) => children,
  useIntegrationsContext: () => fixture.data }))
vi.mock('@/session/renderer/features/integrations/integration-icon',() => ({ IntegrationIcon: () => null }))
vi.mock('@/session/renderer/lib/modal/modal-provider',() => ({ useShowModal: (name: string) => name === 'confirmActionModal'
  ? fixture.showConfirm : name === 'githubConnectModal' ? fixture.showGithub : fixture.showSetup }))

import { OwnerConnectorsSettings } from '../../../../apps/desktop/src/components/connections/OwnerConnectorsSettings'
let harness: ReturnType<typeof createReactHarness>,client: QueryClient,sequence = 0
const app = (id: string,custody?: 'platform') => ({ id,name: id === 'github' ? 'GitHub' : '高德地图',description: '说明',catalog: { categoryId: 'dev' },
  icon: { kind: 'svg',variants: [] },auth: { methods: custody ? [{ kind: 'form',custody,fields: [] }] : [] },capabilities: {},abilities: [],playbooks: [],features: [] })
beforeEach(() => {
  harness = createReactHarness(); client = new QueryClient({ defaultOptions: { queries: { retry: false,gcTime: 0 } } }); sequence += 1
  fixture.rows = []; fixture.change.mockClear(); fixture.showSetup.mockClear(); fixture.showGithub.mockClear(); fixture.showConfirm.mockClear(); fixture.retryOperation.mockClear()
  fixture.data = { integrations: [app('github'),app('amap','platform')],configuredConnections: {},checkedConnections: {},connectionStatus: {},
    hasConfiguredConnections: true,configuredConnectionsError: null,connectionCheckError: null,reloadConnections: vi.fn(),connectionOperations: [] }
})
afterEach(() => { harness.cleanup(); client.clear() })
const render = () => renderWithAppProviders(harness,createElement(QueryClientProvider,{ client },createElement(OwnerConnectorsSettings,{ route: { mode: 'owner',epoch: '1',phase: 'stable',acceptingNewOperations: true } })),{ auth: { id: `owner-${sequence}` } })
const q = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

describe('owner connection settings without an assistant or native host', () => {
  it('opens the complete catalog and platform authorization with no assistant/home/selected device', async () => {
    await render()
    expect(q('assistant-connector-github')).toBeTruthy()
    await clickElement(q('assistant-connector-amap'))
    await clickElement(q('assistant-connector-connect'))
    expect(fixture.showSetup).toHaveBeenCalledWith(expect.objectContaining({ integration: 'amap' }))
    expect(fixture.showGithub).not.toHaveBeenCalled()
  })
  it('asks for an actual device before opening native authorization', async () => {
    await render()
    await clickElement(q('assistant-connector-github'))
    await clickElement(q('assistant-connector-connect'))
    expect(harness.container.textContent).toContain('请先选择一台设备')
    expect(fixture.showGithub).not.toHaveBeenCalled()
  })
  it('preserves the exact scoped account when equal account ids exist on two devices', async () => {
    fixture.rows = ['one','two'].map(device => ({ owner_user_id: 'owner',resource_key: JSON.stringify([`device:${device}`,'same-key']),
      source: { scopeKey: `device:${device}`,resourceKey: 'same-key' },device_id: device,revision: '5',data: { providerId: 'github',accountId: 'same-account',displayName: device } }))
    await render(); await clickElement(q('assistant-connector-github'))
    await act(async () => { await vi.waitFor(() => expect(harness.container.textContent).toContain('one')) })
    const disconnect = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '断开连接')!
    await clickElement(disconnect)
    await act(async () => { await fixture.showConfirm.mock.calls[0]![0].onSuccess(); await new Promise(resolve => setTimeout(resolve,0)) })
    await vi.waitFor(() => expect(fixture.change).toHaveBeenCalledExactlyOnceWith(fixture.rows[0],'remove'))
  })
  it('keeps failed reads distinct from an empty My connections list', async () => {
    fixture.data.hasConfiguredConnections = false; fixture.data.configuredConnectionsError = { code: 'not-ready' }
    await render()
    const mine = [...harness.container.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => tab.textContent === '我的连接')!
    await clickElement(mine)
    expect(harness.container.textContent).toContain('连接资料尚未准备好')
    expect(q('connected-apps-empty')).toBeNull()
  })
})
