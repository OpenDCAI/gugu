// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { AgentWatchPage, AgentWatchRoot } from '../../../apps/desktop/src/mobile/agent-watch/AgentWatchPage'
import { useAgentWatchAlerts, useAgentWatchFocus } from '../../../apps/desktop/src/mobile/agent-watch/useAgentWatchAlerts'
import { useLiveDeviceSessions, type DeviceSessions } from '../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { useDevicesStore } from '../../../apps/desktop/src/store/devicesContext'
import { createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'
import * as phoneSettings from '../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings'

vi.mock('../../../apps/desktop/src/mobile/local-agent/usePhoneAgentDirectory', () => ({ usePhoneAgentDirectory: vi.fn() }))

const deviceStore = vi.hoisted(() => ({ devices: [] as Device[] }))
const session = {
  conversationId: 'conversation-1',
  projectId: 'project-1',
  title: 'Task one',
  harness: 'claude',
  runtime: 'acp',
  agentStatus: 'working',
  lastInteractedAt: '2026-09-13T00:00:00.000Z',
  supported: true,
} satisfies SessionpageSessionSummary

vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: vi.fn(() => ({ devices: deviceStore.devices })),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchAlerts', () => ({
  requestAlertPermissionOnce: vi.fn(),
  useAgentWatchAlerts: vi.fn(),
  useAgentWatchFocus: vi.fn(),
}))
vi.mock('../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async (original) => ({
  // The real rules (rowOpens) — only the live reads are stood in for.
  ...(await original<typeof import('../../../apps/desktop/src/session/shared/remote-sessions/session-directory')>()),
  useLiveDeviceSessions: vi.fn(() => ({})),
  useAgentNames: () => new Map(),
  agentOfSession: () => undefined,
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/MachinesPage', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    // 只剩「新建会话先选机器」这一件事。
    MachinesPage: ({
      onBack,
      onOpenDevice,
    }: {
      onBack: () => void
      onOpenDevice: (device: Device) => void
    }) => React.createElement(
      'div',
      { 'data-testid': 'pick-machine' },
      React.createElement('button', { type: 'button', 'data-testid': 'machines-back', onClick: onBack }, 'back'),
      React.createElement('button', { type: 'button', 'data-testid': 'open-device', onClick: () => onOpenDevice(deviceStore.devices[0]) }, 'open'),
    ),
  }
})
vi.mock('../../../apps/desktop/src/mobile/agent-watch/ProjectsPage', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    ProjectsPage: ({
      onOpenSession,
      onCreate,
      reveal,
    }: {
      onOpenSession: (deviceId: string, next: SessionpageSessionSummary) => void
      onCreate?: () => void
      reveal?: { deviceId: string; sessionId: string }
    }) => React.createElement(
      'div',
      { 'data-testid': 'projects', 'data-reveal': reveal ? `${reveal.deviceId}|${reveal.sessionId}` : undefined },
      React.createElement('button', { type: 'button', 'data-testid': 'open-session', onClick: () => onOpenSession('device-1', session) }, 'open'),
      // 跨机器的子会话:画在父会话的项目分区里,住在另一台机器上。
      React.createElement('button', { type: 'button', 'data-testid': 'open-remote-child', onClick: () => onOpenSession('device-2', { ...session, conversationId: 'child-on-2' }) }, 'open child'),
      onCreate
        ? React.createElement('button', { type: 'button', 'data-testid': 'create-agent', onClick: onCreate }, 'create')
        : null,
    ),
  }
})
vi.mock('../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    SessionTimelinePage: ({ onBack, session: shown }: { onBack: () => void; session: SessionpageSessionSummary }) => React.createElement(
      'button',
      { type: 'button', 'data-testid': 'timeline-back', 'data-agent-status': shown.agentStatus, onClick: onBack },
      'back',
    ),
  }
})
vi.mock('../../../apps/desktop/src/mobile/agent-watch/CreateSessionPage', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    CreateSessionPage: ({
      device,
      onBack,
      onCreated,
    }: {
      device: Device
      onBack: () => void
      onCreated: (session: SessionpageSessionSummary, firstPrompt: string) => void
    }) => React.createElement(
      'div',
      { 'data-testid': 'create', 'data-device-id': device.device_id },
      React.createElement('button', { type: 'button', 'data-testid': 'create-back', onClick: onBack }, 'back'),
      React.createElement('button', { type: 'button', 'data-testid': 'create-done', onClick: () => onCreated(device.capabilities.host_kind === 'phone' ? { ...session, conversationId: 'made', supported: true, agent: { userId: 'phone-agent' } } : { ...session, conversationId: 'made' }, 'hello') }, 'done'),
    ),
  }
})

