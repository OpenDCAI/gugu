// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  link: vi.fn(), list: vi.fn(), pick: vi.fn(), compose: vi.fn(), navigate: vi.fn(), reveal: vi.fn(), notice: vi.fn(),
  view: { id: 'view' }, clipboard: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('../../../../apps/desktop/src/i18n/runtime', () => ({ i18n: { t: (key: string) => key } }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ readMobileShell: () => false }))
vi.mock('../../../../apps/desktop/src/store/devicesCache', () => ({ readCachedDevices: () => [] }))
vi.mock('../../../../apps/desktop/src/components/chat/dispatchAsk', () => ({ pickDispatchTarget: mocks.pick }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpc: { extensions: { resourceLink: mocks.link }, sessionTimeline: { sessionsList: mocks.list } } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: mocks.navigate } } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: new Map([['project', { mountedProject: { sessionManager: { sessions: new Map([['task', { viewModel: mocks.view }]]) } } }]]) }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/compose-in-session', () => ({ composeWhenOpen: mocks.compose }))
vi.mock('../../../../apps/desktop/src/hooks/useSessionpageReveal', () => ({ revealSessionpage: mocks.reveal }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: mocks.notice }))

const { runResourceAction } = await import('../../../../apps/desktop/src/lib/resourceActions')
const app = { kind: 'app-variant', target: { kind: 'app-detail', extensionId: 'radar', deviceId: 'device', variant: 'ui-smoke' }, facts: ['fork'] } as const
const url = 'gugu-dev://app/radar?device=device&variant=ui-smoke'
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.clipboard } })
  mocks.link.mockResolvedValue(url)
  mocks.list.mockResolvedValue({ sessions: [{ conversationId: 'task', projectId: 'project', supported: true, agent: { userId: 'agent' } }] })
  mocks.pick.mockResolvedValue(null)
})

describe('resource drafts', () => {
  it('offers the local host task even when the remote directory has no devices', async () => {
    await runResourceAction('send-resource-url', app)
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith()
    expect(mocks.pick).toHaveBeenCalledWith(expect.objectContaining({ draft: true, text: url, local: ['user:agent'], resource: app }))
    expect(mocks.clipboard).toHaveBeenCalledWith(url)
    expect(mocks.compose).not.toHaveBeenCalled()
  })
  it('opens the selected task and appends the edited text through the existing composer', async () => {
    mocks.pick.mockResolvedValue({ to: { agent: 'user:agent' }, text: `${url}\nKeep my changes`, visible: false })
    await runResourceAction('send-resource-url', app)
    expect(mocks.navigate).toHaveBeenCalledWith('session', { projectId: 'project', sessionId: 'task' })
    expect(mocks.compose).toHaveBeenCalledWith(expect.any(Function), `${url}\nKeep my changes`)
    expect(mocks.compose.mock.calls[0]![0]()).toBe(mocks.view)
    expect(mocks.notice).not.toHaveBeenCalled()
  })
  it('copies a pinned file version without querying tasks or using the build scheme', async () => {
    await runResourceAction('copy-resource-url', { kind: 'file', target: { kind: 'file', itemId: '00000000-0000-4000-8000-000000000001', version: 3 } })
    expect(mocks.clipboard).toHaveBeenCalledWith('gugu-file://00000000-0000-4000-8000-000000000001?v=3')
    expect(mocks.link).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
