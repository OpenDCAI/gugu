// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { ICON_BODIES } from '@gugu/session-ui/icon-bodies'
import { NeedsYouHost } from '../../../../apps/desktop/src/components/needsYou/NeedsYouHost'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { ChatBottomDock } from '../../../../apps/desktop/src/components/chat/ChatBottomDock'
import { LeftSidebar } from '@renderer/features/sidebar/left-sidebar'
import { ShellSidebarToggle } from '@renderer/lib/components/titlebar/shell-titlebar'
import { installShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { chat, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const state = vi.hoisted(() => ({ sessions: [] as SessionpageSessionSummary[], mobile: false, readError: null as Error | null, sidebar: undefined as unknown as {
  listLayout: string; listPage: string; setListLayout(value: string): void; setListPage(value: string): void
} }))
const followLink = vi.hoisted(() => vi.fn())
const markSeen = vi.hoisted(() => vi.fn(async (_id: string) => { if (state.readError) throw state.readError }))
vi.mock('@/lib/guguLinks', () => ({ followLink }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => state.mobile }))
vi.mock('@/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('@/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [{ device_id: 'server', label: 'Server', capabilities: {}, is_online: true }] }) }))
vi.mock('@/session/shared/remote-sessions/session-directory', async original => ({ ...await original<typeof import('@/session/shared/remote-sessions/session-directory')>(), useLiveDeviceSessions: () => ({ server: { cached: false, error: null, sessions: state.sessions } }) }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async original => ({ ...await original<typeof import('@/mobile/agent-watch/sessionpage-rpc')>(), machineRpc: () => ({ sessions: { markSessionSeen: markSeen } }) }))
vi.mock('@/lib/agentPresenceMobx', () => ({ observedAgentPresence: (id: string) => ({ presentation: presentAgentStatus({ reading: state.sessions.find(session => session.agent?.userId === id)?.status as never ?? null }) }) }))
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({ sessionAgentBindings: { start: () => {} } }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { start: () => {} } }))
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => null }))
vi.mock('@renderer/features/assistant/assistant-home-sessions', () => ({ localHomeSessions: { sessions: [] } }))
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }))
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: vi.fn() }), useWorkspaceSlots: () => ({ currentView: 'home' }), isCurrentView: (current: string, view: string) => current === view }))
vi.mock('@renderer/lib/layout/layout-provider', () => ({ useWorkspaceLayoutContext: () => ({ isLeftOpen: true, isLeftPeeking: false, toggleLeft: vi.fn(), setTriggerHovered: vi.fn() }) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
vi.mock('@renderer/lib/stores/app-state', async () => {
  const { observable } = await import('mobx')
  state.sidebar = observable({ projectsCollapsed: false, listLayout: 'split', listPage: 'projects', sidebarProjects: [], joinedGroups: [],
    setStateGroupsEnabled: () => {}, setAssistantAgentId: () => {}, setAgentNameOnHoverEnabled: () => {},
    setListLayout(value: string) { this.listLayout = value }, setListPage(value: string) { this.listPage = value } })
  return { appState: { projects: { projects: new Map(), ensureMounted: vi.fn() }, navigation: { currentViewId: 'home', viewParamsStore: {} } }, sidebarStore: state.sidebar }
})
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({ projectGroupsStore: { chatIdOf: () => undefined } }))
vi.mock('@renderer/features/sidebar/session-keyboard-nav', () => ({ sessionKeyboardNav: { cursor: null, syncCursorFromPointer: () => {} } }))
vi.mock('@renderer/features/sidebar/use-sidebar-drop', () => ({ useSidebarDrop: () => ({ isDragOver: false }) }))
vi.mock('@renderer/features/sidebar/pinned-session-list', () => ({ SidebarPinnedSessionList: () => null }))
vi.mock('@renderer/features/sidebar/projects-group-label', () => ({ ProjectsGroupLabel: () => null }))
vi.mock('@renderer/features/sidebar/sidebar-search-trigger', () => ({ SidebarSearchTrigger: () => <span>Search</span> }))
vi.mock('@renderer/features/sidebar/sidebar-sessions-section', () => ({ SidebarSessionsSection: () => null }))
vi.mock('@renderer/features/sidebar/sidebar-virtual-list', () => ({ SidebarVirtualList: () => <div data-original-project-list="">Original projects</div> }))
vi.mock('@renderer/features/sidebar/sidebar-chats-section', () => ({ shellChatActions: [], openShellChatAction: vi.fn(), SidebarChatsSection: () => <div data-original-chat-list="">Original chats</div> }))

let shell: ReturnType<typeof createReactHarness>
let workspace: ReturnType<typeof createReactHarness>
const observations = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element> }>()
function task(id: string, status: 'error' | 'needs_user' = 'needs_user', unseen = true): SessionpageSessionSummary {
  return { conversationId: id, projectId: 'project', title: id, harness: 'codex', runtime: 'acp', agentStatus: status,
    status: { status, detail: status === 'needs_user' ? 'approval' : null }, agent: { userId: id }, supported: true, unseen, lastInteractedAt: null }
}
beforeEach(() => {
  vi.clearAllMocks(); state.mobile = false; state.readError = null
  state.sessions = [task('agent-a'), task('agent-b')]
  delete (window as unknown as Record<string, unknown>).__GUGU_SIDEBAR_NOTIFICATIONS_OPEN__
  state.sidebar.setListLayout('split'); state.sidebar.setListPage('projects')
  installShellSlots(); observations.clear()
  vi.stubGlobal('IntersectionObserver', class {
    record: { callback: IntersectionObserverCallback; targets: Set<Element> }
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, targets: new Set() }; observations.add(this.record) }
    observe(target: Element) { this.record.targets.add(target) }
    disconnect() { observations.delete(this.record) }
  })
  shell = createReactHarness(); workspace = createReactHarness()
})
afterEach(() => { shell.cleanup(); workspace.cleanup(); vi.unstubAllGlobals() })
async function mount(mobile = false, hidden = false) {
  state.mobile = mobile
  if (!mobile) await workspace.render(<><ShellSidebarToggle /><LeftSidebar /></>)
  await renderWithAppProviders(shell, <>{mobile && <ChatListPanel mobile hidden={hidden} />}<NeedsYouHost /></>, {
    shellTab: 'chats', chat: { chats: [chat({ id: 'group-a', kind: 'group', member_user_ids: ['user-1', 'agent-a'] }), chat({ id: 'group-b', kind: 'group', member_user_ids: ['user-1', 'agent-b'] })] },
  })
}
const toggle = () => document.querySelector<HTMLButtonElement>('[data-testid="notification-toggle"]')
const list = () => document.querySelector<HTMLElement>('[data-testid="notification-list"]')
const rows = () => [...(list()?.querySelectorAll<HTMLElement>('[data-session-line]') ?? [])]
async function open() { expect(toggle(), 'the real list header owns a bell').not.toBeNull(); await act(async () => toggle()!.click()) }
async function see(id: string, ratio = 1) {
  const target = rows().find(row => row.dataset.sessionLine === id)!
  expect(target).toBeDefined()
  await act(async () => {
    for (const observation of [...observations]) if (observation.targets.has(target)) observation.callback([{
      target, time: performance.now(), isIntersecting: ratio > 0, intersectionRatio: ratio,
      boundingClientRect: target.getBoundingClientRect(), intersectionRect: new DOMRect(0, 0, 20, 20), rootBounds: new DOMRect(0, 0, 500, 500),
    }], {} as IntersectionObserver)
  })
}

