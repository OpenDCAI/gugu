// @vitest-environment jsdom
import { act, StrictMode, useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../../apps/desktop/src/App'
import { createNode, createReactHarness } from '../../../support/testHarness'

type SessionUser = { id: string; email: string; nickname: string }

const probe = vi.hoisted(() => ({
  calls: [] as Array<{ accountId: string | null; owner: string }>,
  shellCommits: [] as Array<{ accountId: string; release: () => void; root: HTMLElement }>,
  presenceStates: [] as Array<string | null>,
  lateCompletions: [] as Array<() => void>,
  listeners: new Set<() => void>(),
  session: {
    status: 'authenticated',
    user: { id: 'account-a', email: 'a@example.com', nickname: 'A' } as SessionUser | null,
  },
}))

function useOwnerProbe(owner: string, active: boolean, accountId = probe.session.user?.id ?? null) {
  useEffect(() => {
    if (!active) return
    let current = true
    probe.calls.push({ accountId, owner })
    probe.lateCompletions.push(() => {
      if (current) probe.calls.push({ accountId, owner: `${owner}:completion` })
    })
    return () => { current = false }
  }, [accountId, active, owner])
}

vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({
  sessionCoordinator: {
    getAccessToken: vi.fn(async () => null),
    getSnapshot: () => probe.session,
    logout: vi.fn(async () => ({ success: true })),
    start: () => () => {},
    subscribe: (listener: () => void) => {
      probe.listeners.add(listener)
      return () => probe.listeners.delete(listener)
    },
    updateUser: vi.fn(),
  },
}))

vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false },
    documentTitle: 'Gugu',
    installUpdate: vi.fn(),
    kind: 'electron',
    sendRendererCommandReady: vi.fn(),
    sendRendererCommandResult: vi.fn(),
    showNotification: vi.fn(),
  },
}))

vi.mock('../../../../apps/desktop/src/rpc-renderer/rendererRpc', () => ({
  useRendererRpcHandlers: vi.fn(),
}))

// #7348 首次引导的门在产品之前读一次账号进度;这里的账号都是走完了的老账号(门直接放行),这条读数不算产品的数据 owner。
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => ({
  readFirstRunProgress: vi.fn(async () => ({ stage: 'done', occupation: null })),
  writeOccupation: vi.fn(),
  finishFirstRun: vi.fn(),
  requestAssistantSetupHandoff: vi.fn(),
  takeAssistantOpenRequest: vi.fn(() => false),
  takeAssistantStartAtHome: vi.fn(() => false),
  readOccupation: vi.fn(async () => null),
}))

vi.mock('../../../../apps/desktop/src/store/theme', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ThemeProvider: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

vi.mock('../../../../apps/desktop/src/components/Toast', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ToastProvider: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

vi.mock('../../../../apps/desktop/src/layouts/MainLayout', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    MainLayout: ({
      user,
      effectsActive = true,
      onShellCommitted,
    }: {
      user: SessionUser
      effectsActive?: boolean
      onShellCommitted?: () => void
    }) => {
      const rootRef = React.useRef<HTMLElement | null>(null)
      const registeredRef = React.useRef(false)
      React.useEffect(() => {
        if (registeredRef.current || !rootRef.current || !onShellCommitted) return
        registeredRef.current = true
        probe.shellCommits.push({ accountId: user.id, release: onShellCommitted, root: rootRef.current })
      }, [onShellCommitted, user.id])
      useOwnerProbe('contacts', effectsActive, user.id)
      useOwnerProbe('devices', effectsActive, user.id)
      useOwnerProbe('low-balance-billing', effectsActive, user.id)
      useOwnerProbe('sidebar-billing', effectsActive, user.id)
      return React.createElement('main', {
        ref: rootRef,
        'data-gugu-shell-phase': effectsActive ? 'active' : 'committed-inert',
      })
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/ImagePreviewProvider', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ImagePreviewProvider: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

vi.mock('../../../../apps/desktop/src/store/chat', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ChatProvider: ({ active = true, children }: { active?: boolean; children: ReactNode }) => {
      useOwnerProbe('chat', active)
      return React.createElement(React.Fragment, null, children)
    },
  }
})

vi.mock('../../../../apps/desktop/src/store/contacts', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ContactsProvider: ({ active = true, children }: { active?: boolean; children: ReactNode }) => {
      useOwnerProbe('contacts', active)
      return React.createElement(React.Fragment, null, children)
    },
  }
})

vi.mock('../../../../apps/desktop/src/store/devices', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    DevicesProvider: ({ active = true, children }: { active?: boolean; children: ReactNode }) => {
      useOwnerProbe('devices', active)
      return React.createElement(React.Fragment, null, children)
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/LowBalanceBanner', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    LowBalanceBanner: ({ user }: { user: SessionUser | null }) => {
      useOwnerProbe('low-balance-billing', user !== null, user?.id ?? null)
      return React.createElement(React.Fragment)
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/Sidebar', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    Sidebar: ({ effectsActive }: { effectsActive?: boolean }) => {
      useOwnerProbe('sidebar-billing', effectsActive !== false)
      return React.createElement('div', { className: 'gg-sidebar-rail' })
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/StarterContinuationHost', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    StarterContinuationHost: ({ active = true }: { active?: boolean }) => {
      useOwnerProbe('starter-continuation', active)
      return React.createElement(React.Fragment)
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/UnfinishedAgentCreateSweeper', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    UnfinishedAgentCreateSweeper: ({ active = true }: { active?: boolean }) => {
      useOwnerProbe('unfinished-sweep', active)
      return React.createElement(React.Fragment)
    },
  }
})

