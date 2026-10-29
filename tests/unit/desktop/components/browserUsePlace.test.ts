import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Browser Use 的「浏览器」页签按任务所在的机器画(这台电脑 / 另一台桌面 / 咕咕 server);
 * 任务卡上的入口在那个任务里开它的 Browser Use 页签,开在对话旁边。
 */
const fx = vi.hoisted(() => ({
  projects: new Map<string, unknown>(),
  machines: {} as Record<string, { kind: 'local' } | { kind: 'remote'; deviceId: string; label: () => string }>,
  devices: {} as Record<string, unknown>,
  owner: {} as Record<string, string>,
  tabs: [] as { kind: string; extensionId: string; hostBrowser?: boolean; enabled: boolean }[],
  openLink: vi.fn(async () => true),
}))

vi.mock('../../../../apps/desktop/src/session/renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: fx.projects }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/sessions/workspace-backend/workspace-backend', () => ({
  workspaceBackend: (projectId: string) => ({ machine: fx.machines[projectId] ?? { kind: 'local' } }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { device: (id: string) => fx.devices[id] ?? null },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/machine-routing', () => ({
  machineRegistry: { machineOf: (id: string) => fx.owner[id] ?? null },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { get allTabContributions() { return fx.tabs } },
}))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ openLink: fx.openLink }))

import { browserUseMachine, openBrowserUseTab, openTaskBrowser } from '../../../../apps/desktop/src/components/browserUse/browserUsePlace'
import { browserUseTab } from '../../../../apps/desktop/src/components/browserUse/browserUseApp'

function taskView(tabs: { kind: string; tabId: string }[] = []) {
  const pane = { resolvedTabs: tabs, setActiveTab: vi.fn() }
  return { paneLayout: { groups: [{ paneId: 'p1', pane }], setActiveGroup: vi.fn(), open: vi.fn() }, pane }
}
function mount(projectId: string, sessionId: string, view: unknown) {
  fx.projects.set(projectId, { mountedProject: { sessionManager: { sessions: new Map([[sessionId, { viewModel: view }]]) } } })
}

beforeEach(() => {
  fx.projects.clear()
  fx.machines = {}
  fx.devices = {}
  fx.owner = {}
  fx.tabs = []
  fx.openLink.mockClear()
})

describe('which machine a task’s browser page draws', () => {
  it('this computer, another desktop, or a server (with or without a direct path)', () => {
    mount('local-project', 'here', taskView())
    expect(browserUseMachine('here')).toEqual({ kind: 'local' })
    mount('remote:desk', 'there', taskView())
    fx.machines['remote:desk'] = { kind: 'remote', deviceId: 'desk', label: () => 'desk' }
    fx.devices.desk = { label: '办公室 Mac', hostKind: 'desktop', isOnline: true, directTerminal: true }
    expect(browserUseMachine('there')).toEqual({ kind: 'desktop', label: '办公室 Mac' })
    mount('remote:cloud', 'cloud-task', taskView())
    fx.machines['remote:cloud'] = { kind: 'remote', deviceId: 'cloud', label: () => 'cloud' }
    fx.devices.cloud = { label: '云电脑', hostKind: 'server', isOnline: true, directTerminal: false }
    expect(browserUseMachine('cloud-task')).toEqual({ kind: 'server', deviceId: 'cloud', label: '云电脑', online: true, direct: false })
  })

  it('a task not mounted yet: by the machine its id is registered to', () => {
    fx.owner.unmounted = 'cloud'
    fx.devices.cloud = { label: '云电脑', hostKind: 'server', isOnline: false, directTerminal: true }
    expect(browserUseMachine('unmounted')).toMatchObject({ kind: 'server', deviceId: 'cloud', online: false })
  })
})

describe('the task’s own Browser tab', () => {
  it('brings up the one already open, or opens one', () => {
    const open = taskView([{ kind: 'file', tabId: 'f' }, { kind: 'browser', tabId: 'b' }])
    mount('p', 's', open)
    expect(openTaskBrowser('s')).toBe(true)
    expect(open.pane.setActiveTab).toHaveBeenCalledWith('b')
    expect(open.paneLayout.open).not.toHaveBeenCalled()
    const none = taskView()
    mount('p', 's', none)
    openTaskBrowser('s')
    expect(none.paneLayout.open).toHaveBeenCalledWith('browser', {}, { preview: false })
    expect(openTaskBrowser('gone')).toBe(false)
  })
})

describe('the Browser Use tab from an ask', () => {
  it('ready / switched off / not installed', () => {
    expect(browserUseTab().state).toBe('missing')
    fx.tabs = [{ kind: 'browser-use.settings', extensionId: 'browser-use', enabled: false }, { kind: 'browser-use.browser', extensionId: 'browser-use', hostBrowser: true, enabled: false }]
    expect(browserUseTab()).toMatchObject({ state: 'disabled', tab: { kind: 'browser-use.browser' } })
    fx.tabs[1]!.enabled = true
    expect(browserUseTab()).toMatchObject({ state: 'ready', tab: { kind: 'browser-use.browser' } })
  })

  it('goes to the task, then opens its Browser Use tab beside the conversation', async () => {
    fx.tabs = [{ kind: 'browser-use.browser', extensionId: 'browser-use', hostBrowser: true, enabled: true }]
    const view = taskView()
    mount('remote:cloud', 'cloud-task', view)
    await openBrowserUseTab('cloud-task')
    expect(fx.openLink).toHaveBeenCalledWith({ kind: 'session', sessionId: 'cloud-task' })
    expect(view.paneLayout.open).toHaveBeenCalledWith('browser-use.browser', {}, { preview: false, beside: true })
  })

  it('refuses when the App is not on', async () => {
    await expect(openBrowserUseTab('cloud-task')).rejects.toThrow('Browser Use is not available')
    expect(fx.openLink).not.toHaveBeenCalled()
  })
})
