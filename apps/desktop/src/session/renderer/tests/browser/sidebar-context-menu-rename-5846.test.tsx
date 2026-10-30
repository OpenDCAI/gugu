/**
 * #5846 侧栏会话行右键「重命名」:打开统一的 session rename modal,并把提交落到右键点名的
 * conversation,而不是原地替换侧栏行或依赖当前键盘光标。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

const renameSession = vi.fn((_sessionId: string, _rowSessionId: string, _title: string) =>
  Promise.resolve()
)

vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: {
    get: (sessionId: string) => ({
      renameSession: (rowSessionId: string, title: string) =>
        renameSession(sessionId, rowSessionId, title),
      sessions: {
        get: () => ({
          data: {
            providerId: 'claude',
            title: '我们目前的软件更新蛮奇怪的',
            isPinned: false,
            lastInteractedAt: new Date(Date.now() - 22 * 60_000).toISOString(),
          },
          status: 'idle',
        }),
      },
    }),
  },
}))

/**
 * 这一格刻意把世界摆成「右键的这一行不在键盘链上、主区停在另一条会话」——验证菜单
 * 传给弹窗的是它自己的 conversationId,而不是当前 view 的会话。
 */
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    projects: { projects: new Map() },
    navigation: {
      currentViewId: 'session',
      viewParamsStore: { session: { projectId: 'proj-1', sessionId: 'task-other' } },
    },
  },
  sidebarStore: {
    remoteSession: () => undefined,
    navChain: [
      { kind: 'conversation', projectId: 'proj-1', sessionId: 'conv-other' },
    ],
    agentNameOnHoverEnabled: false,
    expandedProjectIds: new Set<string>(),
    // #7199 行上「助理发起」的标记问 store;这里的会话都不是个人助理派的。
    launchedByAssistant: () => false,
  },
}))
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { isLoaded: true, manifestFor: () => undefined, appName: () => undefined },
  // 资源库「扩展」那一格按机器各起一份清单(extensions-host.ts),侧栏经 use-agents 间接带上它。
  InstalledExtensionsStore: class {},
}))
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({
  requestArchiveSession: () => undefined,
  archiveSessionNow: () => undefined,
  confirmArchive: () => undefined,
}))
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({
  openSessionInSessionWhenReady: () => undefined,
}))
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: {} }),
  useWorkspaceSlots: () => ({ currentView: 'task' }),
}))

import { SidebarSessionItem } from '@renderer/features/sidebar/sidebar-session-item'
import { sessionAgentNames } from '@renderer/features/sessions/stores/session-agent-names'
import { SessionKeyboardNavListener } from '@renderer/features/sidebar/session-keyboard-nav-listener'
import { sessionNavigationFocus } from '@renderer/features/sidebar/session-navigation-focus'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer'
import { modalStore } from '@renderer/lib/modal/modal-store'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  host.style.width = '260px'
  document.body.append(host)
  root = createRoot(host)
  renameSession.mockClear()
  sessionAgentNames.identities.clear()
  modalStore.closeModal()
})

afterEach(() => {
  modalStore.closeModal()
  root.unmount()
  host.remove()
})

function mount(): void {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <SessionKeyboardNavListener />
        <ModalRenderer />
        <SidebarSessionItem projectId="proj-1" sessionId="conv-1" />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

const renameInput = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')

/** 右键这一行 → 点菜单里的「重命名」。 */
async function 右键改名(): Promise<void> {
  await until('sidebar row mounted', () => host.querySelectorAll('[data-session-id]').length === 1)
  const row = host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!
  row.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
  )
  await until(
    'context menu items render',
    () => document.querySelectorAll('[data-slot="context-menu-item"]').length > 0
  )
  const items = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')
  )
  const item = items.find((el) => /重命名|Rename/.test(el.textContent ?? ''))
  expect(items.filter((el) => /重命名|Rename/.test(el.textContent ?? ''))).toHaveLength(1)
  expect(
    item,
    `菜单里该有「重命名」这一格,实际:${items.map((i) => i.textContent).join(' | ')}`
  ).toBeDefined()
  await userEvent.click(item!)
}

it('#5846 右键「重命名」:打开统一弹窗并保持可交互', async () => {
  mount()
  sessionNavigationFocus.focusLayer = 'nav'
  await 右键改名()

  await until('rename modal input renders', () => renameInput() !== null)
  expect(renameInput(), 'rename modal must remain mounted').not.toBeNull()
  expect(modalStore.activeModalId).toBe('renameSessionModal')
})

it('uses the canonical name and offers only one task/agent rename entry', async () => {
  sessionAgentNames.note('conv-1', 'Canonical identity', 'agent-1')
  mount()
  sessionNavigationFocus.focusLayer = 'nav'
  await 右键改名()
  expect(modalStore.activeModalArgs).toMatchObject({ sessionId: 'conv-1', currentTitle: 'Canonical identity' })
})

it('#5846 改的是右键那一行 —— 与键盘光标 / 主区停在哪条会话无关', async () => {
  mount()
  sessionNavigationFocus.focusLayer = 'nav'
  await 右键改名()
  await until('rename modal input renders', () => renameInput() !== null)

  const input = renameInput()!
  expect(modalStore.activeModalArgs).toMatchObject({
    sessionId: 'conv-1',
    currentTitle: '我们目前的软件更新蛮奇怪的',
  })

  await userEvent.fill(input, '改好的名字')
  await userEvent.keyboard('{Enter}')

  await until('rename submitted', () => renameSession.mock.calls.length > 0)
  expect(renameSession.mock.calls.length).toBe(1)
  expect(
    renameSession.mock.calls[0],
    '要落到这一行自己的会话上'
  ).toEqual(['conv-1', 'conv-1', '改好的名字'])
})
