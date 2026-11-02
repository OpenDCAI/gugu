// @vitest-environment jsdom
// owner 10-16「只有一个设置:咕咕的设置是全局设置里的一组,咕咕页里的齿轮直接开到这一组」:
// 资料(AssistantSection)与连接应用(ConnectorsSection)两页。
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'

type Mine = { contact: { id: string; display_name: string; avatar: string | null } | null; agentId: string | null; loading: boolean; error: string | null }
const mine = vi.hoisted(() => ({ value: { contact: null, agentId: null, loading: false, error: null } as Mine }))
// 这台宿主有没有本机运行时(桌面 = 有;手机 / 网页 = 没有):会议提醒读的是桌面主进程的日历,手机壳里没有那一层。
const runtime = vi.hoisted(() => ({ agentRuntime: true }))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return {
    ...actual,
    platform: new Proxy(actual.platform, {
      get: (target, key) => (key === 'capabilities' ? { ...target.capabilities, agentRuntime: runtime.agentRuntime } : Reflect.get(target, key)),
    }),
  }
})
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ useMyAssistantContact: () => ({ homeDeviceId: 'cloud-1',...mine.value }) }))

vi.mock('../../../../apps/desktop/src/components/assistant/AssistantShellHost', () => ({
  AssistantStatusGroups: ({ assistantName }: { assistantName: string }) => createElement('div', { 'data-testid': 'status-groups' }, assistantName),
  OnboardingSlot: () => createElement('div', { 'data-testid': 'onboarding-slot' }),
}))
// 搬家组和住电脑的几组是各自的组件测的(assistantMoveGroup7199 等);这里只认它们按「住哪」被画出来。
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantMoveGroup', () => ({
  AssistantMoveGroup: (props: { home: { kind: string } }) => createElement('div', { 'data-testid': 'move-group', 'data-home': props.home.kind }),
}))
vi.mock('../../../../apps/desktop/src/components/assistant/ComputerHomeSettings', () => ({
  ComputerHomeGroups: ({ move }: { move: unknown }) => createElement('div', { 'data-testid': 'computer-home-groups', 'data-move': move ? 'yes' : 'no' }),
}))
vi.mock('../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal', () => ({
  AgentSettingsModal: ({ initialTab }: { initialTab?: string }) => createElement('div', { 'data-testid': 'agent-settings-modal', 'data-tab': initialTab }),
}))
const invoke = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/session/renderer/lib/ipc')>()),
  invokeOnMachine: invoke,
}))

const sessionSection = vi.hoisted(() => ({ props: null as unknown }))
vi.mock('../../../../apps/desktop/src/components/sessionpage/SessionSettingsSection', () => ({
  SessionSettingsSection: (props: unknown) => {
    sessionSection.props = props
    return createElement('div', { 'data-testid': 'session-section' })
  },
}))
vi.mock('../../../../apps/desktop/src/components/devices/AssistantDeviceConnectors', () => ({
  ThisDeviceConnectors: () => createElement('div', { 'data-testid': 'this-device' }),
  OtherDeviceConnectors: () => createElement('div', { 'data-testid': 'other-devices' }),
}))
const wake = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../../apps/desktop/src/lib/cloudComputerStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/cloudComputerStore')>()),
  wakeCloudComputer: wake,
}))

const { SettingsPanel } = await import('../../../../apps/desktop/src/components/SettingsPanel')
const { AssistantSection } = await import('../../../../apps/desktop/src/components/settings/AssistantSection')
const { ConnectorsSection } = await import('../../../../apps/desktop/src/components/settings/ConnectorsSection')
const { DevicesContext } = await import('../../../../apps/desktop/src/store/devicesContext')

const CONTACT = { id: 'a1', display_name: '小咕', avatar: null }
const awake = { available: true, snapshot: { state: 'awake', deviceId: 'cloud-1', error: null, since: null }, loadError: null }
const asleep = { available: true, snapshot: { state: 'asleep', deviceId: 'cloud-1', error: null, since: null }, loadError: null }

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => {
  harness.cleanup()
  mine.value = { contact: null, agentId: null, loading: false, error: null }
  sessionSection.props = null
  wake.mockClear()
  invoke.mockClear()
  runtime.agentRuntime = true
})

