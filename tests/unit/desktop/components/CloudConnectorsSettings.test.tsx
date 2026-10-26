import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
// @vitest-environment jsdom
// 全局设置「咕咕 → 连接应用 · 云端」那一段(会话页画,资源库「集成」的同一份数据):已连接 / 可用两组,点一行进详情,
// 详情的主按钮开的是同一个连接弹窗;读不到如实说读不到,❌ 画空列表。
import { act, createElement } from 'react'
import { observable, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

vi.mock('@/lib/myAssistant',() => ({ useMyAssistant: () => ({ agentId: 'a1',error: null }) }))
vi.mock('@/components/assistant/assistant-panel-files',() => ({ ASSISTANT_PANEL_CHANGED: 'panel-changed',useCloudAssistantFiles: () => ({ panel: { ownerId: 'owner',assistantId: 'a1' } }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell',() => ({ useAssistantShell: () => ({ assistant: { id: 'a1' },chatId: 'dm' }) }))
const integrations = vi.hoisted(() => ({
  value: null as unknown,
}))
const remoteState = vi.hoisted(() => ({ device: null as null | { isOnline: boolean; lastSeenAt: null; hostKind: string } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider', () => ({
  IntegrationsProvider: ({ children }: { children: unknown }) => children,
  useIntegrationsContext: () => integrations.value,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/integrations/integration-icon', () => ({
  IntegrationIcon: ({ provider }: { provider: string }) => createElement('i', { 'data-icon': provider }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host', () => ({
  useLibraryHost: () => ({ remote: { deviceId: 'cloud-1' } }),
  LibraryHostProvider: ({ children }: { children: unknown }) => children,
  createRemoteLibraryHost: (info: { deviceId: string; online: boolean }) => ({ key: `host:${info.deviceId}`, deviceId: info.deviceId, remote: info }),
  LOCAL_LIBRARY_HOST: { key: 'local', deviceId: null },
  isTooOld: (error: unknown) => (error as { code?: unknown } | null)?.code === 'unknown_method',
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { device: () => remoteState.device, pickFolder: vi.fn(), matchServerVersion: vi.fn(async () => true) },
}))
const showSetup = vi.hoisted(() => vi.fn())
const showGitHub = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/lib/modal/modal-provider', () => ({
  useShowModal: (name: string) => (name === 'githubConnectModal' ? showGitHub : showSetup),
}))

const { CloudConnectorsSettings, HomeConnectorsSettings } = await import('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-connectors-settings')

const LIST = [
  { id: 'github', name: 'GitHub', description: '代码托管', icon: null },
  { id: 'feishu', name: '飞书', description: '日程与文档', icon: null },
  { id: 'notion', name: 'Notion', description: '笔记', icon: null },
]
const state = (over: Record<string, unknown> = {}) => ({
  integrations: LIST,
  configuredConnections: { feishu: true },
  connectionStatus: { feishu: { displayName: '示例用户' } },
  checkedConnections: { feishu: { connected: true } },
  connectionCheckError: null,
  hasConfiguredConnections: true,
  configuredConnectionsError: null,
  reloadConnections: vi.fn(),
  hasList: true,
  listError: null,
  reloadList: vi.fn(),
  isCheckingConfiguredConnections: false,
  ...over,
})

let harness: ReturnType<typeof createReactHarness>
let queryClient: QueryClient
const renderNode = (node: ReactNode) => harness.render(createElement(QueryClientProvider,{ client: queryClient },node))
beforeEach(() => {
  harness = createReactHarness()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false,gcTime: 0 } } })
  remoteState.device = observable({ isOnline: true, lastSeenAt: null, hostKind: 'cloud' })
})
afterEach(() => { harness.cleanup(); showSetup.mockClear(); showGitHub.mockClear() })
const q = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const render = () => renderNode(createNode(CloudConnectorsSettings, { cloudDeviceId: 'cloud-1', assistantName: '小咕' }))

