import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openTaskCardSession } from '../../../../apps/desktop/src/components/chat/openTaskCardSession'

const opened = vi.hoisted(() => ({ screen: true, beside: vi.fn(), ready: vi.fn(), full: vi.fn(), link: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/app/screen-layout-actions', () => ({ isScreenView: () => opened.screen, showSessionBeside: opened.beside }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/sessions/open-session-in-session', () => ({ openSessionInSessionWhenReady: opened.ready }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: { navigation: { currentViewId: 'session' } } }))
vi.mock('../../../../apps/desktop/src/components/appSlot/peekFullSession', () => ({ openSessionInFull: opened.full }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ followLink: opened.link }))
beforeEach(() => { vi.clearAllMocks(); opened.screen = true })
const task = { sessionId: 'task-id', projectId: 'local-project-id' }

describe('task card uses the existing resource opening paths', () => {
  it('routes another device through the session resource, without its old local project id', () => {
    openTaskCardSession(task, false)
    expect(opened.link).toHaveBeenCalledExactlyOnceWith({ kind: 'session', sessionId: task.sessionId })
    expect(opened.beside).not.toHaveBeenCalled()
    expect(opened.full).not.toHaveBeenCalled()
  })
  it('retains the local screen layout and task readiness boundary', () => {
    openTaskCardSession(task, true)
    expect(opened.beside).not.toHaveBeenCalled()
    expect(opened.ready).toHaveBeenCalledExactlyOnceWith({ ...task, onReady: expect.any(Function) })
    opened.ready.mock.calls[0][0].onReady()
    expect(opened.beside).toHaveBeenCalledExactlyOnceWith(task)
    expect(opened.link).not.toHaveBeenCalled()
  })
})
