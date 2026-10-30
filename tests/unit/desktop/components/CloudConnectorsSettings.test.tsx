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
import { useAssistantPanelPage } from '../../../../apps/desktop/src/lib/assistantPanelPage'

vi.mock('@/components/settings/channels/useChatChannels', () => ({ useChatChannels: () => ({ client: null, list: null, status: 'not_open', error: '', refresh: async () => {}, apply: () => {} }) }))
vi.mock('@/lib/assistantPanelBridge',() => ({ useAssistantPanelAccountId: () => 'owner',requireAssistantPanelBridge: () => { throw new Error('Unexpected identity lookup') } }))
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
const showConfirm = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/renderer/lib/modal/modal-provider', () => ({
  useShowModal: (name: string) => (name === 'githubConnectModal' ? showGitHub : name === 'confirmActionModal' ? showConfirm : showSetup),
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
afterEach(() => { harness.cleanup(); showSetup.mockClear(); showGitHub.mockClear(); showConfirm.mockClear() })
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
    expect(connected.textContent).toContain('日程与文档')
    expect([...available.querySelectorAll('.gg-settings-row-title')].map((el) => el.textContent)).toEqual(['GitHub', 'Notion', '微信'])
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

  it.each(['default', '', '  '])('已连接但只有内部账号名 %j：不显示账号行，断开操作放进卡片行', async (displayName) => {
    integrations.value = state({ connectionStatus: { feishu: { displayName } } })
    await render()
    await clickElement(q('assistant-connector-feishu')!)
    const card = q('assistant-connector-connection')!
    expect(card).not.toBeNull()
    expect(card.querySelector('.gg-section-label')).toBeNull()
    expect(card.textContent).not.toContain('账号')
    expect(card.textContent).not.toContain('default')
    expect(q('assistant-connector-disconnect')!.closest('.gg-settings-row')).not.toBeNull()
  })

  it('已连接详情保留实际账号或组织名', async () => {
    integrations.value = state({ connectionStatus: { feishu: { displayName: '研究团队' } } })
    await render()
    await clickElement(q('assistant-connector-feishu')!)
    expect(q('assistant-connector-connection')!.textContent).toContain('研究团队')
  })

  it('每行只有一个详情入口，不再逐行放连接按钮或未连接状态', async () => {
    integrations.value = state()
    await render()
    expect(q('assistant-connect-notion')).toBeNull()
    expect(q('assistant-connector-notion')!.querySelectorAll('button')).toHaveLength(0)
    expect(q('assistant-connector-notion')!.textContent).not.toContain('未连接')
    await clickElement(q('assistant-connector-notion')!)
    expect(q('assistant-connector-detail')).not.toBeNull()
  })

  it('授权失效与网络检查失败分开处理,检查失败只重查', async () => {
    integrations.value = state({ checkedConnections: { feishu: { connected: false, errorType: 'authorization_expired' } } })
    await render()
    expect(q('assistant-connector-feishu')!.textContent).toContain('需要重新授权')
    expect(q('assistant-connect-feishu')).toBeNull()
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

  it.each(['github', 'feishu', 'notion', 'wechat'])('uses the panel toolbar for the %s detail without a content breadcrumb', async id => {
    integrations.value = state()
    function Toolbar() { const page = useAssistantPanelPage(); return page ? <button data-testid="toolbar-back" onClick={page.back}>Back</button> : null }
    await renderNode(<><Toolbar /><HomeConnectorsSettings home={here} assistantName="小咕" panelNavigation /></>)
    await clickElement(q(`assistant-connector-${id}`)!)
    expect(q('assistant-connector-detail')).not.toBeNull()
    expect(q('assistant-connector-back')).toBeNull()
    await clickElement(q('toolbar-back')!)
    expect(q(`assistant-connector-${id}`)).not.toBeNull()
    expect(q('toolbar-back')).toBeNull()
  })

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

it('keeps existing application rows visible when background refresh fails',async () => {
  integrations.value=state()
  await render()
  integrations.value=state({hasList:false,listError:Object.assign(new Error('snapshot'),{code:'collection-unavailable'})})
  await render()
  expect(q('assistant-connector-feishu')).not.toBeNull()
  expect(harness.container.querySelector('[role="status"]')).not.toBeNull()
})
it('ends an unresolved initial application read after fifteen seconds',async () => {
  vi.useFakeTimers()
  try {
    integrations.value=state({integrations:[],hasList:false})
    await render()
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001)})
    expect(harness.container.textContent).toContain('这部分内容暂时读不出来')
  } finally { vi.useRealTimers() }
})

it('disconnects only the data purpose after confirmation, leaving chat management independent', async () => {
  const disconnectIntegration = vi.fn(async () => ({ success: true }))
  integrations.value = state({ disconnectIntegration })
  await render()
  await clickElement(q('assistant-connector-feishu')!)
  expect(q('assistant-app-chat-feishu')).toBeNull()
  expect(harness.container.textContent).not.toContain('让它读写飞书')
  expect(harness.container.textContent).not.toContain('此应用暂未开放聊天连接')
  await clickElement(q('assistant-connector-disconnect')!)
  expect(disconnectIntegration).not.toHaveBeenCalled()
  await act(async () => { showConfirm.mock.calls[0]![0].onSuccess() })
  expect(disconnectIntegration).toHaveBeenCalledWith('feishu')
  expect(q('assistant-app-chat-feishu')).toBeNull()
})

it.each([{items:LIST},{items:[]}])('silently keeps saved applications or a known empty catalog when a background network read fails',async({items})=>{
 integrations.value=state({integrations:items,listError:Object.assign(new Error('offline'),{code:'transport-failed'})})
 await render()
 expect(q('assistant-connector-feishu')!==null).toBe(items.length>0)
 expect(harness.container.querySelector('[role="status"]')).toBeNull()
})