it.each([false, true])('the actual list header toggles global notifications and back (phone=%s)', async mobile => {
  await mount(mobile)
  expect(document.querySelector('[data-testid="notification-count"]')?.textContent).toBe('2')
  expect(document.querySelector('[data-testid="sidebar-list-layout"]')).toBeNull()
  expect(list()).toBeNull()
  await open()
  expect(toggle()?.getAttribute('aria-pressed')).toBe('true')
  expect(rows().map(row => row.dataset.sessionLine)).toEqual(['agent-a', 'agent-b'])
  expect(document.querySelector('[data-testid="needs-you-sheet"]')).toBeNull()
  await act(async () => toggle()!.click())
  expect(toggle()?.getAttribute('aria-pressed')).toBe('false')
  expect(list()).toBeNull()
})
it('desktop toggling retains the original list nodes, scroll and split/merged choice', async () => {
  await mount()
  const scroller = workspace.container.querySelector<HTMLElement>('[data-region="sidebar-scroll"]')!
  scroller.scrollTop = 87
  const original = workspace.container.querySelector('[data-original-project-list]')
  await open()
  expect(workspace.container.querySelector('[data-original-project-list]')).toBe(original)
  expect(original?.closest('[data-notification-original-list]')?.getAttribute('style')).toContain('content-visibility: hidden')
  await act(async () => toggle()!.click())
  expect(scroller.scrollTop).toBe(87)
  expect(state.sidebar.listLayout).toBe('split')
  await act(async () => state.sidebar.setListLayout('merged'))
  await open(); await act(async () => toggle()!.click())
  expect(state.sidebar.listLayout).toBe('merged')
  expect(workspace.container.querySelector('[data-original-chat-list]')).not.toBeNull()
})
it('the old composer has no floating Needs you entrance', async () => {
  await renderWithAppProviders(shell, <><ChatBottomDock reserve={false}><textarea /></ChatBottomDock><NeedsYouHost /></>)
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).toBeNull()
})
it.each([false, true])('opening the bell reads nothing; a read failure stays listed, unemphasized and uncounted (phone=%s)', async mobile => {
  const failure = { ...task('error-a', 'error'), lastInteractedAt: '2026-11-05T01:00:00.000Z' }
  const wait = { ...task('approval', 'needs_user', false), lastInteractedAt: '2026-11-05T00:00:00.000Z' }
  state.sessions = [failure, wait]
  const marks = () => rows().map(row => ({ badge: row.querySelector('.gg-list-row-trailing [data-shape="count"]')?.textContent ?? null, muted: !!row.querySelector('.gg-list-row-title .text-\\[var\\(--muted-fg\\)\\]') }))
  await mount(mobile); await open()
  await see('error-a'); await see('approval')
  expect(markSeen, 'looking at the list is not reading the task').not.toHaveBeenCalled()
  expect(rows().map(row => row.querySelector('.gg-list-row-subtitle')?.textContent), 'the second line says why, not the name again').toEqual(['出错了', '等你批准'])
  expect(document.querySelector('[data-testid="notification-count"]')?.textContent).toBe('2')
  expect(rows().map(row => row.dataset.emphasis)).toEqual(['true', 'true'])
  expect(marks(), 'unread rows carry the chat list unread badge').toEqual([{ badge: '1', muted: false }, { badge: '1', muted: false }])
  // The host read bit lands (the task was opened); the person closes the bell and opens it again.
  state.sessions = [{ ...failure, unseen: false }, wait]
  await mount(mobile); await act(async () => toggle()!.click()); await open()
  expect(rows().map(row => row.dataset.sessionLine), 'a read failure is still a failure: it stays listed').toEqual(['error-a', 'approval'])
  expect(rows().map(row => row.dataset.emphasis)).toEqual([undefined, 'true'])
  expect(marks(), 'a read row is muted and has no badge').toEqual([{ badge: null, muted: true }, { badge: '1', muted: false }])
  expect(document.querySelector('[data-testid="notification-count"]')?.textContent).toBe('1')
  expect(document.querySelector('[data-testid="notification-mark-all-read"]'), 'nothing unread left to mark').toBeNull()
  // Its state, not its read bit, takes it off the list.
  state.sessions = [{ ...failure, unseen: false, agentStatus: 'idle', status: { status: 'idle', detail: null } }, wait]
  await mount(mobile)
  expect(rows().map(row => row.dataset.sessionLine)).toEqual(['approval'])
})
it('mark all reads global unexpanded errors across groups and leaves pending actions', async () => {
  state.sessions = [task('agent-a', 'error'), task('agent-b', 'error'), task('approval', 'needs_user', false)]
  await mount(); await open()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="notification-mark-all-read"]')!.click())
  expect(markSeen.mock.calls.map(([id]) => id).sort()).toEqual(['agent-a', 'agent-b'])
})
it('failed reads retain their item and display the original error', async () => {
  state.sessions = [task('error-a', 'error')]; state.readError = new Error('host write failed')
  await mount(); await open()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="notification-mark-all-read"]')!.click())
  expect(list()?.querySelector('[role="alert"]')?.textContent).toContain('host write failed')
  expect(rows()).toHaveLength(1)
})
it('a hidden phone list does not mount notification rows or acknowledge errors', async () => {
  state.sessions = [task('error-a', 'error')]
  await mount(true); await open(); await mount(true, true)
  expect(list()).toBeNull(); expect(markSeen).not.toHaveBeenCalled()
})
it.each(['Enter', ' '])('keyboard %s opens the exact task without changing its pending permission', async key => {
  await mount(); await open()
  await act(async () => rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
  expect(followLink).toHaveBeenCalledExactlyOnceWith({ kind: 'session', sessionId: 'agent-b', deviceId: 'server' })
  expect(markSeen).not.toHaveBeenCalled()
})
it.each([false, true])('clicking a global item opens its exact host task (phone=%s)', async mobile => {
  await mount(mobile); await open()
  await act(async () => rows()[1].click())
  expect(followLink).toHaveBeenCalledExactlyOnceWith({ kind: 'session', sessionId: 'agent-b', deviceId: 'server' })
})
it('phone and desktop show the same notifications for the same tasks: old read failures listed but uncounted, no ⚡, nothing above Messages', async () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString()
  state.sessions = [
    ...Array.from({ length: 40 }, (_, i) => ({ ...task(`old-${i}`, 'error', false), lastInteractedAt: at(1 + (i % 28)) })),
    { ...task('older-failure', 'error'), lastInteractedAt: at(3) },
    { ...task('wait', 'needs_user'), lastInteractedAt: at(30) },
    { ...task('newer-failure', 'error'), lastInteractedAt: at(20) },
  ]
  const shown: Array<{ count: string | undefined; rows: string[]; listed: number }> = []
  for (const mobile of [false, true]) {
    await mount(mobile); await open()
    const zap = /\sd="([^"]+)"/.exec(ICON_BODIES.Zap)![1]
    expect([...document.querySelectorAll('[data-session-line] svg path, [data-chat-row] svg path')].filter(path => path.getAttribute('d') === zap), 'no ⚡ on any row').toHaveLength(0)
    // Tasks live in the notification list only; the Messages list has none of them.
    expect([...document.querySelectorAll('[data-session-line]')].every(row => row.closest('[data-testid="notification-list"]'))).toBe(true)
    shown.push({ count: document.querySelector('[data-testid="notification-count"]')?.textContent ?? undefined, rows: rows().filter(row => row.dataset.emphasis).map(row => row.dataset.sessionLine!), listed: rows().length })
    await act(async () => toggle()!.click())
    shell.cleanup(); workspace.cleanup(); shell = createReactHarness(); workspace = createReactHarness(); installShellSlots()
  }
  expect(shown[0]).toEqual({ count: '3', rows: ['wait', 'newer-failure', 'older-failure'], listed: 43 })
  expect(shown[1]).toEqual(shown[0])
})