vi.mock('../../../../apps/desktop/src/components/UpdateBanner', () => ({ UpdateBanner: () => null }))
vi.mock('../../../../apps/desktop/src/pages/LoginPage', () => ({ LoginPage: () => createNode('div', null, 'login') }))
vi.mock('../../../../apps/desktop/src/pages/AgentJoinRoute', () => ({ AgentJoinRoute: () => null }))

vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({
  contactsService: {
    getContacts: vi.fn(async () => {
      probe.calls.push({ accountId: probe.session.user?.id ?? null, owner: 'app-contacts' })
      return []
    }),
  },
}))

vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore', () => ({
  setPresenceBusContext: ({ currentUserId }: { currentUserId: string | null }) => {
    probe.presenceStates.push(currentUserId)
    if (currentUserId) probe.calls.push({ accountId: currentUserId, owner: 'presence' })
  },
}))

vi.mock('../../../../apps/desktop/src/components/ChatListPanel', () => ({ ChatListPanel: () => null }))
vi.mock('../../../../apps/desktop/src/components/ChatAreaPanel', () => ({ ChatAreaPanel: () => null }))
vi.mock('../../../../apps/desktop/src/components/ContactsPanel', () => ({ ContactsPanel: () => null }))
vi.mock('../../../../apps/desktop/src/components/SettingsPanel', () => ({ SettingsPanel: () => null }))
vi.mock('../../../../apps/desktop/src/components/WindowControls', () => ({ WindowControls: () => null }))
vi.mock('../../../../apps/desktop/src/components/sessionpage/EmdashSessionFrame', () => ({
  EmdashSessionFrame: () => null,
  prewarmEmdashAssets: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/layouts/ResizableChatListPane', () => ({ ResizableChatListPane: () => null }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({
  useContactsStore: () => ({ contacts: [], pendingRequests: [] }),
}))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({
    activeChatId: null,
    chats: [],
    refreshChats: vi.fn(),
    setActiveChatId: vi.fn(),
    upsertChat: vi.fn(),
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/notificationSettings', () => ({
  useNotificationSettings: () => ({ messages: false, requests: false }),
}))
vi.mock('../../../../apps/desktop/src/lib/agentConversationEvents', () => ({
  AGENT_SESSION_STARTED_EVENT: 'agent-conversation-started',
  readAgentConversationStartedEvent: () => null,
}))

function setSessionUser(user: SessionUser | null) {
  probe.session = { status: user ? 'authenticated' : 'anonymous', user }
  probe.listeners.forEach((listener) => listener())
}

describe('authenticated product activation', () => {
  let harness: ReturnType<typeof createReactHarness>

  beforeEach(() => {
    harness = createReactHarness()
    probe.calls.length = 0
    probe.shellCommits.length = 0
    probe.presenceStates.length = 0
    probe.lateCompletions.length = 0
    probe.listeners.clear()
    probe.session = {
      status: 'authenticated',
      user: { id: 'account-a', email: 'a@example.com', nickname: 'A' },
    }
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('commits a network-inert account shell before activating every data owner once', async () => {
    await harness.render(createNode(StrictMode, null, createNode(App)))

    expect(probe.calls).toEqual([])
    expect(probe.presenceStates.at(-1)).toBeNull()
    expect(probe.shellCommits).toHaveLength(1)
    expect(probe.shellCommits[0].root.dataset.guguShellPhase).toBe('committed-inert')
    const staleACommit = probe.shellCommits[0]

    await act(async () => {
      setSessionUser({ id: 'account-b', email: 'b@example.com', nickname: 'B' })
      await Promise.resolve()
    })
    expect(probe.calls).toEqual([])
    expect(probe.shellCommits).toHaveLength(2)

    await act(async () => {
      staleACommit.release()
      await Promise.resolve()
    })
    expect(probe.calls).toEqual([])

    const currentBCommit = probe.shellCommits[1]
    await act(async () => {
      currentBCommit.release()
      await Promise.resolve()
    })
    const expectedOwners = [
      'chat', 'contacts', 'devices', 'low-balance-billing',
      'presence', 'sidebar-billing', 'starter-continuation', 'unfinished-sweep',
    ]
    expect(probe.calls.map((call) => call.owner).sort()).toEqual(expectedOwners)
    expect(probe.calls.every((call) => call.accountId === 'account-b' || call.accountId === null)).toBe(true)
    expect(probe.presenceStates.at(-1)).toBe('account-b')

    await act(async () => {
      currentBCommit.release()
      await Promise.resolve()
    })
    expect(probe.calls.map((call) => call.owner).sort()).toEqual(expectedOwners)

    const mountedCompletions = [...probe.lateCompletions]
    await act(async () => {
      setSessionUser(null)
      await Promise.resolve()
    })
    const afterLogout = probe.calls.length
    currentBCommit.release()
    mountedCompletions.forEach((complete) => complete())
    expect(probe.calls).toHaveLength(afterLogout)
    expect(probe.presenceStates.at(-1)).toBeNull()
  })
})
