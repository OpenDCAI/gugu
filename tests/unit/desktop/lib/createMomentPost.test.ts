import { beforeEach, describe, expect, it, vi } from 'vitest'
// @@@plaza-compose (#1112) — createMomentPost write path. Mocks lib/supabase
// (supabase.schema('moments').from('posts').insert + getCurrentAuthUserId) via
// vi.hoisted + vi.mock. Verifies: own-user insert payload, content trim,
// empty-content rejection (no insert), and fail-loud on DB error.
const { deleteEqMock, insertMock, fromMock, removeMock, schemaMock, storageFromMock, getUidMock } = vi.hoisted(() => {
  const insert = vi.fn()
  const deleteEq = vi.fn()
  const from = vi.fn(() => ({ insert, delete: () => ({ eq: deleteEq }) }))
  const schema = vi.fn(() => ({ from }))
  const remove = vi.fn()
  const storageFrom = vi.fn(() => ({ remove }))
  return {
    deleteEqMock: deleteEq, insertMock: insert, fromMock: from, removeMock: remove,
    schemaMock: schema, storageFromMock: storageFrom, getUidMock: vi.fn(),
  }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { schema: schemaMock, storage: { from: storageFromMock } },
  getCurrentAuthUserId: getUidMock,
}))
import {
  createMomentPost,
  MomentsMediaRequiresReuploadError,
} from '../../../../apps/desktop/src/lib/moments'
beforeEach(() => {
  insertMock.mockReset()
  fromMock.mockClear()
  schemaMock.mockClear()
  getUidMock.mockReset()
  deleteEqMock.mockReset().mockResolvedValue({ error: null })
  removeMock.mockReset().mockResolvedValue({ error: null })
  storageFromMock.mockClear()
  getUidMock.mockResolvedValue('user-1')
  insertMock.mockResolvedValue({ error: null })
})
describe('createMomentPost', () => {
  it('inserts a trimmed post as the current user into moments.posts', async () => {
    const postId = await createMomentPost('  hello plaza  ')
    expect(schemaMock).toHaveBeenCalledWith('moments')
    expect(fromMock).toHaveBeenCalledWith('posts')
    const payload = insertMock.mock.calls[0][0]
    expect(payload).toMatchObject({ user_id: 'user-1', content: 'hello plaza' })
    expect(typeof payload.id).toBe('string')
    expect(payload.id.length).toBeGreaterThan(0)
    expect(postId).toBe(payload.id)
  })
  it('rejects empty / whitespace content without inserting (fail-loud)', async () => {
    await expect(createMomentPost('   ')).rejects.toThrow('动态内容不能为空')
    expect(insertMock).not.toHaveBeenCalled()
  })
  it('throws fail-loud when the insert errors', async () => {
    insertMock.mockResolvedValueOnce({ error: { message: 'new row violates row-level security' } })
    const error = await createMomentPost('blocked').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MomentsMediaRequiresReuploadError)
    expect(error).toMatchObject({ message: 'new row violates row-level security' })
  })
  it('writes canonical media and compensates both the post row and storage when media insert fails', async () => {
    insertMock
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'media insert failed' } })
    const media = [{
      id: 'media-1',
      url: 'https://cdn.test/media.png',
      mediaType: 'image/png',
      storageBucketId: 'chat-media',
      storageObjectName: 'user-1/moments/media.png',
    }]
    const error = await createMomentPost('', media).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MomentsMediaRequiresReuploadError)
    expect(error).toMatchObject({ requiresMediaReupload: true, message: 'media insert failed' })
    const postId = insertMock.mock.calls[0]?.[0].id
    expect(insertMock.mock.calls[0]?.[0]).toMatchObject({ id: postId, content: null, user_id: 'user-1' })
    expect(insertMock.mock.calls[1]?.[0]).toEqual([{
      id: 'media-1',
      post_id: postId,
      url: 'https://cdn.test/media.png',
      media_type: 'image/png',
      sort_order: 0,
      storage_bucket_id: 'chat-media',
      storage_object_name: 'user-1/moments/media.png',
    }])
    expect(deleteEqMock).toHaveBeenCalledWith('id', postId)
    expect(storageFromMock).toHaveBeenCalledWith('chat-media')
    expect(removeMock).toHaveBeenCalledWith(['user-1/moments/media.png'])
  })
  it('propagates an unauthenticated error from getCurrentAuthUserId', async () => {
    getUidMock.mockRejectedValueOnce(new Error('Not authenticated'))
    await expect(createMomentPost('hi')).rejects.toThrow('Not authenticated')
    expect(insertMock).not.toHaveBeenCalled()
  })
})
