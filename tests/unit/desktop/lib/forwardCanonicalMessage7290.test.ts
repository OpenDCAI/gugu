// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #7290:附件一律由服务端转(attachments/forward)—— 新式的、老式的(字节在 chat-media,服务端登记进新链再转)都一样;
// 客户端不再插指向 chat-media 的新消息。纯文字照旧本地插一行(不带存储列)。
const { source, inserted, forwardMock } = vi.hoisted(() => ({
  source: { row: null as Record<string, unknown> | null },
  inserted: [] as Record<string, unknown>[],
  forwardMock: vi.fn(async (_endpoint: unknown, args: Record<string, unknown>) => ({ id: args.message_id, chat_id: args.chat_id, content: 'x', content_type: 'attachment', created_at: 't' })),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: {
    from: () => {
      const q = {
        select: () => q, eq: () => q, is: () => q,
        maybeSingle: async () => ({ data: source.row, error: null }),
        insert: (row: Record<string, unknown>) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: row.id, chat_id: row.chat_id, content: row.content, content_type: row.content_type, created_at: 't' }, error: null }) }) } },
      }
      return q
    },
  },
  getCurrentAuthUserId: async () => 'me',
  dataClient: {},
}))
vi.mock('../../../../apps/desktop/src/lib/attachmentsEndpoint', () => ({ attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 't' }) }))
vi.mock('@gugu/core/cloud/attachmentsApi', () => ({ forwardAttachment: forwardMock }))

const { forwardCanonicalMessage } = await import('../../../../apps/desktop/src/lib/chatCanonicalStorage')
const base = { id: 'src-1', chat_id: 'from', retracted_at: null, deleted_at: null, file_item_id: null, file_version: null, file_blob_id: null }

beforeEach(() => { inserted.length = 0; forwardMock.mockClear() })

describe('forwardCanonicalMessage(#7290 转发走一个入口)', () => {
  it('老式附件(正文带 [URL]、字节在 chat-media):交给服务端转,不在本地插行', async () => {
    source.row = { ...base, content_type: 'attachment', content: '[附件] tool.guguext (application/vnd.gugu.extension+zip)\n[URL] https://db.test/storage/v1/object/public/chat-media/u/x-tool.guguext\n[Size] 409\n[Kind] file' }
    const sent = await forwardCanonicalMessage('src-1', 'to', 'me')
    expect(forwardMock).toHaveBeenCalledTimes(1)
    expect(forwardMock.mock.calls[0]![1]).toMatchObject({ source_message_id: 'src-1', chat_id: 'to', sender_user_id: 'me' })
    expect(sent).toMatchObject({ chat_id: 'to' })
    expect(inserted).toEqual([])
  })

  it('新式附件:同样交给服务端;条目删了的(墓碑)拒,不转', async () => {
    source.row = { ...base, content_type: 'attachment', content: '[附件] a.pdf (application/pdf)\n[Size] 3\n[Kind] file', file_item_id: 'item-1', file_version: 1 }
    await forwardCanonicalMessage('src-1', 'to', 'me')
    expect(forwardMock).toHaveBeenCalledTimes(1)
    source.row = { ...base, content_type: 'attachment', content: '[附件] a.pdf (application/pdf)\n[Size] 3\n[Kind] file' }
    await expect(forwardCanonicalMessage('src-1', 'to', 'me')).rejects.toThrow(/deleted from its group folder/)
    expect(forwardMock).toHaveBeenCalledTimes(1)
    expect(inserted).toEqual([])
  })

  it('纯文字:本地插一行,记着转自哪一条,不带任何存储列', async () => {
    source.row = { ...base, content_type: 'text', content: 'hello' }
    await forwardCanonicalMessage('src-1', 'to', 'me')
    expect(forwardMock).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ chat_id: 'to', sender_user_id: 'me', content: 'hello', content_type: 'text', forwarded_from_message_id: 'src-1' })
    expect(Object.keys(inserted[0]!).filter((k) => k.startsWith('storage_'))).toEqual([])
  })
})
