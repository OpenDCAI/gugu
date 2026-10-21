import { beforeEach, describe, expect, it, vi } from 'vitest'
const local = vi.hoisted(() => vi.fn())
const remote = vi.hoisted(() => vi.fn())
const rpcOn = vi.hoisted(() => vi.fn(() => ({ sessionTimeline: { sessionCreateModels: local } })))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ fetchCreateModels: remote }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {}, dataClient: {} }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
import { fetchAgentHarnessModels } from '../../../../apps/desktop/src/lib/agentModelSelection'

beforeEach(() => { vi.clearAllMocks() })
describe('model catalog belongs to the agent device', () => {
  it('reads the current computer subscription through its local host', async () => {
    local.mockResolvedValue({ ok: true, value: { harness: 'claude' } })
    await expect(fetchAgentHarnessModels('current-device', 'claude', true)).resolves.toEqual({ harness: 'claude' })
    expect(rpcOn).toHaveBeenCalledWith(null)
    expect(local).toHaveBeenCalledWith({ harness: 'claude', sessionView: 'general' })
    expect(remote).not.toHaveBeenCalled()
  })
  it('does not substitute controller credentials for a remote device subscription', async () => {
    remote.mockResolvedValue({ harness: 'claude' })
    await fetchAgentHarnessModels('agent-remote-device', 'claude', false)
    expect(remote).toHaveBeenCalledWith('agent-remote-device', 'claude', 'general', null)
    expect(local).not.toHaveBeenCalled()
    expect(rpcOn).not.toHaveBeenCalled()
  })
  it('propagates a failed device catalog instead of claiming there are no models', async () => {
    local.mockResolvedValue({ ok: false, error: { message: 'device unreadable' } })
    await expect(fetchAgentHarnessModels('current-device', 'claude', true)).rejects.toThrow('device unreadable')
  })
})
