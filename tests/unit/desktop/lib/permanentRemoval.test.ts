import { describe, expect, it, vi } from 'vitest'
import { permanentlyRemove } from '@gugu/core/cloud/agentIdentityRemoval'

describe('permanent removal entry', () => {
  it('sends only the explicitly selected agent or device scope to existing RPCs', async () => {
    const client = { rpc: vi.fn(async () => ({ error: null })) }
    await permanentlyRemove({ client, agentId: 'chosen-agent' })
    await permanentlyRemove({ client, deviceId: 'chosen-device', cascade: true })
    expect(client.rpc.mock.calls).toEqual([
      ['remove_owned_agent', { p_agent_user_id: 'chosen-agent' }],
      ['remove_device', { p_device_id: 'chosen-device', p_cascade: true }],
    ])
  })
  it('preserves a backend refusal', async () => {
    await expect(permanentlyRemove({ client: { rpc: async () => ({ error: { message: 'not owned' } }) }, agentId: 'other' })).rejects.toThrow('not owned')
  })
})