describe('咕咕 · 连接应用 · 云端', () => {
  it('宿主离线后恢复在线,不重新打开页面也恢复连接列表', async () => {
    integrations.value = state()
    remoteState.device!.isOnline = false
    await render()
    expect(q('assistant-connector-feishu')).not.toBeNull()
    await act(async () => { runInAction(() => { remoteState.device!.isOnline = true }) })
    expect(q('assistant-connector-feishu')).not.toBeNull()
    await act(async () => { runInAction(() => { remoteState.device!.isOnline = false }) })
    expect(q('assistant-connector-feishu')).not.toBeNull()
  })
  it('已连接的在上、可用的在下,一行一家;已连接那行说出连的是谁', async () => {
    integrations.value = state()
    await render()
    const connected = q('assistant-connectors-connected')!
    const available = q('assistant-connectors-available')!
    expect([...connected.querySelectorAll('.gg-settings-row-title')].map((el) => el.textContent)).toEqual(['飞书'])
    expect(connected.textContent).toContain('示例用户')
    expect([...available.querySelectorAll('.gg-settings-row-title')].map((el) => el.textContent)).toEqual(['GitHub', 'Notion'])
  })

  it('点一行进详情:没连的主按钮是「连接」,GitHub 走它自己的弹窗,其余走通用设置弹窗;「连接应用」回列表', async () => {
    integrations.value = state()
    await render()
    await clickElement(q('assistant-connector-github')!)
    expect(q('assistant-connector-detail')).not.toBeNull()
    const connect = q('assistant-connector-connect')!
    expect(connect.textContent).toBe('连接')
    await clickElement(connect)
    expect(showGitHub).toHaveBeenCalledTimes(1)
    expect(showSetup).not.toHaveBeenCalled()
    await clickElement(q('assistant-connector-back')!)
    expect(q('assistant-connectors-available')).not.toBeNull()
    await clickElement(q('assistant-connector-notion')!)
    await clickElement(q('assistant-connector-connect')!)
    expect(showSetup).toHaveBeenCalledWith(expect.objectContaining({ integration: 'notion' }))
  })

  it('已连接的详情主按钮是「管理连接」', async () => {
    integrations.value = state()
    await render()
    await clickElement(q('assistant-connector-feishu')!)
    expect(q('assistant-connector-connect')!.textContent).toBe('管理连接')
  })

  it('列表直接连接,不经过详情页', async () => {
    integrations.value = state()
    await render()
    await clickElement(q('assistant-connect-notion')!)
    expect(showSetup).toHaveBeenCalledWith(expect.objectContaining({ integration: 'notion' }))
    expect(q('assistant-connector-detail')).toBeNull()
  })

  it('授权失效与网络检查失败分开处理,检查失败只重查', async () => {
    integrations.value = state({ checkedConnections: { feishu: { connected: false, errorType: 'authorization_expired' } } })
    await render()
    expect(q('assistant-connector-feishu')!.textContent).toContain('需要重新授权')
    expect(q('assistant-connect-feishu')!.textContent).toBe('重新连接')
    const reloadConnections = vi.fn()
    integrations.value = state({ connectionCheckError: new Error('offline'), reloadConnections })
    await render()
    expect(q('assistant-connector-feishu')!.textContent).toContain('检查没通过')
    await clickElement(q('assistant-connector-feishu')!)
    expect(q('assistant-connector-connect')!.textContent).toBe('重新连接')
    await clickElement(q('assistant-connector-connect')!)
    expect(reloadConnections).not.toHaveBeenCalled()
    expect(showSetup).toHaveBeenCalled()
  })

  it('读不到列表:如实说读失败并给重试,❌ 画一张空的「可用」', async () => {
    const reloadList = vi.fn()
    integrations.value = state({ integrations: [], hasList: false, listError: 'boom', reloadList })
    await render()
    expect(harness.container.textContent).toContain('暂时读不到')
    expect(q('assistant-connectors-available')).toBeNull()
  })
})

describe('咕咕 · 连接应用 · 住在电脑上(非会员)', () => {
  const here = { kind: 'computer', deviceId: 'mac-1', thisDevice: true, label: 'MacBook', online: true, known: true } as const

  it('账号授权明确写保存设备MacBook,详情说明当前电脑可用,不写云端', async () => {
    integrations.value = state()
    await renderNode(createNode(HomeConnectorsSettings, { home: here, assistantName: '小咕' }))
    expect(harness.container.textContent).toContain('授权保存在：MacBook（本机）')
    expect(harness.container.textContent).not.toContain('云端')
    await clickElement(q('assistant-connector-feishu')!)
    const detail = q('assistant-connector-detail')!
    expect(detail.textContent).toContain('这台电脑')
    expect(detail.textContent).not.toContain('云端')
  })

  it('点连接弹的是这台电脑的库(LOCAL),不是云端宿主', async () => {
    integrations.value = state()
    await renderNode(createNode(HomeConnectorsSettings, { home: here, assistantName: '小咕' }))
    await clickElement(q('assistant-connector-notion')!)
    await clickElement(q('assistant-connector-connect')!)
    expect(showSetup).toHaveBeenCalledWith(expect.objectContaining({ integration: 'notion', host: expect.objectContaining({ key: 'assistant-panel:owner:a1' }) }))
  })
})
