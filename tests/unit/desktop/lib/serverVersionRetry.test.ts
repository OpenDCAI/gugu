import { beforeEach, expect, it, vi } from 'vitest'
import { restartServerVersionNow } from '@/lib/serverVersionRetry'
import { LEGACY_VERSION_RETRY_RPC, VERSION_RESTART_RPC } from '@gugu/core/cloud/serverMachineHealth'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: rpc }))
beforeEach(() => rpc.mockReset())

it.each([0, 1234, undefined])('preserves the host restart receipt without inventing a timestamp (%s)', async at => {
  rpc.mockResolvedValue({ result: { requested: true, ...(at === undefined ? {} : { at }) } })
  expect(await restartServerVersionNow('remote', '0.3.1', true)).toEqual({ requested: true, ...(at === undefined ? {} : { at }) })
  expect(rpc).toHaveBeenCalledWith('remote', VERSION_RESTART_RPC, { version: '0.3.1', confirmed: true }, { timeoutMs: 15_000 })
})
it('keeps the old RPC acknowledgement usable without a receipt', async () => {
  rpc.mockResolvedValue({ result: { requested: true } })
  expect(await restartServerVersionNow('remote', '0.3.1', false)).toEqual({ requested: true })
  expect(rpc).toHaveBeenCalledWith('remote', LEGACY_VERSION_RETRY_RPC, {}, { timeoutMs: 15_000 })
})
it('reports request refusal and transport failure', async () => {
  rpc.mockResolvedValue({ result: { requested: false } })
  expect(await restartServerVersionNow('remote', '0.3.1', true)).toEqual({ requested: false })
  rpc.mockResolvedValue({ error: { message: 'request rejected' } })
  await expect(restartServerVersionNow('remote', '0.3.1', true)).rejects.toThrow('request rejected')
})
