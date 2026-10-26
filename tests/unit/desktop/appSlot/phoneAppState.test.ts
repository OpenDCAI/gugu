// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onPhoneAppState, phoneAppState, showPhoneAppView } from '../../../../apps/desktop/src/components/appSlot/phoneAppState'
import { retainDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
const focus = vi.hoisted(() => ({ listen: vi.fn(), stop: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { subscribeAppActive: focus.listen } }))
let clear: (() => void) | undefined
beforeEach(() => { retainDeviceSessions([]); focus.listen.mockReset().mockReturnValue(focus.stop); focus.stop.mockReset() })
afterEach(() => { clear?.(); clear = undefined; retainDeviceSessions([]) })
describe('phone App state, with the same projection and grants as desktop', () => {
  it('names the active project without read permission, and gates agent ids and paths field by field', () => {
    updateDeviceSessions('computer', { sessions: [{ conversationId: 'task', agent: { userId: 'agent' } } as SessionpageSessionSummary] })
    clear = showPhoneAppView({ activeSessionId: 'task', activeProjectId: 'project', panes: [{ paneId: 'workspace', focused: true, activeTab: { tabId: 'tab', kind: 'session', agentId: 'task', filePath: '/file' } }] })
    expect(phoneAppState([])).toMatchObject({ activeSessionId: 'task', activeProjectId: 'project', panes: [{ activeTab: { tabId: 'tab', kind: 'session' } }] })
    expect(phoneAppState([]).panes[0]?.activeTab).not.toHaveProperty('agentId')
    expect(phoneAppState([]).panes[0]?.activeTab).not.toHaveProperty('filePath')
    expect(phoneAppState(['agents:read', 'files:read']).panes[0]?.activeTab).toMatchObject({ agentId: 'user:agent', filePath: '/file' })
  })
  it('uses one native foreground listener and ignores cleanup from a previous view', () => {
    const a = vi.fn(); const b = vi.fn()
    const offA = onPhoneAppState(a); const offB = onPhoneAppState(b)
    expect(focus.listen).toHaveBeenCalledTimes(1)
    const old = showPhoneAppView({ activeSessionId: 'old', activeProjectId: null, panes: [] })
    clear = showPhoneAppView({ activeSessionId: 'new', activeProjectId: null, panes: [] })
    const peek = showPhoneAppView({ activeSessionId: 'peek', activeProjectId: null, panes: [] })
    peek(); expect(phoneAppState([]).activeSessionId).toBe('new')
    old(); expect(phoneAppState([]).activeSessionId).toBe('new')
    focus.listen.mock.calls[0][0](false)
    expect(phoneAppState([]).windowFocused).toBe(false)
    expect(a).toHaveBeenCalled(); expect(b).toHaveBeenCalled()
    offA(); expect(focus.stop).not.toHaveBeenCalled()
    offB(); expect(focus.stop).toHaveBeenCalledTimes(1)
  })
})