const mockedUseDevicesStore = vi.mocked(useDevicesStore)

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  deviceStore.devices = [{
    device_id: 'device-1',
    label: 'Mac',
    hostname: 'mac',
    platform: 'darwin',
    status: 'online',
    last_seen_at: '2026-09-13T00:00:00.000Z',
    is_online: true,
    capabilities: { terminals: [], runtimes: [] },
  }]
  mockedUseDevicesStore.mockImplementation(() => ({ devices: deviceStore.devices } as ReturnType<typeof useDevicesStore>))
})
afterEach(() => harness.cleanup())

// 安卓壳的返回键:派发原生壳用的同一个事件,读它有没有被接住。
function nativeBack(): boolean {
  (window as Window & { __guguNativeBackHandled?: boolean }).__guguNativeBackHandled = false
  window.dispatchEvent(new CustomEvent('gugu:native-back'))
  return Boolean((window as Window & { __guguNativeBackHandled?: boolean }).__guguNativeBackHandled)
}

describe('AgentWatchPage native back routing', () => {
  it('restores root navigation and watch focus when the opened device is removed', async () => {
    const onExit = vi.fn()
    const onRouteChange = vi.fn()
    const props = { active: true, onExit, onRouteChange }
    await harness.render(createNode(AgentWatchPage, props))
    await act(async () => { (harness.container.querySelector('[data-testid="open-session"]') as HTMLButtonElement).click() })
    expect(onRouteChange).toHaveBeenLastCalledWith('timeline')
    deviceStore.devices = []
    await harness.render(createNode(AgentWatchPage, props))
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    expect(onRouteChange).toHaveBeenLastCalledWith('projects')
    expect(vi.mocked(useAgentWatchFocus).mock.calls.at(-1)?.[0]).toBeNull()
    await act(async () => { expect(nativeBack()).toBe(true) })
    expect(onExit).toHaveBeenCalledOnce()
  })

  it('walks timeline and the new-session steps back before exiting the Projects tab', async () => {
    const onExit = vi.fn()
    await harness.render(createNode(AgentWatchPage, {
      active: true,
      onExit,
    }))

    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    await act(async () => {
      expect(nativeBack()).toBe(true)
      await Promise.resolve()
    })
    expect(onExit).toHaveBeenCalledTimes(1)

    await act(async () => {
      const button = harness.container.querySelector('[data-testid="open-session"]') as HTMLButtonElement
      button.click()
    })
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeTruthy()
    await act(async () => {
      expect(nativeBack()).toBe(true)
      await Promise.resolve()
    })
    expect(harness.container.querySelector('[data-testid="projects"]'), 'timeline goes back to the project list, not a machine page').toBeTruthy()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  // 订阅挂在移动壳根上(AgentWatchRoot);这张页只读那一份、只报正盯着哪条。
  it('never owns the alert subscription; it only reports which session it is watching', async () => {
    const hook = vi.mocked(useAgentWatchAlerts)
    const focus = vi.mocked(useAgentWatchFocus)
    hook.mockClear()
    focus.mockClear()
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn() }))
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    expect(hook, 'the page must not subscribe: the subscription lives on the shell root').not.toHaveBeenCalled()
    expect(focus.mock.calls.at(-1)?.[0] ?? null, 'nothing is being watched on the project list').toBeNull()
    await act(async () => {
      (harness.container.querySelector('[data-testid="open-session"]') as HTMLButtonElement).click()
    })
    expect(focus.mock.calls.at(-1)?.[0]).toEqual({ deviceId: 'device-1', sessionId: 'conversation-1' })

    await harness.render(createNode(AgentWatchRoot, {}))
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]).toEqual([deviceStore.devices])
  })

  // #6448 页头状态读机器推来的最新一份(与列表、提醒同一份读数),❌ 停在点进来那一刻的快照。
  it('hands the timeline page the live session summary, not the snapshot it was opened with', async () => {
    const hook = vi.mocked(useLiveDeviceSessions)
    const entry: DeviceSessions = {
      projects: [],
      sessions: [{ ...session, agentStatus: 'needs_approval', status: { status: 'needs_user', detail: 'approval' } }],
      cached: false,
      loading: false,
      error: null,
    }
    hook.mockImplementation(() => ({ 'device-1': entry }))
    try {
      await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn() }))
      await act(async () => {
        (harness.container.querySelector('[data-testid="open-session"]') as HTMLButtonElement).click()
      })
      expect(harness.container.querySelector('[data-testid="timeline-back"]')?.getAttribute('data-agent-status')).toBe('needs_approval')
    } finally {
      hook.mockImplementation(() => ({}))
    }
  })

  // owner 2026-10-09:跨机器的子会话点开,在它所在的那台机器上打开;返回回到项目页。
  it('opens a cross-machine child on its own machine and returns to the project list', async () => {
    deviceStore.devices = [...deviceStore.devices, { ...deviceStore.devices[0], device_id: 'device-2', label: 'ThinkPad' }]
    const focus = vi.mocked(useAgentWatchFocus)
    focus.mockClear()
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn() }))
    await act(async () => {
      (harness.container.querySelector('[data-testid="open-remote-child"]') as HTMLButtonElement).click()
    })
    expect(focus.mock.calls.at(-1)?.[0]).toEqual({ deviceId: 'device-2', sessionId: 'child-on-2' })
    await act(async () => {
      (harness.container.querySelector('[data-testid="timeline-back"]') as HTMLButtonElement).click()
    })
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    expect(focus.mock.calls.at(-1)?.[0] ?? null).toBeNull()
  })

  // #6730 手机壳里这张页常驻在横滑分页器里:切走「项目」tab 就回到根页,屏外不留着盯某条会话。
  it('falls back to the project list and stops watching once the tab is left', async () => {
    const focus = vi.mocked(useAgentWatchFocus)
    focus.mockClear()
    const onRouteChange = vi.fn()
    const props = { onExit: vi.fn(), onRouteChange }
    await harness.render(createNode(AgentWatchPage, { ...props, active: true }))
    await act(async () => {
      (harness.container.querySelector('[data-testid="open-session"]') as HTMLButtonElement).click()
    })
    expect(harness.container.querySelector('[data-testid="timeline-back"]'), 'positive control: deep in the timeline').toBeTruthy()
    expect(onRouteChange).toHaveBeenLastCalledWith('timeline')
    expect(focus.mock.calls.at(-1)?.[0]).toEqual({ deviceId: 'device-1', sessionId: 'conversation-1' })

    await harness.render(createNode(AgentWatchPage, { ...props, active: false }))
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    expect(focus.mock.calls.at(-1)?.[0] ?? null, 'an off-screen page watches nothing').toBeNull()
    expect(onRouteChange).toHaveBeenLastCalledWith('projects')

    await harness.render(createNode(AgentWatchPage, { ...props, active: true }))
    expect(harness.container.querySelector('[data-testid="projects"]'), 'coming back lands on the root').toBeTruthy()
  })

  it('walks + → machine picker → create, and each step back lands one step earlier', async () => {
    const onExit = vi.fn()
    const onRouteChange = vi.fn()
    await harness.render(createNode(AgentWatchPage, { active: true, onExit, onRouteChange }))

    await act(async () => {
      (harness.container.querySelector('[data-testid="create-agent"]') as HTMLButtonElement).click()
    })
    expect(harness.container.querySelector('[data-testid="pick-machine"]')).toBeTruthy()
    expect(onRouteChange).toHaveBeenLastCalledWith('pick-machine')
    await act(async () => {
      (harness.container.querySelector('[data-testid="open-device"]') as HTMLButtonElement).click()
    })
    expect(harness.container.querySelector('[data-testid="create"]')?.getAttribute('data-device-id')).toBe('device-1')
    expect(onRouteChange).toHaveBeenLastCalledWith('create')
    await act(async () => {
      expect(nativeBack()).toBe(true)
      await Promise.resolve()
    })
    expect(harness.container.querySelector('[data-testid="pick-machine"]'), 'create goes back to the picker').toBeTruthy()
    await act(async () => {
      expect(nativeBack()).toBe(true)
      await Promise.resolve()
    })
    expect(harness.container.querySelector('[data-testid="projects"]'), 'the picker goes back to the project list').toBeTruthy()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('a created session lands in its timeline; back from there is the project list', async () => {
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn() }))
    await act(async () => { (harness.container.querySelector('[data-testid="create-agent"]') as HTMLButtonElement).click() })
    await act(async () => { (harness.container.querySelector('[data-testid="open-device"]') as HTMLButtonElement).click() })
    await act(async () => { (harness.container.querySelector('[data-testid="create-done"]') as HTMLButtonElement).click() })
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeTruthy()
    await act(async () => { (harness.container.querySelector('[data-testid="timeline-back"]') as HTMLButtonElement).click() })
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
  })

  it('#6784 an outside create request (contacts「新建 Agent」) opens the machine picker, each time', async () => {
    const props = { active: true, onExit: vi.fn() }
    await harness.render(createNode(AgentWatchPage, { ...props, createRequest: 3 }))
    expect(harness.container.querySelector('[data-testid="projects"]'), 'mounting with a count is not a request').toBeTruthy()
    await harness.render(createNode(AgentWatchPage, { ...props, createRequest: 4 }))
    expect(harness.container.querySelector('[data-testid="pick-machine"]')).toBeTruthy()
    await act(async () => { (harness.container.querySelector('[data-testid="machines-back"]') as HTMLButtonElement).click() })
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    await harness.render(createNode(AgentWatchPage, { ...props, createRequest: 5 }))
    expect(harness.container.querySelector('[data-testid="pick-machine"]'), 'a second tap asks again').toBeTruthy()
  })

  // gugu.showSession on the phone: the row an App named opens as a tap on it does — even an offline machine's (the row is
  // its digest, as the list shows it). Back lands on the project list.
  it("an App's showSession opens the row it named, from another tab too; the same request once, a new one again", async () => {
    deviceStore.devices = [...deviceStore.devices, { ...deviceStore.devices[0], device_id: 'device-2', label: 'ThinkPad', is_online: false }]
    const focus = vi.mocked(useAgentWatchFocus)
    focus.mockClear()
    const asked = { deviceId: 'device-2', session: { ...session, conversationId: 'on-2' } }
    await harness.render(createNode(AgentWatchPage, { active: false, onExit: vi.fn(), openRequest: null }))
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    // The shell brings the project tab forward and hands the request over in one go (useAppShowSession).
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), openRequest: asked }))
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeTruthy()
    expect(focus.mock.calls.at(-1)?.[0]).toEqual({ deviceId: 'device-2', sessionId: 'on-2' })
    await act(async () => { (harness.container.querySelector('[data-testid="timeline-back"]') as HTMLButtonElement).click() })
    expect(harness.container.querySelector('[data-testid="projects"]'), 'back: the project list, as after a tap').toBeTruthy()
    expect(harness.container.querySelector('[data-testid="projects"]')?.getAttribute('data-reveal'), 'a plain back does not re-locate').toBeNull()
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), openRequest: asked }))
    expect(harness.container.querySelector('[data-testid="projects"]'), 'the same request is not asked again').toBeTruthy()
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), openRequest: { ...asked } }))
    expect(harness.container.querySelector('[data-testid="timeline-back"]'), 'a new one is').toBeTruthy()
  })

  // An offline machine's row comes from its heartbeat and does not open (the list greys it out): an App naming it lands the
  // person on the project list with that row asked for (the page expands its section and scrolls to it), where a tap would
  // have left them — not on a timeline that cannot be read.
  it('showSession on a row that does not open lands on the project list, locating that row', async () => {
    deviceStore.devices = [...deviceStore.devices, { ...deviceStore.devices[0], device_id: 'device-2', label: 'ThinkPad', is_online: false }]
    const offline = { deviceId: 'device-2', session: { ...session, conversationId: 'on-2', supported: false } }
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), openRequest: null }))
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), openRequest: offline }))
    expect(harness.container.querySelector('[data-testid="projects"]')?.getAttribute('data-reveal')).toBe('device-2|on-2')
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeNull()
    // Control: the same row, reported by a host that can open it (recordState), opens its timeline.
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), openRequest: { ...offline, session: { ...offline.session, recordState: 'not-started' as const } } }))
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeTruthy()
  })
})


