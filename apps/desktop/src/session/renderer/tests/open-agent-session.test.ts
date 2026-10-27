import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openAgentSession } from '@/components/chat/openAgentSession'

const state = vi.hoisted(() => ({
  projects: new Map(), identities: new Map(), managers: new Map(), remote: [] as unknown[],
  load: vi.fn(), open: vi.fn(), tab: vi.fn(), mount: vi.fn(), provision: vi.fn(), focus: vi.fn(),
  host: undefined as { projectId: string; sessionId: string } | undefined,
}))
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { currentViewId: 'screen' }, projects: { projects: state.projects, ensureMounted: state.mount } } }))
vi.mock('@renderer/app/screen-layout', () => ({ screenLayout: { get recentSession() { return state.host }, blockOfSession: () => 'right' } }))
vi.mock('@renderer/app/screen-layout-actions', () => ({ isScreenView: () => true, focusScreenBlock: state.focus, showBesideOnScreen: state.open }))
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({ openSessionInSessionWhenReady: state.tab }))
vi.mock('@renderer/features/sessions/stores/session-agent-names', () => ({
  sessionAgentNames: { identities: state.identities, isLoaded: false, load: state.load },
}))
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: (id: string) => state.managers.get(id) } }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { allListedSessions: () => state.remote } }))

beforeEach(() => {
  vi.clearAllMocks()
  state.projects.clear()
  state.identities.clear()
  state.managers.clear()
  state.remote = []
  state.host = undefined
})

describe('群聊 Agent 署名打开已有 Session', () => {
  it('同名 Agent 按身份打开各自会话，并请求右侧分栏', async () => {
    state.identities.set('s1', { agentUserId: 'a1', displayName: 'Codex' })
    state.identities.set('s2', { agentUserId: 'a2', displayName: 'Codex' })
    state.projects.set('p', { id: 'p', mountedProject: { sessionManager: { sessions: new Map([['s1', {}], ['s2', {}]]) } } })
    await openAgentSession('a2')
    await openAgentSession('a1')
    expect(state.open.mock.calls).toEqual([[{ kind: 'session', projectId: 'p', sessionId: 's2' }], [{ kind: 'session', projectId: 'p', sessionId: 's1' }]])
    expect(state.load).toHaveBeenCalled()
  })

  it('已经挂载的子会话使用所属项目', async () => {
    state.identities.set('child', { agentUserId: 'a' })
    state.managers.set('child', { projectId: 'p' })
    await openAgentSession('a')
    expect(state.open).toHaveBeenCalledWith({ kind: 'session', projectId: 'p', sessionId: 'child' })
  })

  it('另一台机器上的 Agent 使用现有目录中的会话', async () => {
    state.remote = [{ summary: { projectId: 'remote:p', conversationId: 's', agent: { userId: 'a' } } }]
    await openAgentSession('a')
    expect(state.open).toHaveBeenCalledWith({ kind: 'session', projectId: 'remote:p', sessionId: 's' })
  })

  it('身份找不到时明确失败，不打开别的 Agent 或创建私聊', async () => {
    state.identities.set('s', { agentUserId: 'other', displayName: 'Codex' })
    await expect(openAgentSession('missing')).rejects.toThrow('没有找到这个 Agent 对应的会话')
    expect(state.open).not.toHaveBeenCalled()
  })

  it('第二个 Agent 加到已有右栏标签，重复点击仍复用同一栏', async () => {
    state.host = { projectId: 'p1', sessionId: 's1' }
    state.identities.set('s2', { agentUserId: 'a2' })
    state.projects.set('p2', { id: 'p2', mountedProject: { sessionManager: { sessions: new Map([['s2', {}]]), provisionSession: state.provision } } })
    await openAgentSession('a2')
    await openAgentSession('a2')
    expect(state.open).not.toHaveBeenCalled()
    expect(state.tab).toHaveBeenCalledTimes(2)
    expect(state.tab).toHaveBeenLastCalledWith({ projectId: 'p2', sessionId: 's2', host: { projectId: 'p1', sessionId: 's1' } })
    expect(state.provision).toHaveBeenCalledWith('s2')
    expect(state.focus).toHaveBeenLastCalledWith('right')
  })
})
