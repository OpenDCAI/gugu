// @vitest-environment jsdom
// #1164 G1 群头像上传 — unit tests for chatService.uploadGroupAvatar + getGroupChatSettings avatar_url 映射。
// 跑在四门 quality job（无 live DB；supabase chain 全 mock）。
import { describe, it, expect, vi, beforeEach } from 'vitest'
// ── mock supabase client chain（storage + chatDb）──────────────────────────────
const mockUpload = vi.fn()
const mockGetPublicUrl = vi.fn()
const mockStorageFrom = vi.fn(() => ({ upload: mockUpload, getPublicUrl: mockGetPublicUrl }))
// chatDb.from('chats').update(payload).eq('id',…).eq('kind',…) → Promise<{ error }>
const mockUpdateEq2 = vi.fn()
const mockUpdateEq1 = vi.fn(() => ({ eq: mockUpdateEq2 }))
const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq1 }))
// chatDb.from('chats').select(cols).eq('id',…).eq('kind',…).single() → Promise<{ data, error }>
const mockSingle = vi.fn()
const mockSelectEq2 = vi.fn(() => ({ single: mockSingle }))
// @@@5856 读设置那条链路上多了一段 .in('kind', ['group','topic']) —— 话题也要读得到自己这一份。
const mockSelectIn = vi.fn(() => ({ single: mockSingle }))
const mockSelectEq1 = vi.fn(() => ({ eq: mockSelectEq2, in: mockSelectIn, single: mockSingle }))
const mockSelect = vi.fn(() => ({ eq: mockSelectEq1, single: mockSingle }))
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: {
    from: vi.fn(() => ({ select: mockSelect, update: mockUpdate })),
  },
  identityDb: { from: vi.fn() },
  dataClient: { storage: { from: mockStorageFrom } },
  syncSchemaClientSession: vi.fn(async () => {}),
  getCurrentAuthUserId: vi.fn(async () => 'uploader-1'),
}))
const { chatService } = await import('../../../apps/desktop/src/lib/chat')
function fakeFile(over: Partial<{ type: string; size: number; name: string }> = {}): File {
  return { type: 'image/png', size: 1024, name: 'logo.png', ...over } as unknown as File
}
beforeEach(() => {
  mockUpload.mockReset().mockResolvedValue({ error: null })
  mockGetPublicUrl.mockReset().mockReturnValue({ data: { publicUrl: 'https://media/chat-media/uploader-1/group-avatar/g1.png' } })
  mockUpdateEq2.mockReset().mockResolvedValue({ error: null })
  mockSingle.mockReset()
  // 仅清调用历史、保留链式实现（这些 mock 的 return-value 即调用链，不能 reset 掉）。
  mockUpdate.mockClear()
  mockUpdateEq1.mockClear()
  mockStorageFrom.mockClear()
})
describe('#1164 G1 chatService.uploadGroupAvatar — 校验', () => {
  it('非图片文件 → 抛「请选择图片文件」，不触碰 storage/db', async () => {
    await expect(chatService.uploadGroupAvatar('g1', fakeFile({ type: 'text/plain', name: 'a.txt' })))
      .rejects.toThrow('请选择图片文件')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
  it('超过 5MB → 抛「文件大小不能超过 5MB」，不触碰 storage/db', async () => {
    await expect(chatService.uploadGroupAvatar('g1', fakeFile({ size: 6 * 1024 * 1024 })))
      .rejects.toThrow('文件大小不能超过 5MB')
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
describe('#1164 G1 chatService.uploadGroupAvatar — 上传落库', () => {
  it('合法图片：上传 chat-media（路径在上传者 uid 下）→ 写 chats.avatar_url → 返回 public URL', async () => {
    const url = await chatService.uploadGroupAvatar('g1', fakeFile({ name: 'team.png' }))
    // 上传到公共 chat-media 桶，路径以上传者 uid 起头（满足 chat_media_insert_own foldername[1]=auth.uid()）。
    expect(mockStorageFrom).toHaveBeenCalledWith('chat-media')
    const [path] = mockUpload.mock.calls[0]
    expect(path).toMatch(/^uploader-1\/group-avatar\/[0-9a-f-]{36}-team\.png$/)
    // 写 chats.avatar_url + 群门控（kind=group）。
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ avatar_url: url }))
    expect(url).toBe('https://media/chat-media/uploader-1/group-avatar/g1.png')
  })
  it('storage 上传失败 → 抛错，不写 db', async () => {
    mockUpload.mockResolvedValueOnce({ error: { message: 'bucket boom' } })
    await expect(chatService.uploadGroupAvatar('g1', fakeFile())).rejects.toThrow('bucket boom')
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
describe('#1164 G1 getGroupChatSettings — avatar_url 映射', () => {
  function settingsRow(over: Record<string, unknown> = {}) {
    return {
      id: 'g1', public_id: null, name: 'G', status: 'active', group_prompt: null,
      creator_user_id: 'uploader-1',
      default_agent_type: null, join_token: null, description: null,
      max_members: 100, allow_member_invite: false, invite_link_enabled: true,
      agent_join_approval: false, join_mode: 'open', hide_history: false, ...over,
    }
  }
  it('DB 返回 avatar_url → 映射到结果', async () => {
    mockSingle.mockResolvedValueOnce({ data: settingsRow({ avatar_url: 'https://media/g1.png' }), error: null })
    const res = await chatService.getGroupChatSettings('g1')
    expect(res.avatar_url).toBe('https://media/g1.png')
  })
  it('DB 无 avatar_url（undefined）→ 回落 null', async () => {
    mockSingle.mockResolvedValueOnce({ data: settingsRow(), error: null })
    const res = await chatService.getGroupChatSettings('g1')
    expect(res.avatar_url).toBeNull()
  })
})
