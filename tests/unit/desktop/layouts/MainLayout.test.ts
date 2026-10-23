// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainLayout } from '../../../../apps/desktop/src/layouts/MainLayout'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { openConversationLink } from '../../../../apps/desktop/src/lib/conversationLinks'
import { conversationLink } from '@gugu/core/shared/ui/conversationLink'
import { ToastContext } from '../../../../apps/desktop/src/components/toastContext'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'
import type { SessionpageMessageHost } from '../../../../apps/desktop/src/session/shared/sessionpage-message-host'
import { chatOnScreen } from '../../../../apps/desktop/src/lib/onScreenChat'
import { groupSlotMemory } from '../../../../apps/desktop/src/components/appSlot/groupSlotMemory'
import { drainTopicSplitRequest } from '../../../../apps/desktop/src/lib/topicSplitRequest'
import { APP_OPEN_WITH_EVENT, APP_OPEN_IN_CHAT_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { SIDEBAR_TABS, mobileTabs } from '@gugu/core/shared/enums/sidebarTabModels'
const resourceChat = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/session/shared/extensions/app-files-core', () => ({ resourceChatIdOf: resourceChat }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', async (original) => ({
  ...await original<object>(), getRendererAccessToken: () => 'layout-token',
}))
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111'
const activationProbe = vi.hoisted(() => ({
  calls: [] as Array<{ owner: string; accountId: string | null }>,
  prewarm: vi.fn(),
}))
// 横幅「去充值」的入口:替身不画任何节点(壳的子节点序号有测试在数),只把回调交出来。
const rechargeProbe = vi.hoisted(() => ({ onRecharge: null as null | (() => void) }))
function useActivationProbe(owner: string, active: boolean, accountId: string | null) {
  useEffect(() => {
    if (active) activationProbe.calls.push({ owner, accountId })
  }, [active, accountId, owner])
}
vi.mock('../../../../apps/desktop/src/components/Sidebar', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    // #7046 起左栏不再订余额(积分环拿掉了),替身也就不报 sidebar-billing。
    Sidebar: ({ onTabChange }: {
      onTabChange: (tab: 'settings' | 'chats' | 'tasks' | 'contacts') => void
    }) => {
      return React.createElement('div', { 'data-testid': 'mock-sidebar' },
        React.createElement('button', { type: 'button', 'data-testid': 'mock-open-chats', onClick: () => onTabChange('chats') }, 'open chats'),
        React.createElement('button', { type: 'button', 'data-testid': 'mock-open-tasks', onClick: () => onTabChange('tasks') }, 'open tasks'),
        React.createElement('button', { type: 'button', 'data-testid': 'mock-open-settings', onClick: () => onTabChange('settings') }, 'open settings'),
        React.createElement('button', { type: 'button', 'data-testid': 'mock-open-contacts', onClick: () => onTabChange('contacts') }, 'open contacts')
      )
    }
  }
})
vi.mock('../../../../apps/desktop/src/components/LowBalanceBanner', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    LowBalanceBanner: ({ user, onRecharge }: { user: { id: string } | null; onRecharge: () => void }) => {
      useActivationProbe('low-balance-billing', user !== null, user?.id ?? null)
      rechargeProbe.onRecharge = onRecharge
      return React.createElement(React.Fragment)
    },
  }
})
vi.mock('../../../../apps/desktop/src/store/chat', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ChatProvider: ({ children, active = true }: { children: ReactNode; active?: boolean }) => {
      useActivationProbe('chat', active, null)
      return React.createElement(React.Fragment, null, children)
    },
  }
})
vi.mock('../../../../apps/desktop/src/store/contacts', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ContactsProvider: ({ children, active = true }: { children: ReactNode; active?: boolean }) => {
      useActivationProbe('contacts', active, null)
      return React.createElement(React.Fragment, null, children)
    },
  }
})
vi.mock('../../../../apps/desktop/src/store/devices', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    DevicesProvider: ({ children, active = true }: { children: ReactNode; active?: boolean }) => {
      useActivationProbe('devices', active, null)
      return React.createElement(React.Fragment, null, children)
    },
  }
})
vi.mock('../../../../apps/desktop/src/components/ChatListPanel', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ChatListPanel: ({
      onChatSelected,
      onOpenAgentCreateDraft,
    }: {
      onChatSelected?: () => void
      onOpenAgentCreateDraft?: () => void
    }) => (
      React.createElement('div', null,
        React.createElement('button', { type: 'button', 'data-testid': 'mock-chat-row', onClick: onChatSelected }, 'chat-list-panel'),
        onOpenAgentCreateDraft
          ? React.createElement('button', { type: 'button', 'data-testid': 'mock-chat-create-agent', onClick: onOpenAgentCreateDraft }, 'create agent')
          : null)
    )
  }
})
// #6158 有状态的替身:本地 state + 挂载计数,才量得出「切 tab 是隐藏还是重挂」——无状态替身两种实现都绿。
const chatAreaProbe = vi.hoisted(() => ({ mounts: 0 }))
vi.mock('../../../../apps/desktop/src/components/ChatAreaPanel', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ChatAreaPanel: ({ activeTab, hidden = false }: { activeTab: string; hidden?: boolean }) => {
      const [bumps, setBumps] = React.useState(0)
      React.useEffect(() => { chatAreaProbe.mounts += 1 }, [])
      return React.createElement('div', { 'data-testid': 'mock-chat-area', 'data-bumps': String(bumps), 'data-active-tab': activeTab, 'data-hidden': String(hidden) },
        React.createElement('button', { type: 'button', 'data-testid': 'mock-chat-area-bump', onClick: () => setBumps((n) => n + 1) }, 'bump'),
        'chat-area-panel')
    },
  }
})
// #7199 手机底栏「助理」那一格:认助理 / 私聊的钩子换成可摆的替身(默认这里开不了个人助理 = 没有这一格),格子里的 App 换成一个只报参数的节点。
const phoneAssistantMock = vi.hoisted(() => ({
  state: {
    available: false,
    assistant: null as null | { id: string; display_name: string; avatar: string | null; created_at: string | null },
    chatId: null as string | null,
    homeDeviceId: null as string | null,
    cloudDeviceId: null as string | null,
    home: null as null | { kind: string; deviceId: string },
    ownerName: null as string | null,
    stage: { stage: 'cloud-loading' } as { stage: string },
  },
}))
vi.mock('../../../../apps/desktop/src/mobile/assistant/usePhoneAssistant', () => ({
  usePhoneAssistant: () => phoneAssistantMock.state,
}))
vi.mock('../../../../apps/desktop/src/mobile/assistant/MobileAssistantTab', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    MobileAssistantTab: ({ visible, chatRequest }: { visible: boolean; chatRequest: number }) =>
      React.createElement('div', { 'data-testid': 'mock-assistant-tab', 'data-visible': String(visible), 'data-chat-request': String(chatRequest) }),
  }
})
// 看管订阅的根:挂载/卸载计数量「切 tab 会不会把它拆掉」。
const agentWatchProbe = vi.hoisted(() => ({ rootMounts: 0, rootUnmounts: 0 }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/AgentWatchPage', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    AgentWatchPage: ({ active, createRequest }: { active: boolean; createRequest?: number }) => React.createElement('div', { 'data-testid': 'mock-agent-watch-page', 'data-active': String(active), 'data-create-request': String(createRequest ?? 0) }),
    AgentWatchRoot: () => {
      React.useEffect(() => {
        agentWatchProbe.rootMounts += 1
        return () => { agentWatchProbe.rootUnmounts += 1 }
      }, [])
      return null
    },
  }
})
vi.mock('../../../../apps/desktop/src/components/sessionpage/EmdashSessionFrame', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/components/sessionpage/EmdashSessionFrame')>()),
  EmdashSessionFrame: () => null,
  prewarmEmdashAssets: activationProbe.prewarm,
}))
vi.mock('../../../../apps/desktop/src/components/AcpAgentCreateComposer', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    AcpAgentCreateComposer: () => React.createElement('div', { 'data-testid': 'mock-acp-agent-create-composer' }, 'acp-agent-create-composer'),
  }
})
vi.mock('../../../../apps/desktop/src/components/ContactsPanel', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ContactsPanel: ({ onOpenAgentCreateDraft }: { onOpenAgentCreateDraft?: () => void }) => (
      React.createElement('div', { 'data-testid': 'mock-contacts-panel' },
        onOpenAgentCreateDraft
          ? React.createElement('button', { type: 'button', 'data-testid': 'mock-contacts-create-agent', onClick: onOpenAgentCreateDraft }, 'create agent')
          : null)
    )
  }
})
vi.mock('../../../../apps/desktop/src/components/SettingsPanel', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    // 有状态的替身,与真 SettingsPanel 同一个口径:给了 section 就受控(弹窗),否则是本地 state、只在挂载时读 initialSection(「我的」)。
    SettingsPanel: ({ onClose, initialSection, section: controlled, onSectionChange }: {
      onClose?: () => void
      initialSection?: string
      section?: string
      onSectionChange?: (section: string) => void
    }) => {
      const [local, setLocal] = React.useState(initialSection)
      const section = controlled ?? local
      const setSection = onSectionChange ?? setLocal
      return React.createElement('div', { role: 'dialog', 'data-testid': 'mock-settings-panel', 'data-section': section },
        React.createElement('button', { type: 'button', 'data-testid': 'mock-settings-pick-about', onClick: () => setSection('about') }, 'about'),
        React.createElement('button', { type: 'button', 'data-testid': 'mock-close-settings', onClick: onClose }, 'close settings')
      )
    }
  }
})
vi.mock('../../../../apps/desktop/src/layouts/ResizableChatListPane', () => ({
  ResizableChatListPane: ({ children, hidden }: { children: unknown; hidden?: boolean }) => hidden ? null : children
}))
vi.mock('../../../../apps/desktop/src/layouts/ResizableChatListPaneStorage', () => ({
  readStoredChatListPaneWidth: () => 320,
  writeStoredChatListPaneWidth: vi.fn()
}))
vi.mock('../../../../apps/desktop/src/store/contactsContext', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/store/contactsContext')>(
    '../../../../apps/desktop/src/store/contactsContext'
  )
  return {
    ...actual,
    ContactsProvider: ({ children }: { children: unknown }) => children,
    useContactsStore: () => ({ contacts: [], pendingRequests: [] })
  }
})
// gugu-dev#181 桌面上打开一条对话 = 请会话页摆出它那块(会话页装的那座桥,这里装一份假的、只记下请求)。
const sessionPageViewRequests = { request: vi.fn(), openChat: vi.fn(), openSession: vi.fn() }
const { platformMock, chatStoreMock, chatServiceMock, draftValues } = vi.hoisted(() => ({
  platformMock: {
    kind: 'electron',
    capabilities: { notifications: false, appUpdates: false, sessionHost: true },
    showNotification: vi.fn(),
    installUpdate: vi.fn()
  },
  chatStoreMock: {
    chats: [] as Array<{ id: string }>,
    activeChatId: null as string | null,
    setActiveChatId: vi.fn(),
    refreshChats: vi.fn(),
    upsertChat: vi.fn(),
    setDraft: vi.fn(),
    sendMessageToChat: vi.fn(),
    // The shell hears App packages sent in any chat (摩擦单 F66, ExtensionForwardHost).
    subscribeAccountRevision: vi.fn(() => () => undefined),
  },
  chatServiceMock: { getOrCreateDM: vi.fn() },
  draftValues: new Map<string, string>(),
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({
    ...chatStoreMock,
  })
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: chatServiceMock
}))
vi.mock('../../../../apps/desktop/src/lib/notificationSettings', () => ({
  useNotificationSettings: () => ({ messages: false, requests: false })
}))
const agentEventMock = vi.hoisted(() => ({
  readStarted: vi.fn<(event: Event) => unknown>(() => null),
}))
vi.mock('../../../../apps/desktop/src/lib/agentConversationEvents', () => ({
  AGENT_SESSION_STARTED_EVENT: 'agent-conversation-started',
  readAgentConversationStartedEvent: agentEventMock.readStarted
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: platformMock
}))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, { left }: ScrollToOptions) {
      this.scrollLeft = left ?? this.scrollLeft
      this.dispatchEvent(new Event('scroll'))
    },
  })
  activationProbe.calls.length = 0
  chatAreaProbe.mounts = 0
  agentWatchProbe.rootMounts = 0
  agentWatchProbe.rootUnmounts = 0
  activationProbe.prewarm.mockReset()
  agentEventMock.readStarted.mockReset()
  agentEventMock.readStarted.mockReturnValue(null)
  platformMock.kind = 'electron'
  platformMock.capabilities.sessionHost = true
  chatStoreMock.chats = []
  chatStoreMock.activeChatId = null
  chatStoreMock.setActiveChatId.mockReset()
  chatStoreMock.refreshChats.mockReset()
  chatStoreMock.upsertChat.mockReset()
  chatStoreMock.setDraft.mockReset()
  chatStoreMock.sendMessageToChat.mockReset()
  chatStoreMock.sendMessageToChat.mockResolvedValue(MESSAGE_ID)
  draftValues.clear()
  chatStoreMock.setDraft.mockImplementation(
    (chatId: string, update: string | ((current: string) => string)) => {
      const next = typeof update === 'function' ? update(draftValues.get(chatId) ?? '') : update
      draftValues.set(chatId, next)
    },
  )
  chatServiceMock.getOrCreateDM.mockReset()
  phoneAssistantMock.state.available = false
  phoneAssistantMock.state.assistant = null
  phoneAssistantMock.state.chatId = null
  phoneAssistantMock.state.stage = { stage: 'cloud-loading' }
  delete (window as Window & { electronAPI?: unknown }).electronAPI
  sessionPageViewRequests.openChat.mockReset()
  ;(window as unknown as Record<string, unknown>).__GUGU_SESSIONPAGE_VIEW_REQUESTS__ = sessionPageViewRequests
  Object.defineProperty(window, '__guguNativeBackHandled', {
    configurable: true,
    writable: true,
    value: false,
  })
})
afterEach(() => {
  harness.cleanup()
  delete (window as unknown as Record<string, unknown>).__GUGU_SESSIONPAGE_VIEW_REQUESTS__
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function renderMainLayoutWithToast(toast = vi.fn()) {
  await harness.render(createNode(
    ToastContext.Provider,
    { value: { toast } },
    createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' },
    }),
  ))
  return { toast }
}
// #6158 聊天面那一格 = mock 会话区的祖父(中间一层是 mobilePane 的 display 壳)。
function chatSurfaceOf(container: HTMLElement): HTMLElement | null {
  // 聊天区 → 创建面常驻外壳 → 正文槽 → 聊天面。
  return (container.querySelector('[data-testid="mock-chat-area"]')?.parentElement?.parentElement?.parentElement as HTMLElement | null) ?? null
}
describe('MainLayout', () => {
  it('wires every data owner and the shell marker to the real activation prop', async () => {
    const user = { id: 'account-a', email: 'a@example.com', nickname: 'A' }
    const onShellCommitted = vi.fn()
    await harness.render(createNode(MainLayout, { user, effectsActive: false, onShellCommitted }))
    const shell = harness.container.querySelector('[data-gugu-shell-phase]')
    expect(shell?.getAttribute('data-gugu-shell-phase')).toBe('committed-inert')
    expect(onShellCommitted).toHaveBeenCalled()
    expect(activationProbe.calls).toEqual([])
    expect(activationProbe.prewarm).toHaveBeenCalledTimes(1)
    await harness.render(createNode(MainLayout, { user, effectsActive: true, onShellCommitted }))
    expect(shell?.getAttribute('data-gugu-shell-phase')).toBe('active')
    expect(activationProbe.calls.map((call) => call.owner).sort()).toEqual([
      'contacts', 'devices', 'low-balance-billing',
    ])
    expect(activationProbe.prewarm).toHaveBeenCalledTimes(1)
  })
  it('renders the desktop shell as flush columns instead of an inset card', async () => {
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    const appShell = harness.container.firstElementChild as HTMLElement | null
    const mainShell = appShell?.children[1] as HTMLElement | undefined
    // #7333 壳根读 --shell-bg:不透明时与导航材质同底,mac 原生材质可见时透明(tokens.css @@@window-material-css)。
    expect(appShell?.style.background).toBe('var(--shell-bg)')
    expect(readFileSync('apps/desktop/src/styles/tokens.css', 'utf8')).toMatch(/:root \{\n {2}--shell-bg: var\(--nav-rail\);\n\}/)
    // @@@mobile-safe-area-top (#1227) — desktop shell takes NO status-bar inset (mobile-gated).
    expect(appShell?.style.paddingTop).toBe('')
    expect(mainShell).toBeTruthy()
    expect(mainShell?.style.margin).toBe('0px')
    // 2026-09-22 按 design.md 统一:0 这一档有名字了(--radius-page,「The page is paper. It is
    // square.」),值由 check-ui-visual-spec 的 radiusScaleParity 钉着 ⇒ 断言收到 token 名上。
    expect(mainShell?.style.borderRadius).toBe('var(--radius-page)')
    expect(mainShell?.style.boxShadow).toBe('none')
    expect(mainShell?.style.background).toBe('var(--shell-bg)')
  })
  it('opens user settings as a modal without replacing the current page', async () => {
    // 有聊天页的形态(网页:没有会话页宿主)。桌面上没有单独的聊天页(gugu-dev#181)。
    platformMock.kind = 'web'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    await clickElement(harness.container.querySelector('[data-testid="mock-open-chats"]') as HTMLElement)
    expect(harness.container.textContent).toContain('chat-list-panel')
    expect(harness.container.textContent).toContain('chat-area-panel')
    expect(harness.container.querySelector('[data-testid="mock-settings-panel"]')).toBeNull()
    const openSettings = harness.container.querySelector('[data-testid="mock-open-settings"]') as HTMLElement | null
    expect(openSettings).toBeTruthy()
    await clickElement(openSettings!)
    expect(harness.container.textContent).toContain('chat-list-panel')
    expect(harness.container.textContent).toContain('chat-area-panel')
    expect(harness.container.querySelector('[data-testid="mock-settings-panel"]')).toBeTruthy()
    const closeSettings = harness.container.querySelector('[data-testid="mock-close-settings"]') as HTMLElement | null
    expect(closeSettings).toBeTruthy()
    await clickElement(closeSettings!)
    expect(harness.container.querySelector('[data-testid="mock-settings-panel"]')).toBeNull()
  })
  // product spec:会话页通向设置的地方(⌘, / 菜单 / 浏览器工具栏)开的是壳这一个弹窗,并落到那一格。
  it('opens the one settings modal at the section the task page asks for, also while it is already open', async () => {
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    const panel = () => harness.container.querySelector('[data-testid="mock-settings-panel"]') as HTMLElement | null
    const ask = async (section?: string) => {
      await act(async () => {
        window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section } }))
      })
    }
    expect(panel()).toBeNull()
    await ask('browser')
    expect(panel()?.getAttribute('data-section')).toBe('browser')
    // 弹窗开着时再要一格(「仓库」页机器选择器里的「添加一台机器」→ 设备):换到那一格,❌ 吞掉。
    await ask('devices')
    expect(panel()?.getAttribute('data-section')).toBe('devices')
    // 没指格(⌘,):照原样打开,上次停在哪一格就是哪一格。
    await clickElement(harness.container.querySelector('[data-testid="mock-settings-pick-about"]') as HTMLElement)
    await clickElement(harness.container.querySelector('[data-testid="mock-close-settings"]') as HTMLElement)
    expect(panel()).toBeNull()
    await ask()
    expect(panel()?.getAttribute('data-section')).toBe('about')
  })
  it('exposes the create-agent entry on a platform without a task host, wired to the ACP-only composer', async () => {
    platformMock.kind = 'web'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    const chatEntry = harness.container.querySelector('[data-testid="mock-chat-create-agent"]') as HTMLElement | null
    expect(chatEntry, 'Messages must offer the create entry on web/Capacitor too').toBeTruthy()
    await clickElement(chatEntry!)
    const composer = harness.container.querySelector('[data-testid="mock-acp-agent-create-composer"]')
    expect(composer, 'clicking it must mount the ACP-only assembly, not a no-op').toBeTruthy()
    await clickElement(harness.container.querySelector('[data-testid="mock-open-contacts"]') as HTMLElement)
    expect(
      harness.container.querySelector('[data-testid="mock-contacts-create-agent"]'),
      'Contacts must offer it on web/Capacitor too',
    ).toBeTruthy()
    expect(activationProbe.prewarm).not.toHaveBeenCalled()
  })
  it('#6784 mobile: the contacts create-agent entry goes to the task tab machine picker, not a chat-tab draft', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    const watch = () => harness.container.querySelector('[data-testid="mock-agent-watch-page"]')
    expect(watch()?.getAttribute('data-create-request')).toBe('0')
    await clickElement(harness.container.querySelector('[data-testid="mock-contacts-create-agent"]') as HTMLElement)
    expect(watch()?.getAttribute('data-active'), 'lands on the task tab').toBe('true')
    expect(watch()?.getAttribute('data-create-request'), 'and asks it to start creating (pick a machine)').toBe('1')
    expect(harness.container.querySelector('[data-testid="mock-acp-agent-create-composer"]')).toBeNull()
    await clickElement(harness.container.querySelector('[data-testid="mock-contacts-create-agent"]') as HTMLElement)
    expect(watch()?.getAttribute('data-create-request'), 'every tap is a new request').toBe('2')
  })
  it('keeps the two assemblies mutually exclusive: a task host never mounts the ACP-only composer', async () => {
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    await clickElement(harness.container.querySelector('[data-testid="mock-open-chats"]') as HTMLElement)
    // gugu-dev#181 有会话页的桌面上没有单独的聊天页:建 agent 只走会话页那一个新建会话,聊天页的创建入口与 ACP 装配都不在。
    expect(harness.container.querySelector('[data-testid="mock-chat-create-agent"]')).toBeNull()
    expect(
      harness.container.querySelector('[data-testid="mock-acp-agent-create-composer"]'),
      'Electron creates through the one resident session-page composer; a second assembly here would be a fork',
    ).toBeNull()
  })
  it('never navigates on the agent-conversation-started broadcast, on any tab', async () => {
    const activity = {
      agentId: 'agent-1',
      chatId: 'agent-dm',
      threadRootId: null,
      displayName: 'Agent',
      avatar: null,
      startedAt: '2026-08-18T00:00:00.000Z',
      status: 'running',
    }
    agentEventMock.readStarted.mockReturnValue(activity)
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    // gugu-dev#181 桌面上没有单独的聊天页可切过去。
    expect(chatSurfaceOf(harness.container)).toBeNull()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('agent-conversation-started', { detail: activity }))
      await Promise.resolve()
    })
    expect(chatStoreMock.setActiveChatId).not.toHaveBeenCalled()
    expect(sessionPageViewRequests.openChat, 'agent started — nothing is opened for it').not.toHaveBeenCalled()
    await clickElement(harness.container.querySelector('[data-testid="mock-open-chats"]') as HTMLElement)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('agent-conversation-started', { detail: activity }))
      await Promise.resolve()
    })
    expect(chatStoreMock.setActiveChatId).not.toHaveBeenCalled()
    const host = (window as typeof window & { __GUGU_SESSIONPAGE_MESSAGES__?: SessionpageMessageHost })
      .__GUGU_SESSIONPAGE_MESSAGES__
    expect(host, 'the create flow reaches the shell through this host').toBeTruthy()
    await act(async () => {
      host!.openAgentChat({ chatId: 'agent-dm', agentUserId: 'agent-1' })
      await Promise.resolve()
    })
    // gugu-dev#181 桌面上没有单独的聊天页:新建 agent 的那条对话在会话页这屏打开(一块),❌ 换壳的当前对话。
    expect(sessionPageViewRequests.openChat).toHaveBeenCalledWith('agent-dm', false)
    expect(chatStoreMock.setActiveChatId).not.toHaveBeenCalled()
  })
  it('publishes the exact ordinary sendMessageToChat API to the taskpage composer', async () => {
    await renderMainLayoutWithToast()
    const host = (window as typeof window & { __GUGU_SESSIONPAGE_MESSAGES__?: SessionpageMessageHost })
      .__GUGU_SESSIONPAGE_MESSAGES__
    expect(host).toBeTruthy()
    expect(host!.sendMessageToChat).toBe(chatStoreMock.sendMessageToChat)
    await host!.sendMessageToChat('chat-1', 'later message', {
      toUserIds: ['agent-1'],
      clientMessageId: 'later-id',
    })
    expect(chatStoreMock.sendMessageToChat).toHaveBeenCalledWith('chat-1', 'later message', {
      toUserIds: ['agent-1'],
      clientMessageId: 'later-id',
    })
  })
  it('handles Android back from the mobile chat pane by returning to the chat list', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    chatStoreMock.chats = [{ id: 'chat-1' }]
    chatStoreMock.activeChatId = 'chat-1'
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' }
    }))
    expect(
      harness.container.querySelector(
        `[data-testid="${AUTOMATION_TEST_IDS.mobileMessagesNav}"]`,
      ),
    ).not.toBeNull()
    await act(async () => {
      const row = harness.container.querySelector('[data-testid="mock-chat-row"]') as HTMLButtonElement | null
      row?.click()
      await Promise.resolve()
    })
    const chatArea = harness.container.querySelector('[data-testid="mock-chat-area"]') as HTMLElement | null
    // 聊天区外面多一层创建面常驻外壳;移动端显隐由再外一层的正文槽决定。
    expect(chatArea?.parentElement?.parentElement?.style.display).toBe('flex')
    expect(harness.container.textContent).not.toContain('chat-list-panel')
    await act(async () => {
      window.dispatchEvent(new CustomEvent('gugu:native-back'))
      await Promise.resolve()
    })
    expect((window as Window & { __guguNativeBackHandled?: boolean }).__guguNativeBackHandled).toBe(true)
    expect(harness.container.textContent).toContain('chat-list-panel')
    expect(chatArea?.parentElement?.parentElement?.style.display).toBe('none')
  })
  it('keeps one mobile navigation landmark after visiting another tab', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, {
      user: { id: 'user-1', email: 'user@example.com', nickname: 'User' },
    }))
    const navSelector = `[data-testid="${AUTOMATION_TEST_IDS.mobileMessagesNav}"]`
    expect(harness.container.querySelectorAll(navSelector)).toHaveLength(1)
    await act(async () => {
      const contacts = harness.container.querySelector(
        `[data-testid="${AUTOMATION_TEST_IDS.mobileContactsNav}"]`,
      ) as HTMLButtonElement | null
      contacts?.click()
      await Promise.resolve()
    })
    expect(harness.container.querySelector('[data-testid="mock-contacts-panel"]')).toBeTruthy()
    expect(harness.container.querySelectorAll(navSelector)).toHaveLength(1)
    await act(async () => {
      const messages = harness.container.querySelector(navSelector) as HTMLButtonElement | null
      messages?.click()
      await Promise.resolve()
    })
    expect(harness.container.querySelectorAll(navSelector)).toHaveLength(1)
  })
  it('keeps the chats surface mounted and merely hidden while another tab is active (#6158)', async () => {
    // 有聊天页的形态(网页:没有会话页宿主);落地就在聊天页。
    platformMock.kind = 'web'
    platformMock.capabilities.sessionHost = false
    chatStoreMock.chats = [{ id: 'chat-1' }]
    chatStoreMock.activeChatId = 'chat-1'
    await renderMainLayoutWithToast()
    const surface = chatSurfaceOf(harness.container)
    expect(surface, 'the chats surface mounts at boot').not.toBeNull()
    expect(surface!.style.visibility).toBe('')
    const chatArea = harness.container.querySelector('[data-testid="mock-chat-area"]') as HTMLElement
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-area-bump"]') as HTMLElement)
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-area-bump"]') as HTMLElement)
    expect(chatArea.getAttribute('data-bumps')).toBe('2')
    await clickElement(harness.container.querySelector('[data-testid="mock-open-contacts"]') as HTMLElement)
    expect(harness.container.querySelector('[data-testid="mock-chat-area"]'), 'switching to contacts must not unmount the chat area').toBe(chatArea)
    expect(chatArea.getAttribute('data-active-tab')).toBe('contacts')
    expect(surface!.style.visibility).toBe('hidden')
    expect(surface!.style.position).toBe('absolute')
    expect(surface!.style.pointerEvents).toBe('none')
    expect(surface!.hasAttribute('inert')).toBe(true)
    await clickElement(harness.container.querySelector('[data-testid="mock-open-chats"]') as HTMLElement)
    expect(harness.container.querySelector('[data-testid="mock-chat-area"]')).toBe(chatArea)
    expect(chatArea.getAttribute('data-bumps'), 'local UI state survives the contacts round trip').toBe('2')
    expect(surface!.style.visibility).toBe('')
    expect(surface!.hasAttribute('inert')).toBe(false)
    expect(chatAreaProbe.mounts, 'exactly one mount across boot → contacts → chats').toBe(1)
  })

  it('has no separate chat page on the desktop with a session page (gugu-dev#181)', async () => {
    await renderMainLayoutWithToast()
    await clickElement(harness.container.querySelector('[data-testid="mock-open-chats"]') as HTMLElement)
    expect(chatSurfaceOf(harness.container)).toBeNull()
    expect(harness.container.textContent).not.toContain('chat-list-panel')
  })
  // 创建面(新建 agent)盖在聊天区上时,聊天区只隐藏不卸载:从前条件卸载,关掉创建面回来整个面板重挂
  // (消息列表、滚动位置、分栏、群协作状态全部重来 = 那一下白闪)。
  it('keeps the chat area mounted and merely hidden under the create surface', async () => {
    platformMock.kind = 'web'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const chatArea = harness.container.querySelector('[data-testid="mock-chat-area"]') as HTMLElement
    expect(chatArea.getAttribute('data-hidden')).toBe('false')
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-area-bump"]') as HTMLElement)
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-create-agent"]') as HTMLElement)
    expect(harness.container.querySelector('[data-testid="mock-acp-agent-create-composer"]')).toBeTruthy()
    expect(harness.container.querySelector('[data-testid="mock-chat-area"]'), 'opening the create surface must not unmount the chat area').toBe(chatArea)
    expect(chatArea.getAttribute('data-hidden')).toBe('true')
    const shell = chatArea.parentElement as HTMLElement
    expect(shell.style.visibility).toBe('hidden')
    expect(shell.hasAttribute('inert')).toBe(true)
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-row"]') as HTMLElement)
    expect(harness.container.querySelector('[data-testid="mock-acp-agent-create-composer"]')?.closest('[style*="display: none"]')).toBeTruthy()
    expect(harness.container.querySelector('[data-testid="mock-chat-area"]')).toBe(chatArea)
    expect(chatArea.getAttribute('data-hidden')).toBe('false')
    expect(chatArea.getAttribute('data-bumps'), 'local UI state survives the create-surface round trip').toBe('1')
    expect(chatAreaProbe.mounts).toBe(1)
  })
  it('keeps the agent-watch root mounted across every mobile tab (#6610)', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    expect(agentWatchProbe.rootMounts, 'mounted on the chats tab, before the tasks tab was ever opened').toBe(1)
    const nav = (id: string) => harness.container.querySelector(`[data-testid="${id}"]`) as HTMLElement
    await clickElement(nav(AUTOMATION_TEST_IDS.mobileSessionsNav))
    expect(harness.container.querySelector('[data-testid="mock-agent-watch-page"]'), 'positive control: the tasks page did open').toBeTruthy()
    await clickElement(nav(AUTOMATION_TEST_IDS.mobileContactsNav))
    // #6730 起会话页是横滑分页器里的一页,切走也挂着(相邻页要看得见),只被告知已离开、自己回到根上。
    expect(harness.container.querySelector('[data-testid="mock-agent-watch-page"]')?.getAttribute('data-active')).toBe('false')
    await clickElement(nav(AUTOMATION_TEST_IDS.mobileMessagesNav))
    expect(agentWatchProbe.rootMounts).toBe(1)
    expect(agentWatchProbe.rootUnmounts, 'no tab switch may tear the subscription down').toBe(0)
  })
  it('does not mount the agent-watch root on the desktop shell', async () => {
    await renderMainLayoutWithToast()
    expect(agentWatchProbe.rootMounts).toBe(0)
  })
  // 选中 ≠ 在看:手机上退回列表、切到别的 tab 之后,选中那条会话不算摆在屏幕上。
  it('reports the selected chat as on screen only while the mobile chat pane shows it (#6610)', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    chatStoreMock.chats = [{ id: 'chat-1' }]
    chatStoreMock.activeChatId = 'chat-1'
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const chatArea = () => harness.container.querySelector('[data-testid="mock-chat-area"]') as HTMLElement
    expect(chatOnScreen(), 'cold start lands on the list: selected but not shown').toBeNull()
    expect(chatArea().getAttribute('data-hidden')).toBe('true')
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-row"]') as HTMLElement)
    expect(chatOnScreen(), 'positive control: inside the chat pane it is on screen').toBe('chat-1')
    expect(chatArea().getAttribute('data-hidden')).toBe('false')
    await act(async () => {
      window.dispatchEvent(new CustomEvent('gugu:native-back'))
      await Promise.resolve()
    })
    expect(chatOnScreen(), 'back to the list').toBeNull()
    expect(chatArea().getAttribute('data-hidden')).toBe('true')
    // 会话页里没有底部 tab 栏:切 tab 只能先退回列表;回到对话 tab 落在列表上。
    await clickElement(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.mobileContactsNav}"]`) as HTMLElement)
    expect(chatOnScreen(), 'another tab').toBeNull()
    await clickElement(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.mobileMessagesNav}"]`) as HTMLElement)
    expect(chatOnScreen(), 'back on the chats tab, but on the list').toBeNull()
    expect(chatArea().getAttribute('data-hidden')).toBe('true')
  })
  // #6730 横滑分页器:四页顺序与底部 tab 栏同一份(SIDEBAR_TABS),只有当前页可交互。
  it('lays the mobile tab pages out in the tab bar order, with only the active page interactive', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const pages = [...harness.container.querySelectorAll<HTMLElement>('[data-mobile-tab-pager] > [data-mobile-tab-page]')]
    expect(pages.map((page) => page.dataset.mobileTabPage)).toEqual(SIDEBAR_TABS)
    const navIds = [AUTOMATION_TEST_IDS.mobileSessionsNav, AUTOMATION_TEST_IDS.mobileMessagesNav, AUTOMATION_TEST_IDS.mobileContactsNav, AUTOMATION_TEST_IDS.mobileProfileNav]
    const buttons = [...harness.container.querySelectorAll<HTMLElement>('nav button')]
    expect(buttons.map((button) => button.dataset.testid)).toEqual(navIds)
    expect(pages.filter((page) => !page.hasAttribute('inert')).map((page) => page.dataset.mobileTabPage)).toEqual(['chats'])
    expect(harness.container.querySelector('[data-testid="mock-contacts-panel"]'), 'a neighbour page is mounted so a drag can reveal it').toBeTruthy()
  })
  // #7199 owner 10-16「助理是咕咕底栏里的一格」:开得了个人助理时它排第一(分页器与底栏同一份顺序),咕咕底栏一直在。
  it('puts the assistant first in the pager and the tab bar when it is available', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    phoneAssistantMock.state.available = true
    phoneAssistantMock.state.assistant = { id: 'agent-1', display_name: '小咕', avatar: null, created_at: null }
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const pages = [...harness.container.querySelectorAll<HTMLElement>('[data-mobile-tab-pager] > [data-mobile-tab-page]')]
    expect(pages.map((page) => page.dataset.mobileTabPage)).toEqual(mobileTabs(true))
    const buttons = [...harness.container.querySelectorAll<HTMLElement>('nav button')]
    expect(buttons.map((button) => button.dataset.testid)).toEqual([
      AUTOMATION_TEST_IDS.mobileAssistantNav,
      AUTOMATION_TEST_IDS.mobileSessionsNav,
      AUTOMATION_TEST_IDS.mobileMessagesNav,
      AUTOMATION_TEST_IDS.mobileContactsNav,
      AUTOMATION_TEST_IDS.mobileProfileNav,
    ])
    // 格名固定「咕咕」(owner 10-16),不跟着它改名;进去之后页头才是它自己的名字。
    expect(buttons[0].textContent, 'the cell name is fixed').toContain('咕咕')
    expect(buttons[0].textContent).not.toContain('小咕')
    expect(buttons[1].textContent, 'the old 任务 cell is 项目 now').toContain('项目')
    // 冷启动仍落在对话列表,❌ 因为多了一格就换了落地页。
    expect(pages.filter((page) => !page.hasAttribute('inert')).map((page) => page.dataset.mobileTabPage)).toEqual(['chats'])
    await clickElement(buttons[0])
    expect(pages.filter((page) => !page.hasAttribute('inert')).map((page) => page.dataset.mobileTabPage)).toEqual(['assistant'])
    expect((harness.container.querySelector('[data-testid="mock-assistant-tab"]') as HTMLElement).dataset.visible).toBe('true')
    expect(harness.container.querySelector('nav'), 'the tab bar stays while the assistant is on screen').toBeTruthy()
  })
  it('opens the assistant tab when global settings requests its phone connectors', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    phoneAssistantMock.state.available = true
    phoneAssistantMock.state.assistant = { id: 'agent-1', display_name: '小咕', avatar: null, created_at: null }
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    await act(async () => { window.dispatchEvent(new Event(UI_EVENTS.openAssistantConnectors)) })
    expect(harness.container.querySelector('[data-mobile-tab-page="assistant"]')?.hasAttribute('inert')).toBe(false)
    expect(harness.container.querySelector('[data-testid="mock-assistant-tab"]')?.getAttribute('data-visible')).toBe('true')
  })
  // owner 10-16「得考虑最开始没有创建咕咕的新用户」:没有它,这一格照样在,图标是淡一点的默认咕咕 + 小「+」,点进去是安家引导。
  it('keeps the assistant cell first for a new user with no assistant, and marks it as the place to set one up', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    phoneAssistantMock.state.available = true
    phoneAssistantMock.state.assistant = null
    phoneAssistantMock.state.stage = { stage: 'onboarding' }
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const pages = [...harness.container.querySelectorAll<HTMLElement>('[data-mobile-tab-pager] > [data-mobile-tab-page]')]
    expect(pages.map((page) => page.dataset.mobileTabPage)).toEqual(mobileTabs(true))
    const first = harness.container.querySelector<HTMLElement>('nav button')!
    expect(first.dataset.testid).toBe(AUTOMATION_TEST_IDS.mobileAssistantNav)
    expect(first.textContent).toContain('咕咕')
    const icon = first.querySelector<HTMLElement>('[data-testid="mobile-assistant-nav-default"]')
    expect(icon, 'the default 咕咕 icon').toBeTruthy()
    expect(icon!.hasAttribute('data-fresh'), 'a small + while there is no assistant yet').toBe(true)
    await clickElement(first)
    expect(pages.filter((page) => !page.hasAttribute('inert')).map((page) => page.dataset.mobileTabPage)).toEqual(['assistant'])
  })
  it('shows the plain default 咕咕 (no +) while it is still being read', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    phoneAssistantMock.state.available = true
    phoneAssistantMock.state.assistant = null
    phoneAssistantMock.state.stage = { stage: 'identity' }
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const icon = harness.container.querySelector<HTMLElement>('nav [data-testid="mobile-assistant-nav-default"]')
    expect(icon).toBeTruthy()
    expect(icon!.hasAttribute('data-fresh'), '❌ say "set it up" before knowing there is none').toBe(false)
  })
  it('has no assistant cell where the assistant cannot be opened', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const pages = [...harness.container.querySelectorAll<HTMLElement>('[data-mobile-tab-pager] > [data-mobile-tab-page]')]
    expect(pages.map((page) => page.dataset.mobileTabPage)).toEqual(SIDEBAR_TABS)
    expect(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.mobileAssistantNav}"]`)).toBeNull()
    expect(harness.container.querySelector('[data-testid="mock-assistant-tab"]')).toBeNull()
  })
  // 对话列表里点和它的私聊 = 切到助理那一格,❌ 在对话页里另开一屏(owner:「点进去成两个 app 了」)。
  it('opens the assistant cell, not the chat page, when its private chat is picked from the list', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    phoneAssistantMock.state.available = true
    phoneAssistantMock.state.assistant = { id: 'agent-1', display_name: '小咕', avatar: null, created_at: null }
    phoneAssistantMock.state.chatId = 'dm-assistant'
    chatStoreMock.chats = [{ id: 'dm-assistant' }]
    chatStoreMock.activeChatId = 'dm-assistant'
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const pages = () => [...harness.container.querySelectorAll<HTMLElement>('[data-mobile-tab-pager] > [data-mobile-tab-page]')]
    const live = () => pages().filter((page) => !page.hasAttribute('inert')).map((page) => page.dataset.mobileTabPage)
    expect(live(), 'positive control: with the chat list on screen the chats page is the live one').toEqual(['chats'])
    const request = () => Number((harness.container.querySelector('[data-testid="mock-assistant-tab"]') as HTMLElement).dataset.chatRequest)
    const before = request()
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-row"]') as HTMLElement)
    expect(live()).toEqual(['assistant'])
    expect(request(), 'the cell is told to land on its chat segment').toBeGreaterThan(before)
    expect(chatOnScreen(), 'the chat page does not also claim the chat as seen').toBeNull()
  })
  it('switches tab only once the pager settles on a whole page, and aligns the pager when a tab is tapped', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const pager = harness.container.querySelector('[data-mobile-tab-pager]') as HTMLElement
    const page = (tab: string) => harness.container.querySelector(`[data-mobile-tab-page="${tab}"]`) as HTMLElement
    pager.getBoundingClientRect = () => ({ width: 390 }) as DOMRect
    let scrollLeft = 0
    Object.defineProperty(pager, 'scrollLeft', { configurable: true, get: () => scrollLeft, set: (value: number) => { scrollLeft = value } })
    const scrollTo = async (value: number) => {
      scrollLeft = value
      await act(async () => { pager.dispatchEvent(new Event('scroll')) })
    }
    await scrollTo(585)
    expect(page('contacts').hasAttribute('inert'), 'half-way between pages is not a switch').toBe(true)
    expect(page('chats').hasAttribute('inert')).toBe(false)
    // owner 10-07:选中态不切,tab 栏的亮暗却已经跟着手指走到两格中间。
    const position = () => (harness.container.querySelector('nav') as HTMLElement).style.getPropertyValue('--gg-tab-position')
    expect(position(), 'the tab bar gets the continuous position while dragging').toBe('1.5')
    await scrollTo(780)
    expect(page('contacts').hasAttribute('inert')).toBe(false)
    expect(page('chats').hasAttribute('inert')).toBe(true)
    expect(position()).toBe('2')
    await clickElement(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.mobileProfileNav}"]`) as HTMLElement)
    expect(scrollLeft, 'a tab tap jumps the pager to that page').toBe(1170)
    expect(page('settings').hasAttribute('inert')).toBe(false)
    expect(position(), 'a tab tap lights that tab at once').toBe('3')
  })
  it('locks horizontal paging while a full-screen sub-page is open', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    chatStoreMock.chats = [{ id: 'chat-1' }]
    chatStoreMock.activeChatId = 'chat-1'
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const pager = harness.container.querySelector('[data-mobile-tab-pager]') as HTMLElement
    expect(pager.style.overflowX).toBe('auto')
    await clickElement(harness.container.querySelector('[data-testid="mock-chat-row"]') as HTMLElement)
    expect(pager.style.overflowX, 'inside a conversation the gesture belongs to that page').toBe('hidden')
    await act(async () => {
      window.dispatchEvent(new CustomEvent('gugu:native-back'))
      await Promise.resolve()
    })
    expect(pager.style.overflowX).toBe('auto')
  })
  // 「我的」常驻在分页器里:离开后再直达某个 section(充值 → 用量),落在那个 section 上,❌ 停在上次看的那页。
  it('reopens the retained settings page on the section a deep link asks for', async () => {
    platformMock.kind = 'capacitor'
    platformMock.capabilities.sessionHost = false
    await harness.render(createNode(MainLayout, { user: { id: 'user-1', email: 'user@example.com', nickname: 'User' } }))
    const settings = () => harness.container.querySelector('[data-mobile-tab-page="settings"] [data-testid="mock-settings-panel"]') as HTMLElement
    const recharge = () => act(async () => { rechargeProbe.onRecharge?.() })
    await recharge()
    expect(settings().getAttribute('data-section')).toBe('usage')
    await clickElement(harness.container.querySelector('[data-testid="mock-settings-pick-about"]') as HTMLElement)
    expect(settings().getAttribute('data-section'), 'positive control: the user moved on inside the panel').toBe('about')
    await act(async () => {
      window.dispatchEvent(new CustomEvent('gugu:native-back'))
      await Promise.resolve()
    })
    await clickElement(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.mobileMessagesNav}"]`) as HTMLElement)
    expect(settings().getAttribute('data-section'), 'off its tab the page is back at its root').toBe('account')
    await recharge()
    expect(settings().getAttribute('data-section')).toBe('usage')
  })
  // 桌面壳不分页:两层包裹都是 display:contents,聊天面照旧直接参与主区 flex 布局。
  it('keeps the desktop layout flat around the pager wrappers', async () => {
    platformMock.kind = 'web'
    platformMock.capabilities.sessionHost = false
    await renderMainLayoutWithToast()
    expect(harness.container.querySelector('[data-mobile-tab-pager]')).toBeNull()
    const page = chatSurfaceOf(harness.container)?.parentElement as HTMLElement
    expect(page.style.display).toBe('contents')
    expect((page.parentElement as HTMLElement).style.display).toBe('contents')
  })
  it('reports the selected chat as on screen on the desktop chats tab only', async () => {
    chatStoreMock.chats = [{ id: 'chat-1' }]
    chatStoreMock.activeChatId = 'chat-1'
    await renderMainLayoutWithToast()
    expect(chatOnScreen(), 'boot lands on the tasks tab').toBeNull()
    await clickElement(harness.container.querySelector('[data-testid="mock-open-chats"]') as HTMLElement)
    expect(chatOnScreen()).toBe('chat-1')
    await clickElement(harness.container.querySelector('[data-testid="mock-open-tasks"]') as HTMLElement)
    expect(chatOnScreen()).toBeNull()
  })
})

