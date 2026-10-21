import { beforeEach, describe, expect, it, vi } from 'vitest'
const {
  commentRangeMock,
  commentOrderIdMock,
  commentOrderCreatedMock,
  commentIsMock,
  commentEqMock,
  commentMaybeSingleMock,
  commentInsertMock,
  commentDeleteEqMock,
  momentsFromMock,
  identityInMock,
  identityFromMock,
  schemaMock,
  storageRemoveMock,
  storageFromMock,
  getUidMock,
} = vi.hoisted(() => {
  const range = vi.fn()
  const orderId = vi.fn(() => ({ range }))
  const orderCreated = vi.fn(() => ({ order: orderId }))
  const is = vi.fn(() => ({ order: orderCreated }))
  const maybeSingle = vi.fn()
  const eq = vi.fn(() => ({ is, order: orderCreated, maybeSingle }))
  const commentSelect = vi.fn(() => ({ eq }))
  const commentInsert = vi.fn()
  const commentDeleteEq = vi.fn()
  const commentDelete = vi.fn(() => ({ eq: commentDeleteEq }))
  const momentsFrom = vi.fn(() => ({ select: commentSelect, insert: commentInsert, delete: commentDelete }))
  const identityIn = vi.fn()
  const identitySelect = vi.fn(() => ({
    in: vi.fn((...args: unknown[]) => ({
      abortSignal: vi.fn(() => identityIn(...args)),
    })),
  }))
  const identityFrom = vi.fn(() => ({ select: identitySelect }))
  const schema = vi.fn((name: string) => name === 'moments'
    ? { from: momentsFrom }
    : { from: identityFrom })
  const storageRemove = vi.fn()
  const storageFrom = vi.fn(() => ({ remove: storageRemove }))
  return {
    commentRangeMock: range,
    commentOrderIdMock: orderId,
    commentOrderCreatedMock: orderCreated,
    commentIsMock: is,
    commentEqMock: eq,
    commentMaybeSingleMock: maybeSingle,
    commentInsertMock: commentInsert,
    commentDeleteEqMock: commentDeleteEq,
    momentsFromMock: momentsFrom,
    identityInMock: identityIn,
    identityFromMock: identityFrom,
    schemaMock: schema,
    storageRemoveMock: storageRemove,
    storageFromMock: storageFrom,
    getUidMock: vi.fn(),
  }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { schema: schemaMock, storage: { from: storageFromMock } },
  identityDb: { from: identityFromMock },
  getCurrentAuthUserId: getUidMock,
}))
import {
  createMomentComment,
  listPostComments,
  MomentsMediaRequiresReuploadError,
} from '../../../../apps/desktop/src/lib/moments'
const createdAt = '2026-07-28T01:02:03.000Z'
function commentRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    post_id: 'post-1',
    user_id: 'user-b',
    parent_id: null,
    content: `comment ${id}`,
    created_at: createdAt,
    comment_media: [],
    ...overrides,
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  commentRangeMock.mockResolvedValue({ data: [], error: null })
  commentMaybeSingleMock.mockResolvedValue({ data: null, error: null })
  identityInMock.mockResolvedValue({ data: [], error: null })
  commentInsertMock.mockResolvedValue({ error: null })
  commentDeleteEqMock.mockResolvedValue({ error: null })
  storageRemoveMock.mockResolvedValue({ error: null })
  getUidMock.mockResolvedValue('user-me')
})
describe('listPostComments', () => {
  it('returns root and reply comments in one flat list with the replied-to author name', async () => {
    commentRangeMock.mockResolvedValueOnce({
      data: [
        commentRow('root-1', { content: 'root visible' }),
        commentRow('reply-1', { parent_id: 'root-1', content: 'reply hidden' }),
      ],
      error: null,
    })
    identityInMock.mockResolvedValueOnce({
      data: [{
        id: 'user-b', type: 'human', display_name: 'Bob', avatar: null, gugu_number: 42,
        bio: 'Builder', owner_user_id: null, agent_public: null, desired_status: null,
        device_id: null, category: null, is_official: false, local_path: null,
        created_at: null, updated_at: null,
      }],
      error: null,
    })
    const comments = await listPostComments('post-1')
    expect(commentEqMock).toHaveBeenCalledWith('post_id', 'post-1')
    expect(commentIsMock).not.toHaveBeenCalled()
    expect(comments).toHaveLength(2)
    expect(comments.find((item) => item.id === 'root-1')).toMatchObject({
      id: 'root-1', parentId: null, replyToName: null,
    })
    expect(comments.find((item) => item.id === 'reply-1')).toMatchObject({
      id: 'reply-1', parentId: 'root-1', replyToName: 'Bob',
      author: { id: 'user-b', name: 'Bob', guguNumber: 42, bio: 'Builder' },
    })
  })
  it('loads every page and uses created_at plus id for deterministic timestamp ties', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) =>
      commentRow(`comment-${String(index).padStart(3, '0')}`),
    )
    const secondPage = [commentRow('comment-200')]
    commentRangeMock
      .mockResolvedValueOnce({ data: firstPage, error: null })
      .mockResolvedValueOnce({ data: secondPage, error: null })
    identityInMock.mockResolvedValueOnce({
      data: [{
        id: 'user-b', display_name: 'Bob', avatar: 'https://example.test/bob.png',
        gugu_number: 42, bio: 'Builder', is_official: false, type: 'human', owner_user_id: null,
        agent_public: null, desired_status: null, device_id: null, category: null,
        local_path: null, created_at: null, updated_at: null,
      }],
      error: null,
    })
    const comments = await listPostComments('post-1')
    expect(comments).toHaveLength(201)
    expect(comments[0]?.id).toBe('comment-000')
    expect(comments.at(-1)?.id).toBe('comment-200')
    expect(commentOrderCreatedMock).toHaveBeenCalledWith('created_at', { ascending: true })
    expect(commentOrderIdMock).toHaveBeenCalledWith('id', { ascending: true })
    expect(commentRangeMock.mock.calls).toEqual([[0, 199], [200, 399]])
    expect(identityInMock).toHaveBeenCalledWith('id', ['user-b'])
  })
  it('returns the real empty result without an unnecessary identity query', async () => {
    await expect(listPostComments('post-empty')).resolves.toEqual([])
    expect(identityFromMock).not.toHaveBeenCalled()
  })
  it('fails loudly on any page error and on missing author identity', async () => {
    commentRangeMock.mockResolvedValueOnce({ data: null, error: { message: 'comments denied' } })
    await expect(listPostComments('post-1')).rejects.toThrow('comments denied')
    commentRangeMock.mockResolvedValueOnce({
      data: [commentRow('comment-1', { user_id: 'missing-user', content: 'orphan' })],
      error: null,
    })
    identityInMock.mockResolvedValueOnce({ data: [], error: null })
    await expect(listPostComments('post-1')).rejects.toThrow('评论作者资料缺失')
  })
})
describe('createMomentComment', () => {
  const uploadedMedia = {
    id: 'media-stable',
    url: 'https://cdn.test/reply.png',
    mediaType: 'image/png',
    storageBucketId: 'chat-media',
    storageObjectName: 'user-me/moments/reply.png',
  }
  const storedMedia = {
    id: uploadedMedia.id,
    url: uploadedMedia.url,
    media_type: uploadedMedia.mediaType,
    sort_order: 0,
    storage_bucket_id: uploadedMedia.storageBucketId,
    storage_object_name: uploadedMedia.storageObjectName,
  }
  it('writes the caller-provided stable id as a trimmed top-level comment for auth.uid()', async () => {
    await createMomentComment('post-1', '  hello friend  ', 'comment-stable')
    expect(getUidMock).toHaveBeenCalledOnce()
    expect(momentsFromMock).toHaveBeenCalledWith('post_comments')
    expect(commentInsertMock).toHaveBeenCalledWith({
      id: 'comment-stable',
      post_id: 'post-1',
      user_id: 'user-me',
      parent_id: null,
      content: 'hello friend',
    })
  })
  it('writes a parent reply and its canonical media with stable ids and sort order', async () => {
    await createMomentComment('post-1', ' reply ', 'comment-reply', {
      parentId: 'comment-root',
      media: [uploadedMedia],
    })
    expect(commentInsertMock.mock.calls[0]?.[0]).toMatchObject({
      id: 'comment-reply', parent_id: 'comment-root', content: 'reply',
    })
    expect(momentsFromMock).toHaveBeenCalledWith('comment_media')
    expect(commentInsertMock.mock.calls[1]?.[0]).toEqual([{
      id: 'media-stable',
      comment_id: 'comment-reply',
      url: 'https://cdn.test/reply.png',
      media_type: 'image/png',
      sort_order: 0,
      storage_bucket_id: 'chat-media',
      storage_object_name: 'user-me/moments/reply.png',
    }])
  })
  it('marks media metadata unusable only after the failed media write enters cleanup', async () => {
    commentInsertMock
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'comment media insert failed' } })
    const error = await createMomentComment('post-1', 'with image', 'comment-cleanup', {
      media: [uploadedMedia],
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MomentsMediaRequiresReuploadError)
    expect(error).toMatchObject({ requiresMediaReupload: true })
    expect(commentDeleteEqMock).toHaveBeenCalledWith('id', 'comment-cleanup')
    expect(storageFromMock).toHaveBeenCalledWith('chat-media')
    expect(storageRemoveMock).toHaveBeenCalledWith(['user-me/moments/reply.png'])
  })
  it('keeps ambiguous committed media reusable and converges the same id and exact media on retry', async () => {
    const persistedRows = [commentRow('comment-stable', {
      post_id: 'post-1',
      user_id: 'user-me',
      content: 'same draft',
      comment_media: [storedMedia],
    })]
    commentInsertMock
      .mockRejectedValueOnce(new TypeError('response reset after commit'))
      .mockResolvedValueOnce({ error: { message: 'duplicate key value violates unique constraint' } })
    commentMaybeSingleMock
      .mockRejectedValueOnce(new TypeError('confirmation reset'))
      .mockResolvedValueOnce({
        data: persistedRows[0],
        error: null,
      })
    const firstError = await createMomentComment('post-1', 'same draft', 'comment-stable', {
      media: [uploadedMedia],
    }).catch((cause: unknown) => cause)
    expect(firstError).toBeInstanceOf(Error)
    expect(firstError).not.toBeInstanceOf(MomentsMediaRequiresReuploadError)
    await expect(createMomentComment('post-1', 'same draft', 'comment-stable', {
      media: [uploadedMedia],
    })).resolves.toBeUndefined()
    expect(commentInsertMock).toHaveBeenCalledTimes(2)
    expect(commentInsertMock.mock.calls.map(([payload]) => payload)).toEqual([
      { id: 'comment-stable', post_id: 'post-1', user_id: 'user-me', parent_id: null, content: 'same draft' },
      { id: 'comment-stable', post_id: 'post-1', user_id: 'user-me', parent_id: null, content: 'same draft' },
    ])
    expect(persistedRows).toHaveLength(1)
    expect(persistedRows[0]?.comment_media).toEqual([storedMedia])
    expect(commentDeleteEqMock).not.toHaveBeenCalled()
    expect(storageRemoveMock).not.toHaveBeenCalled()
  })
  it('converges an ambiguous insert error only when the exact id matches post, author, and content', async () => {
    commentInsertMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    commentMaybeSingleMock.mockResolvedValueOnce({
      data: commentRow('comment-stable', {
        post_id: 'post-1',
        user_id: 'user-me',
        content: 'hello friend',
      }),
      error: null,
    })
    await expect(createMomentComment('post-1', ' hello friend ', 'comment-stable')).resolves.toBeUndefined()
    expect(commentEqMock).toHaveBeenLastCalledWith('id', 'comment-stable')
    expect(commentMaybeSingleMock).toHaveBeenCalledOnce()
  })
  it('reuses one id across an unchanged-draft retry and converges to one matching row', async () => {
    commentInsertMock
      .mockRejectedValueOnce(new TypeError('response reset after commit'))
      .mockResolvedValueOnce({ error: { message: 'duplicate key value violates unique constraint' } })
    commentMaybeSingleMock
      .mockRejectedValueOnce(new TypeError('confirmation reset'))
      .mockResolvedValueOnce({
        data: commentRow('comment-stable', {
          post_id: 'post-1',
          user_id: 'user-me',
          content: 'same draft',
        }),
        error: null,
      })
    await expect(createMomentComment('post-1', 'same draft', 'comment-stable')).rejects.toThrow()
    await expect(createMomentComment('post-1', 'same draft', 'comment-stable')).resolves.toBeUndefined()
    expect(commentInsertMock.mock.calls.map(([payload]) => payload.id)).toEqual([
      'comment-stable',
      'comment-stable',
    ])
  })
  it('fails loudly when exact-id recovery is absent or conflicts with the attempted payload', async () => {
    commentInsertMock.mockResolvedValue({ error: { message: 'insert failed' } })
    await expect(createMomentComment('post-1', 'hello', 'missing-id')).rejects.toThrow('insert failed')
    commentMaybeSingleMock.mockResolvedValueOnce({
      data: commentRow('collision-id', { post_id: 'another-post', user_id: 'user-me', content: 'hello' }),
      error: null,
    })
    await expect(createMomentComment('post-1', 'hello', 'collision-id')).rejects.toThrow('评论提交状态冲突')
  })
  it('rejects empty content and propagates auth/RLS failures that cannot be confirmed', async () => {
    await expect(createMomentComment('post-1', '   ', 'comment-empty')).rejects.toThrow('评论内容不能为空')
    expect(commentInsertMock).not.toHaveBeenCalled()
    getUidMock.mockRejectedValueOnce(new Error('Not authenticated'))
    await expect(createMomentComment('post-1', 'hello', 'comment-auth')).rejects.toThrow('Not authenticated')
    expect(commentInsertMock).not.toHaveBeenCalled()
    getUidMock.mockResolvedValueOnce('user-me')
    commentInsertMock.mockResolvedValueOnce({ error: { message: 'new row violates row-level security' } })
    await expect(createMomentComment('post-1', 'blocked', 'comment-rls')).rejects.toThrow(
      'new row violates row-level security',
    )
  })
})
