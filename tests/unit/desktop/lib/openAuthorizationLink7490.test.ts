// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocked = vi.hoisted(() => ({ invoke: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })), remoteInvoke: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => window.electronAPI ? { invoke: mocked.invoke } : null }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn() }) }))
import { openAuthorizationLink } from '../../../../apps/desktop/src/lib/openAuthorizationLink'

beforeEach(() => {
  mocked.invoke.mockClear()
  mocked.remoteInvoke.mockClear()
  mocked.invoke.mockResolvedValue({ success: true })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
})
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__GUGU_TASK_HOST_BRIDGE__
  vi.restoreAllMocks()
})

it('opens desktop authorization using the local system-browser bridge', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })
  ;(window as unknown as Record<string, unknown>).__GUGU_TASK_HOST_BRIDGE__ = { invoke: mocked.remoteInvoke }
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  await openAuthorizationLink('https://login.dingtalk.com/oauth2/device/authorize.htm?user_code=test')
  expect(mocked.invoke).toHaveBeenCalledWith('app.openExternal', 'https://login.dingtalk.com/oauth2/device/authorize.htm?user_code=test')
  expect(mocked.remoteInvoke).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})
it('opens web authorization on the client, never on the remote host', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  await openAuthorizationLink('https://meeting.tencent.com/authorize')
  expect(open).toHaveBeenCalledWith('https://meeting.tencent.com/authorize', '_blank', 'noopener,noreferrer')
  expect(mocked.invoke).not.toHaveBeenCalled()
})
it('rejects non-web authorization URLs', async () => {
  await expect(openAuthorizationLink('javascript:alert(1)')).rejects.toThrow('Invalid authorization URL')
  expect(mocked.invoke).not.toHaveBeenCalled()
})
it('reports a failed system-browser launch instead of treating it as opened', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })
  mocked.invoke.mockResolvedValueOnce({ success: false, error: 'Browser launch failed' })
  await expect(openAuthorizationLink('https://login.dingtalk.com/')).rejects.toThrow('Browser launch failed')
})