// gugu.files.openWith from wherever the page is (an App's own page, a session's tab, another chat's panel): the chat shell
// brings the file's chat up and hands its panel the file with the host's answer — the one route, as a link to the file.
describe('MainLayout: files.openWith', () => {
  const detail = { chatId: 'g-open', itemId: 'F1', name: 'F1.md', typedName: 'F1.md', choice: { kind: 'none' } }

  it.each([false, true])('a topic file opens the shared source slot before the request is taken (blocks=%s)', async (blocks) => {
    platformMock.capabilities.sessionHost = blocks
    chatStoreMock.chats = [{ id: 'source', kind: 'group' }, { id: 'topic-file', kind: 'topic', source_chat_id: 'source', name: 'Topic' }] as never
    const restore = vi.fn()
    await renderMainLayoutWithToast()
    await act(async () => { window.dispatchEvent(new CustomEvent('gugu:open-group-file', { cancelable: true, detail: { chatId: 'topic-file', itemId: 'F1', restore } })) })
    if (blocks) expect(sessionPageViewRequests.openChat).toHaveBeenCalledWith('source', false)
    else expect(chatStoreMock.setActiveChatId).toHaveBeenCalledWith('source')
    expect(drainTopicSplitRequest('source')).toBeNull()
    expect(groupSlotMemory.takeFile('source')).toEqual({ itemId: 'F1', restore })
    expect(groupSlotMemory.takeFile('topic-file')).toBeNull()
  })

  it('the file\'s chat comes up and its panel is asked for the file, with the host\'s answer', async () => {
    chatStoreMock.chats = [{ id: 'g-open', kind: 'group', name: 'G' } as never]
    await renderMainLayoutWithToast()
    await act(async () => { window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail })) })
    // 桌面上对话是会话页这屏的一块:请会话页把它摆出来。
    expect(sessionPageViewRequests.openChat).toHaveBeenCalledWith('g-open', false)
    expect(groupSlotMemory.takeFile('g-open')).toEqual({ itemId: 'F1', opener: detail })
  })

  it('a message file request keeps its originating message for the native preview actions', async () => {
    chatStoreMock.chats = [{ id: 'g-open', kind: 'group', name: 'G' } as never]
    const message = { id: 'message-origin', content: 'attachment', retracted_at: null }
    await renderMainLayoutWithToast()
    const restore = vi.fn()
    const event = new CustomEvent('gugu:open-group-file', { cancelable: true, detail: { chatId: 'g-open', itemId: 'F1', message, restore } })
    await act(async () => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(groupSlotMemory.takeFile('g-open')).toEqual({ itemId: 'F1', message, restore })
  })

  it('a chat the person is not in: said, and nothing asked of any panel', async () => {
    chatStoreMock.chats = []
    const { toast } = await renderMainLayoutWithToast()
    await act(async () => { window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail })) })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.setActiveChatId).not.toHaveBeenCalled()
    expect(sessionPageViewRequests.openChat).not.toHaveBeenCalled()
    expect(groupSlotMemory.takeFile('g-open')).toBeNull()
  })
})