describe('phone creation reuses the existing route', () => {
  it('opens an unsent phone conversation at the chat root and creates only on the first send', async () => {
    vi.spyOn(phoneSettings, 'thisPhoneDeviceId').mockReturnValue('device-1')
    deviceStore.devices = [{ ...deviceStore.devices[0]!, capabilities: { terminals: [], runtimes: ['pi'], host_kind: 'phone', host_runtime_capability: 1 } as Device['capabilities'] }]
    const onRouteChange = vi.fn()
    await renderWithAppProviders(harness, createNode(AgentWatchPage, { active: true, onExit: vi.fn(), mode: 'conversation', onRouteChange }))
    expect(harness.container.querySelector('[data-testid="create"]')?.getAttribute('data-device-id')).toBe('device-1')
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeNull()
    expect(onRouteChange).not.toHaveBeenCalled()
    await act(async () => { (harness.container.querySelector('[data-testid="create-done"]') as HTMLButtonElement).click() })
    expect(onRouteChange).toHaveBeenLastCalledWith('timeline')
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeTruthy()
  })

  it('keeps history reachable without a running local host and returns to the chat root', async () => {
    const onRouteChange = vi.fn()
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), mode: 'conversation', onRouteChange }))
    expect(harness.container.querySelector('[data-testid="phone-conversation-unavailable"]')).toBeTruthy()
    expect(harness.container.querySelector('textarea')).toBeNull()
    await act(async () => { (harness.container.querySelector('[data-testid="phone-conversation-history"]') as HTMLButtonElement).click() })
    expect(onRouteChange).toHaveBeenLastCalledWith('history')
    expect(harness.container.querySelector('[data-testid="projects"]')).toBeTruthy()
    await act(async () => { expect(nativeBack()).toBe(true) })
    expect(harness.container.querySelector('[data-testid="phone-conversation-unavailable"]')).toBeTruthy()
    expect(onRouteChange).toHaveBeenLastCalledWith('projects')
  })

  it('selects a real alternative host in the chat tab without first creating a task', async () => {
    const onRouteChange = vi.fn()
    await harness.render(createNode(AgentWatchPage, { active: true, onExit: vi.fn(), mode: 'conversation', onRouteChange }))
    await act(async () => { (harness.container.querySelector('[data-testid="phone-conversation-host"]') as HTMLButtonElement).click() })
    expect(onRouteChange).toHaveBeenLastCalledWith('pick-machine')
    await act(async () => { (harness.container.querySelector('[data-testid="open-device"]') as HTMLButtonElement).click() })
    expect(onRouteChange).toHaveBeenLastCalledWith('projects')
    expect(harness.container.querySelector('[data-testid="create"]')?.getAttribute('data-device-id')).toBe('device-1')
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeNull()
  })

  it('locates an unreadable requested task in chat history instead of hiding it behind the new conversation', async () => {
    const props = { active: true, onExit: vi.fn(), mode: 'conversation' as const }
    await harness.render(createNode(AgentWatchPage, { ...props, openRequest: null }))
    await harness.render(createNode(AgentWatchPage, { ...props, openRequest: { deviceId: 'device-1', session: { ...session, supported: false } } }))
    expect(harness.container.querySelector('[data-testid="projects"]')?.getAttribute('data-reveal')).toBe('device-1|conversation-1')
    expect(harness.container.querySelector('[data-testid="phone-conversation-unavailable"]')).toBeNull()
  })

  it('uses the same create screen and opens the phone task timeline without a DM binding', async () => {
    deviceStore.devices = [{ ...deviceStore.devices[0]!, capabilities: { terminals: [], runtimes: ['pi'], host_kind: 'phone', host_runtime_capability: 1 } as Device['capabilities'] }]
    const props = { active: true, onExit: vi.fn() }
    await harness.render(createNode(AgentWatchPage, { ...props, createRequest: 0 }))
    await harness.render(createNode(AgentWatchPage, { ...props, createRequest: 1 }))
    await act(async () => { (harness.container.querySelector('[data-testid="open-device"]') as HTMLButtonElement).click() })
    expect(harness.container.querySelector('[data-testid="create"]')?.getAttribute('data-device-id')).toBe('device-1')
    expect(harness.container.querySelector('[data-testid="phone-agent-page"]')).toBeNull()
    await act(async () => { (harness.container.querySelector('[data-testid="create-done"]') as HTMLButtonElement).click() })
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeTruthy()
  })

  it('an App opening a supported phone task uses its timeline without a DM binding', async () => {
    deviceStore.devices = [{ ...deviceStore.devices[0]!, capabilities: { terminals: [], runtimes: [], host_kind: 'phone' } as Device['capabilities'] }]
    const props = { active: true, onExit: vi.fn() }
    await harness.render(createNode(AgentWatchPage, { ...props, openRequest: null }))
    await harness.render(createNode(AgentWatchPage, { ...props, openRequest: { deviceId: 'device-1', session: { ...session, agent: { userId: 'phone-agent' }, supported: true } } }))
    expect(harness.container.querySelector('[data-testid="timeline-back"]')).toBeTruthy()
  })
})