async function render(node: ReactNode, cloud: typeof awake | typeof asleep, updateAgentProfile = vi.fn(async () => {}), devices: unknown[] = []) {
  const value = {
    devices, loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {},
    listBoundAgents: async () => [], cloudComputer: cloud,
  }
  await renderWithAppProviders(harness, createElement(DevicesContext.Provider, { value: value as never }, node), {
    auth: { id: 'u1', email: 'u@e.com', nickname: 'U' },
    contacts: { updateAgentProfile } as never,
  })
  return updateAgentProfile
}
const q = (testId: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

describe('咕咕组 · 资料', () => {
  it('名字原位编辑:点笔后才出现输入,保存通讯录里它那一位', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    const update = await render(createNode(AssistantSection, { available: ['connectors', 'devices', 'channels'], onOpenSection: vi.fn() }), awake)
    expect(q('assistant-name-input')).toBeNull()
    await clickElement(q('assistant-name-edit')!)
    const input = q('assistant-name-input') as HTMLInputElement
    expect(input.value).toBe('小咕')
    await typeInto(input, '小团')
    await clickElement(q('assistant-name-save')!)
    expect(update).toHaveBeenCalledWith('a1', { name: '小团' })
  })

  it('「它用的东西」三行指向设置里别的页(同一份数据、同一个入口);这台宿主没有的页不画', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    const open = vi.fn()
    await render(createNode(AssistantSection, { available: ['connectors', 'devices'], onOpenSection: open }), awake)
    expect(q('settings-assistant-open-channels')).toBeNull()
    expect(q('settings-assistant-model')?.querySelector('.gg-settings-row-leading svg')).not.toBeNull()
    await clickElement(q('settings-assistant-open-connectors')!)
    await clickElement(q('settings-assistant-open-devices')!)
    expect(open.mock.calls.map((c) => c[0])).toEqual(['connectors', 'devices'])
  })

  it('助理 App 的数据页(记忆 / 定时任务)入口只在桌面给;手机上助理是底部 tab,不给', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), awake)
    expect(q('settings-assistant-open-memory')).toBeNull()
    harness.cleanup()
    harness = createReactHarness()
    const openPage = vi.fn()
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn(), onOpenAssistantPage: openPage }), awake)
    await clickElement(q('settings-assistant-open-tasks')!)
    expect(openPage).toHaveBeenCalledWith('tasks')
  })

  it('形象与性格打开它的形象工坊;状态 / 快速聊天 / 关闭三组是壳那份(同一个组件)', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), awake)
    expect(q('status-groups')?.textContent).toBe('小咕')
    await clickElement(q('settings-assistant-look')!)
    expect(q('agent-settings-modal')?.getAttribute('data-tab')).toBe('look')
  })

  it('它住在人自己的电脑上(非会员):画「住哪 + 搬家」那几组,没有云上的状态组;云上的家带搬家组', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null, homeDeviceId: 'mac-1' } as never
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), awake, vi.fn(async () => {}), [
      { device_id: 'mac-1', label: 'MacBook', is_online: true, is_current_device: true },
    ])
    expect(q('computer-home-groups')).not.toBeNull()
    expect(q('status-groups')).toBeNull()
    harness.cleanup()
    harness = createReactHarness()
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null, homeDeviceId: 'cloud-1' } as never
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), awake)
    expect(q('status-groups')).not.toBeNull()
    expect(q('computer-home-groups')).toBeNull()
  })

  it('管家说没开放云电脑、但它住在这台电脑上:页面照样画(不整页空)', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null, homeDeviceId: 'mac-1' } as never
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), { available: false, snapshot: null, loadError: null } as never, vi.fn(async () => {}), [
      { device_id: 'mac-1', label: 'MacBook', is_online: true, is_current_device: true },
    ])
    expect(q('settings-assistant-who')).not.toBeNull()
    expect(q('computer-home-groups')).not.toBeNull()
  })

  // 实机(备用机 OnePlus 8T)点咕咕页齿轮整页出错:会议提醒那一组在手机壳里调主进程日历通道,electronAPI.invoke 同步抛。
  it('手机壳里(没有本机运行时)不画入会提醒那一组,也不去调桌面日历通道', async () => {
    runtime.agentRuntime = false
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), awake)
    expect(q('settings-assistant-who')).not.toBeNull()
    expect(q('settings-assistant-voice')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('桌面上画入会提醒那一组(对照:上面那条不是因为整页没画出来)', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), awake)
    expect(q('settings-assistant-voice')).not.toBeNull()
  })

  it('还没开通:这一页只说开通(流程在引导格里),不画名字 / 状态那些', async () => {
    await render(createNode(AssistantSection, { available: [], onOpenSection: vi.fn() }), { available: true, snapshot: { state: 'none', deviceId: null, error: null, since: null }, loadError: null } as never)
    expect(q('onboarding-slot')).not.toBeNull()
    expect(q('settings-assistant-who')).toBeNull()
    expect(q('status-groups')).toBeNull()
  })
})