// Links and notifications retain the topic address. Files open the shared source slot.
describe('MainLayout: opening a topic on the desktop', () => {
  // 对话链接只认 UUID 形的对话 id(真对话就是这样)。
  const SRC = '0b1e7c1a-0000-4000-8000-000000000001'
  const TOPIC = '0b1e7c1a-0000-4000-8000-000000000002'
  const ways: Array<[string, () => void, string]> = [
    ['a conversation link', () => { openConversationLink(conversationLink(TOPIC)) }, TOPIC],
    ['a notification', () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.notificationClicked, { detail: { chatId: TOPIC } })) }, TOPIC],
    ['an App naming it', () => { window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail: { chatId: TOPIC, itemId: 'F1', name: 'F1.md', typedName: 'F1.md', choice: { kind: 'none' } } })) }, SRC],
  ]
  it.each(ways)('from %s, through the one door', async (_way, open, target) => {
    chatStoreMock.chats = [{ id: SRC, kind: 'group', name: '咕咕内测群' }, { id: TOPIC, kind: 'topic', name: '登录页白屏', source_chat_id: SRC }] as never
    await renderMainLayoutWithToast()
    await act(async () => {
      open()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })
    expect(sessionPageViewRequests.openChat).toHaveBeenCalledWith(target, false)
    if (target === SRC) expect(drainTopicSplitRequest(SRC)).toBeNull()
  })
})


describe('MainLayout: an App requested from a topic uses the shared source slot', () => {
  it.each([UI_EVENTS.openApp, APP_OPEN_IN_CHAT_EVENT])('%s resolves a topic absent from the local list without opening a split', async (eventName) => {
    chatStoreMock.chats = [{ id: 'source-app', kind: 'group' }] as never
    resourceChat.mockResolvedValueOnce('source-app')
    await renderMainLayoutWithToast()
    await act(async () => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: { chatId: 'topic-app', extensionId: 'board' } }))
    })
    expect(resourceChat).toHaveBeenLastCalledWith('layout-token', 'topic-app', 'user-1')
    expect(sessionPageViewRequests.openChat).toHaveBeenCalledWith('source-app', false)
    expect(groupSlotMemory.takeApp('source-app')).toBe('board')
    expect(groupSlotMemory.takeApp('topic-app')).toBeNull()
    expect(drainTopicSplitRequest('source-app')).toBeNull()
  })
})
