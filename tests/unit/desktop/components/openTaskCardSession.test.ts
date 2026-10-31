import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openTaskCardSession } from '../../../../apps/desktop/src/components/chat/openTaskCardSession'

const opened = vi.hoisted(() => ({ screen: true, link: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/renderer/app/screen-layout-actions', () => ({ isScreenView: () => opened.screen }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: { navigation: { currentViewId: 'session' } } }))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ followLink: opened.link }))
beforeEach(() => { vi.clearAllMocks(); opened.screen = true })
const task = { sessionId: 'task-id', projectId: 'local-project-id' }

describe('a task card opens its task the one way a session is opened', () => {
  it('another device: by its id, without its old local project id', () => {
    openTaskCardSession(task, false)
    expect(opened.link).toHaveBeenCalledExactlyOnceWith({ kind: 'session', sessionId: task.sessionId })
  })
  it('this computer: with its project; on the screen view beside what is there (only a task card asks for that)', () => {
    openTaskCardSession(task, true)
    expect(opened.link).toHaveBeenCalledExactlyOnceWith({ kind: 'session', ...task, beside: true })
    opened.screen = false
    openTaskCardSession(task, true)
    expect(opened.link).toHaveBeenLastCalledWith({ kind: 'session', ...task })
  })
})
