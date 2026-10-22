// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mockRpc = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { rpc: mockRpc, from: vi.fn() }, identityDb: { from: vi.fn() },
  dataClient: { storage: { from: vi.fn() } }, syncSchemaClientSession: vi.fn(async () => {}),
  getCurrentAuthUserId: vi.fn(async () => 'owner-1'),
}))
const { chatService } = await import('../../../../apps/desktop/src/lib/chat')
beforeEach(() => { mockRpc.mockReset() })
describe('setAgentListenMode confirms the RPC receipt', () => {
  it.each([null, [], { chat_id: 'wrong', user_id: 'agent-1', listen_mode: 'active' }])('rejects absent/wrong confirmation %j', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })
    await expect(chatService.setAgentListenMode('chat-1', 'agent-1', 'active')).rejects.toThrow()
  })
  it('surfaces a database rejection', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'agent_owner_required' } })
    await expect(chatService.setAgentListenMode('chat-1', 'agent-1', 'active')).rejects.toThrow('agent_owner_required')
  })
  it('uses the human actor and confirms the saved value', async () => {
    mockRpc.mockResolvedValue({ data: { chat_id: 'chat-1', user_id: 'agent-1', listen_mode: 'passive' }, error: null })
    await expect(chatService.setAgentListenMode('chat-1', 'agent-1', 'passive')).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith('set_agent_listen_mode_as', { p_chat_id: 'chat-1', p_agent_user_id: 'agent-1', p_mode: 'passive', p_as_user_id: 'owner-1' })
  })
})
