import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
it('shares one directory and notifications between the shell and session module graphs', async () => {
  vi.stubGlobal('window', {})
  const shell = await import('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory')
  const notified = vi.fn()
  const off = shell.subscribeDeviceSessions(notified)
  vi.resetModules()
  const session = await import('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory')
  session.updateDeviceSessions('cloud', { cached: false, loading: false, sessions: [] })
  expect(notified).toHaveBeenCalledOnce()
  expect(shell.liveDeviceSessions()).toBe(session.liveDeviceSessions())
  expect(shell.liveDeviceSessions().cloud?.cached).toBe(false)
  off()
  session.updateDeviceSessions('cloud', { loading: true })
  expect(notified).toHaveBeenCalledOnce()
})
