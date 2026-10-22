// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
const mockUpload = vi.fn()
const mockGetPublicUrl = vi.fn()
const mockStorageFrom = vi.fn(() => ({ upload: mockUpload, getPublicUrl: mockGetPublicUrl }))
const mockRpc = vi.fn()
const mockFrom = vi.fn()
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { rpc: mockRpc, from: mockFrom }, identityDb: { from: vi.fn() },
  dataClient: { storage: { from: mockStorageFrom } }, syncSchemaClientSession: vi.fn(async () => {}),
  getCurrentAuthUserId: vi.fn(async () => 'uploader-1'),
}))
const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const url = 'https://media/chat-media/uploader-1/group-avatar/g1.png'
function fakeFile(over: Partial<{ type: string; size: number; name: string }> = {}): File {
  return { type: 'image/png', size: 1024, name: 'logo.png', ...over } as unknown as File
}
function settingsRow(over: Record<string, unknown> = {}) {
  return { id: 'g1', public_id: null, name: 'G', status: 'active', group_prompt: null,
    creator_user_id: 'uploader-1', default_agent_type: null, join_token: null, description: null,
    max_members: 100, allow_member_invite: false, invite_link_enabled: true,
    agent_join_approval: false, join_mode: 'open', hide_history: false, can_manage: true, can_dissolve: true, ...over }
}
beforeEach(() => {
  mockUpload.mockReset().mockResolvedValue({ error: null })
  mockGetPublicUrl.mockReset().mockReturnValue({ data: { publicUrl: url } })
  mockRpc.mockReset().mockImplementation(async (_name, args) => ({ data: settingsRow(args.p_changes ?? {}), error: null }))
  mockFrom.mockClear(); mockStorageFrom.mockClear()
})
describe('shared group avatar transport', () => {
  it.each([
    [{ type: 'text/plain' }, '请选择图片文件'], [{ size: 6 * 1024 * 1024 }, '文件大小不能超过 5MB'],
  ])('validates an invalid image before uploading', async (over, message) => {
    await expect(chatService.uploadGroupAvatar('g1', fakeFile(over))).rejects.toThrow(String(message))
    expect(mockUpload).not.toHaveBeenCalled(); expect(mockRpc).not.toHaveBeenCalled()
  })
  it('uploads under the account and atomically saves all references through the human actor RPC', async () => {
    expect(await chatService.uploadGroupAvatar('g1', fakeFile({ name: 'team.png' }))).toBe(url)
    expect(mockStorageFrom).toHaveBeenCalledWith('chat-media')
    const [path] = mockUpload.mock.calls[0]
    expect(path).toMatch(/^uploader-1\/group-avatar\/[0-9a-f-]{36}-team\.png$/)
    expect(mockRpc).toHaveBeenCalledWith('update_group_as', { p_chat_id: 'g1', p_as_user_id: 'uploader-1', p_changes: {
      avatar_url: url, avatar_storage_bucket_id: 'chat-media', avatar_storage_object_name: path,
    } })
    expect(mockFrom).not.toHaveBeenCalled()
  })
  it('does not save a pointer when storage fails', async () => {
    mockUpload.mockResolvedValueOnce({ error: { message: 'bucket boom' } })
    await expect(chatService.uploadGroupAvatar('g1', fakeFile())).rejects.toThrow('bucket boom')
    expect(mockRpc).not.toHaveBeenCalled()
  })
  it('does not report success if the database rejects or does not confirm the avatar', async () => {
    mockRpc.mockResolvedValueOnce({ data: settingsRow(), error: null })
    await expect(chatService.uploadGroupAvatar('g1', fakeFile())).rejects.toThrow('avatar was not confirmed')
  })
})
describe('group settings avatar projection through group_info_as', () => {
  it.each(['https://media/g1.png', undefined])('projects the saved avatar %s', async (avatar_url) => {
    mockRpc.mockResolvedValueOnce({ data: settingsRow({ avatar_url }), error: null })
    expect((await chatService.getGroupChatSettings('g1')).avatar_url).toBe(avatar_url ?? null)
    expect(mockRpc).toHaveBeenCalledWith('group_info_as', { p_chat_id: 'g1', p_as_user_id: 'uploader-1' })
  })
})
