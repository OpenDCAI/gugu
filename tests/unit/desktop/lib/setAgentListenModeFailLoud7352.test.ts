// @vitest-environment jsdom
// #7352 setAgentListenMode fail-loud:被 RLS 拦下时 PostgREST 返回 0 行、不报错 ⇒ 必须抛,界面才写得出原因(同 removeGroupMember #1239)。
import { beforeEach, describe, expect, it, vi } from 'vitest'

// chatDb.from('chat_members').update(payload).eq('chat_id',…).eq('user_id',…).select('user_id') → Promise<{ data, error }>
const mockSelect = vi.fn()
const mockEq2 = vi.fn(() => ({ select: mockSelect }))
const mockEq1 = vi.fn(() => ({ eq: mockEq2 }))
const mockUpdate = vi.fn(() => ({ eq: mockEq1 }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: vi.fn(() => ({ update: mockUpdate })) },
  identityDb: { from: vi.fn() },
  dataClient: { storage: { from: vi.fn() } },
  syncSchemaClientSession: vi.fn(async () => {}),
  getCurrentAuthUserId: vi.fn(async () => 'owner-1'),
}))
const { chatService } = await import('../../../../apps/desktop/src/lib/chat')

beforeEach(() => { mockSelect.mockReset(); mockUpdate.mockClear() })

describe('#7352 chatService.setAgentListenMode', () => {
  it('0 行(被拦下)⇒ 抛错,不当成改好了', async () => {
    mockSelect.mockResolvedValue({ data: [], error: null })
    await expect(chatService.setAgentListenMode('chat-1', 'agent-1', 'active')).rejects.toThrow('没改成，档位还是原来的')
  })

  it('库报错 ⇒ 原样抛出库的原因', async () => {
    mockSelect.mockResolvedValue({ data: null, error: { message: '只有 agent 的主人能调整它在群里是主动还是被动' } })
    await expect(chatService.setAgentListenMode('chat-1', 'agent-1', 'active')).rejects.toThrow('只有 agent 的主人能调整它在群里是主动还是被动')
  })

  it('阳控:改到 1 行 ⇒ 不抛,写的是这一行的 listen_mode', async () => {
    mockSelect.mockResolvedValue({ data: [{ user_id: 'agent-1' }], error: null })
    await expect(chatService.setAgentListenMode('chat-1', 'agent-1', 'passive')).resolves.toBeUndefined()
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ listen_mode: 'passive' }))
    expect(mockEq1).toHaveBeenCalledWith('chat_id', 'chat-1')
    expect(mockEq2).toHaveBeenCalledWith('user_id', 'agent-1')
  })
})