describe('咕咕组 · 连接应用', () => {
  it('应用列表委托给会话页，不再混入设备授权或三格页签', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    await render(createNode(ConnectorsSection, {}), awake)
    expect(sessionSection.props).toMatchObject({ section: 'connectors', context: { home: { kind: 'cloud',deviceId: 'cloud-1' }, assistantName: '小咕' } })
    const tabs = [...harness.container.querySelectorAll<HTMLElement>('[role="tab"]')]
    // Owner 2026-10-27: apps have one list; device grants live in Settings → Permissions.
    expect(tabs).toHaveLength(0)
    expect(q('this-device')).toBeNull()
    expect(q('other-devices')).toBeNull()
  })

  it('住在自己的电脑时仍读那台电脑的应用账号，不增加分类或叫醒动作', async () => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null, homeDeviceId: 'mac-1' } as never
    await render(createNode(ConnectorsSection, {}), asleep, vi.fn(async () => {}), [
      { device_id: 'mac-1', label: 'MacBook', is_online: true, is_current_device: true },
    ])
    expect(sessionSection.props).toMatchObject({ section: 'connectors', context: { home: { kind: 'computer', deviceId: 'mac-1' }, assistantName: '小咕' } })
    const tabs = [...harness.container.querySelectorAll<HTMLElement>('[role="tab"]')]
    expect(tabs).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
  })

  it('serves account application settings while the host sleeps without showing a connection gate', async () => {
    mine.value = { contact: CONTACT,agentId: 'a1',loading: false,error: null }
    await render(createNode(ConnectorsSection,{}),asleep)
    expect(sessionSection.props).toMatchObject({ section: 'connectors',context: { home: { deviceId: 'cloud-1' } } })
    expect(wake).not.toHaveBeenCalled()
    expect(harness.container.textContent).not.toMatch(/正在连接|连不上|重新连接/)
    expect(q('settings-connectors-retry')).toBeNull()
  })
  it('does not prepare a host after a previous wake failure', async () => {
    mine.value = { contact: CONTACT,agentId: 'a1',loading: false,error: null }
    await render(createNode(ConnectorsSection,{}),{ ...asleep,loadError: 'unavailable' } as never)
    expect(sessionSection.props).not.toBeNull()
    expect(wake).not.toHaveBeenCalled()
  })
})


describe('retired chat channel settings links', () => {
  it.each([false, true])('opens Connect apps for a legacy channels link (mobile=%s)', async (mobile) => {
    mine.value = { contact: CONTACT, agentId: 'a1', loading: false, error: null }
    await render(createNode(SettingsPanel, { initialSection: 'channels', inline: true, mobile, pane: 'detail' }), awake)
    expect(harness.container.querySelector('[data-settings-section="connectors"]')).not.toBeNull()
    expect(q('settings-connectors')).not.toBeNull()
    expect(q('settings-nav-channels')).toBeNull()
    expect(harness.container.querySelector('.gg-settings-detail .gg-pane-title')?.textContent).toBe('连接应用')
  })
})
