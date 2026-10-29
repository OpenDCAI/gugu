import { describe, expect, it, vi } from 'vitest'
import { checkMachineLimitRefusal, machineLimitRefusalFromError, parseMachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { recentMachineLimitRefusal } from '@gugu/core/cloud/devices'

const inventory = {
  limit: 'tunnel' as const, used: 1, max: 1, machine_id: 'candidate', via: 'tunnel' as const,
  machines: [{ machine_id: 'occupant', label: 'My server', device_ids: ['stable', 'beta'] }],
}

describe('machine limit inventory', () => {
  it('preserves the server inventory through login, heartbeat and recent-refusal paths', async () => {
    expect(parseMachineLimitRefusal(inventory)).toEqual(inventory)
    expect(machineLimitRefusalFromError(`DEVICE_LIMIT_REACHED: ${JSON.stringify(inventory)}`)).toEqual(inventory)
    const rpc = vi.fn(async () => ({ data: { ...inventory, hostname: 'new server' }, error: null }))
    expect(await recentMachineLimitRefusal({ rpc }, 'since')).toEqual({ ...inventory, hostname: 'new server' })
    expect(rpc).toHaveBeenCalledWith('my_recent_machine_limit_refusal', { p_since: 'since' })
  })

  it('accepts old backend refusals without inventing an occupant list', () => {
    expect(parseMachineLimitRefusal({ limit: 'total', used: 10, max: 10, plan: 'installation' }))
      .toEqual({ limit: 'total', used: 10, max: 10 })
  })

  it.each([null, {}, [{ machine_id: 'x', label: 'x', device_ids: [] }], [{ machine_id: 'x', label: 'x', device_ids: [null] }]])('rejects a malformed inventory instead of offering a guessed removal: %j', (machines) => {
      expect(parseMachineLimitRefusal({ ...inventory, machines })).toBeNull()
    })

  it('checks the same attempted machine against the owner-scoped enforcement RPC', async () => {
    const request = { machine_id: 'candidate', via: 'tunnel' as const }
    const rpc = vi.fn(async () => ({ data: inventory as unknown, error: null as { message: string } | null }))
    expect(await checkMachineLimitRefusal({ rpc }, 'owner', request)).toEqual(inventory)
    expect(rpc).toHaveBeenCalledWith('gugu_machine_limit_refusal', { p_user_id: 'owner', p_machine_id: 'candidate', p_via: 'tunnel' })
    rpc.mockResolvedValue({ data: null, error: null })
    expect(await checkMachineLimitRefusal({ rpc }, 'owner', request)).toBeNull()
    rpc.mockResolvedValue({ data: {}, error: null })
    await expect(checkMachineLimitRefusal({ rpc }, 'owner', request)).rejects.toThrow('Invalid machine limit response')
    rpc.mockResolvedValue({ data: null, error: { message: 'connection failed' } })
    await expect(checkMachineLimitRefusal({ rpc }, 'owner', request)).rejects.toThrow('connection failed')
    await expect(checkMachineLimitRefusal({ rpc }, '', request)).rejects.toThrow('require an owner')
  })
})
