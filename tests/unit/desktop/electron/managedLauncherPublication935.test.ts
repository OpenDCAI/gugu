import { afterEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ rename: vi.fn(), wait: vi.fn(async () => undefined) }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), rename: f.rename }))
vi.mock('node:timers/promises', () => ({ setTimeout: f.wait }))
const { replaceManagedLauncher } = await import('../../../../apps/desktop/electron/session/main/core/dependencies/managed-launcher-publication')
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); f.rename.mockReset() })

it('retries a temporarily occupied Windows launcher without unlinking it', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  f.rename.mockRejectedValueOnce(Object.assign(new Error('scanner holds file'), { code: 'EPERM' }))
    .mockRejectedValueOnce(Object.assign(new Error('file busy'), { code: 'EBUSY' })).mockResolvedValue(undefined)
  await replaceManagedLauncher('staged', 'active')
  expect(f.rename.mock.calls).toEqual([['staged', 'active'], ['staged', 'active'], ['staged', 'active']])
  expect(f.wait.mock.calls).toEqual([[50], [100]])
})

it('stops retrying a persistently occupied Windows launcher', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const error = Object.assign(new Error('file remains locked'), { code: 'EACCES' })
  f.rename.mockRejectedValue(error)
  await expect(replaceManagedLauncher('staged', 'active')).rejects.toBe(error)
  expect(f.rename).toHaveBeenCalledTimes(6)
})

it('does not retry unrelated rename failures', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const error = Object.assign(new Error('destination is a directory'), { code: 'EISDIR' })
  f.rename.mockRejectedValue(error)
  await expect(replaceManagedLauncher('staged', 'active')).rejects.toBe(error)
  expect(f.rename).toHaveBeenCalledOnce()
  expect(f.wait).not.toHaveBeenCalled()
})
