// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ matchVersion: vi.fn() }))
vi.mock('@/lib/cloudComputer', () => ({ rendererCloudComputerClient: () => f }))
vi.mock('@/lib/cloudComputerStore', () => ({ getCloudComputerState: () => ({ snapshot: { deviceId: 'cloud' } }) }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: 'owner' } }), observeRendererSession: vi.fn() }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

it('starts matching again when a verified mismatch follows a previous ready receipt', async () => {
  const { requestCloudVersionMatch } = await import('@/lib/cloudVersionMatch')
  f.matchVersion.mockResolvedValueOnce({ status: 'ready', version: '1.0' }).mockResolvedValueOnce({ status: 'ready', version: '2.0' })
  await expect(requestCloudVersionMatch('cloud')).resolves.toBe(true)
  await expect(requestCloudVersionMatch('cloud')).resolves.toBe(true)
  expect(f.matchVersion).toHaveBeenCalledTimes(2)
  expect(f.matchVersion.mock.calls.every(call => call[1] === true)).toBe(true)
})

it('coalesces simultaneous mismatches but permits an explicit retry after failure', async () => {
  const { requestCloudVersionMatch } = await import('@/lib/cloudVersionMatch')
  let answer!: (value: { status: 'failed'; error: string }) => void
  f.matchVersion.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  const first = requestCloudVersionMatch('cloud')
  await vi.waitFor(() => expect(f.matchVersion).toHaveBeenCalledOnce())
  await expect(requestCloudVersionMatch('cloud')).resolves.toBe(true)
  answer({ status: 'failed', error: 'No matching release' })
  await expect(first).resolves.toBe(false)
  await expect(requestCloudVersionMatch('cloud')).resolves.toBe(false)
  f.matchVersion.mockResolvedValueOnce({ status: 'ready', version: '2.0' })
  await expect(requestCloudVersionMatch('cloud', true)).resolves.toBe(true)
  expect(f.matchVersion).toHaveBeenCalledTimes(2)
})
