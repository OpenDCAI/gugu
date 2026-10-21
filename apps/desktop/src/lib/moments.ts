import type {
  MomentsAuthor,
  MomentsComment,
  MomentsMedia,
  MomentsPost,
} from '@gugu/core/shared/types/moments'
import { i18n } from '@/i18n'
import { readDisplayIdentities } from './identityReadAdapter'
import { rendererLogger } from './log'
import { CHAT_MEDIA_BUCKET, uploadPublicMedia } from './publicMedia'
import {
  subscribePrivateUserEventBus,
  unsubscribePrivateUserEventBus,
  type PrivateUserEventBusHandle,
} from './realtimeChannel'
import { getCurrentAuthUserId, dataClient } from './supabase'

const moments = () => dataClient.schema('moments')
const momentsLog = rendererLogger('moments')

export interface MomentsUploadedMedia {
  id: string
  url: string
  mediaType: string
  storageBucketId: string
  storageObjectName: string
}

export interface MomentsSubscriptionHandlers {
  onPostsChange?: () => void
  onLikesChange?: () => void
  onCommentsChange?: () => void
}

export class MomentsMediaRequiresReuploadError extends Error {
  readonly requiresMediaReupload = true

  constructor(message: string) {
    super(message)
    this.name = 'MomentsMediaRequiresReuploadError'
  }
}

type MediaRow = {
  id: string
  url: string
  media_type: string
  sort_order: number
  storage_bucket_id: string | null
  storage_object_name: string | null
}

type PostRow = {
  id: string
  user_id: string
  content: string | null
  created_at: string
  post_media: MediaRow[]
}

type IdentityUserRow = {
  id: string
  display_name: string
  avatar: string | null
  gugu_number: number | null
  bio: string | null
  is_official: boolean | null
}

type LikeRow = {
  post_id: string
  user_id: string
}

type CommentCountRow = {
  post_id: string
}

type CommentRow = {
  id: string
  post_id: string
  user_id: string
  parent_id: string | null
  content: string
  created_at: string
  comment_media: MediaRow[]
}

type StorageRow = {
  storage_bucket_id: string | null
  storage_object_name: string | null
}

const COMMENT_PAGE_SIZE = 200

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mapAuthor(row: IdentityUserRow): MomentsAuthor {
  return {
    id: row.id,
    name: row.display_name,
    avatar: row.avatar,
    guguNumber: row.gugu_number,
    bio: row.bio,
    isOfficial: row.is_official ?? false,
  }
}

function mapMedia(row: MediaRow): MomentsMedia {
  return {
    id: row.id,
    url: row.url,
    mediaType: row.media_type,
    sortOrder: row.sort_order,
    storageObjectName: row.storage_object_name,
  }
}

function sortedMedia(rows: MediaRow[] | null | undefined): MomentsMedia[] {
  return (rows ?? [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    .map(mapMedia)
}

function normalizeUploadedMedia(media: MomentsUploadedMedia[]): MomentsUploadedMedia[] {
  const ids = new Set<string>()
  return media.map((item) => {
    if (!item.id || !item.url || !item.mediaType || !item.storageObjectName) {
      throw new Error('Moments media is missing its canonical upload metadata')
    }
    if (item.storageBucketId !== CHAT_MEDIA_BUCKET) {
      throw new Error(`Unsupported moments storage bucket: ${item.storageBucketId}`)
    }
    if (ids.has(item.id)) throw new Error(`Duplicate moments media id: ${item.id}`)
    ids.add(item.id)
    return item
  })
}

function uploadedStorageRows(media: MomentsUploadedMedia[]): StorageRow[] {
  return media.map((item) => ({
    storage_bucket_id: item.storageBucketId,
    storage_object_name: item.storageObjectName,
  }))
}

function canonicalStorageReferences(rows: StorageRow[]): Array<{ bucket: string; objectName: string }> {
  return rows.flatMap((row) => {
    const bucket = row.storage_bucket_id
    const objectName = row.storage_object_name
    if (bucket == null && objectName == null) return []
    if (bucket == null || objectName == null) {
      throw new Error('Moments media has a partial canonical storage reference')
    }
    return [{ bucket, objectName }]
  })
}

async function removeStorageRows(rows: StorageRow[]): Promise<void> {
  const byBucket = new Map<string, string[]>()
  for (const reference of canonicalStorageReferences(rows)) {
    const names = byBucket.get(reference.bucket) ?? []
    names.push(reference.objectName)
    byBucket.set(reference.bucket, names)
  }
  const failures: string[] = []
  for (const [bucket, names] of byBucket) {
    const { error } = await dataClient.storage.from(bucket).remove(names)
    if (error) failures.push(`${bucket}: ${error.message}`)
  }
  if (failures.length > 0) throw new Error(`Moments storage cleanup failed: ${failures.join('; ')}`)
}

async function throwAfterCreateCleanup(
  ownerTable: 'posts' | 'post_comments',
  ownerId: string,
  media: MomentsUploadedMedia[],
  cause: unknown,
): Promise<never> {
  const cleanupFailures: string[] = []
  const { error: rowError } = await moments().from(ownerTable).delete().eq('id', ownerId)
  if (rowError) cleanupFailures.push(`row: ${rowError.message}`)
  try {
    await removeStorageRows(uploadedStorageRows(media))
  } catch (error: unknown) {
    cleanupFailures.push(errorMessage(error))
  }
  const suffix = cleanupFailures.length > 0 ? `; cleanup failed: ${cleanupFailures.join('; ')}` : ''
  const message = `${errorMessage(cause)}${suffix}`
  if (media.length > 0) throw new MomentsMediaRequiresReuploadError(message)
  throw new Error(message)
}

async function fetchAuthors(userIds: string[]): Promise<Map<string, IdentityUserRow>> {
  const rows = await readDisplayIdentities(userIds)
  return new Map(rows.map((row) => [row.id, row]))
}

export async function uploadMomentsImage(file: File): Promise<MomentsUploadedMedia> {
  if (!file.type.startsWith('image/')) throw new Error('Moments uploads must be images')
  const { url, path } = await uploadPublicMedia(await getCurrentAuthUserId(), 'moments', file)
  return {
    id: crypto.randomUUID(),
    url,
    mediaType: file.type,
    storageBucketId: CHAT_MEDIA_BUCKET,
    storageObjectName: path,
  }
}

export async function createMomentPost(
  content: string,
  media: MomentsUploadedMedia[] = [],
): Promise<string> {
  const trimmed = content.trim()
  const normalizedMedia = normalizeUploadedMedia(media)
  if (!trimmed && normalizedMedia.length === 0) {
    throw new Error(i18n.t('moments.errors.postRequired', { ns: 'main' }))
  }
  const userId = await getCurrentAuthUserId()
  const postId = crypto.randomUUID()
  try {
    const { error: postError } = await moments().from('posts').insert({
      id: postId,
      user_id: userId,
      content: trimmed || null,
    })
    if (postError) throw new Error(postError.message)
    if (normalizedMedia.length > 0) {
      const { error: mediaError } = await moments().from('post_media').insert(
        normalizedMedia.map((item, sortOrder) => ({
          id: item.id,
          post_id: postId,
          url: item.url,
          media_type: item.mediaType,
          sort_order: sortOrder,
          storage_bucket_id: item.storageBucketId,
          storage_object_name: item.storageObjectName,
        })),
      )
      if (mediaError) throw new Error(mediaError.message)
    }
    return postId
  } catch (error: unknown) {
    return throwAfterCreateCleanup('posts', postId, normalizedMedia, error)
  }
}

export async function deleteMomentPost(postId: string): Promise<void> {
  const currentUserId = await getCurrentAuthUserId()
  const { data: post, error: postError } = await moments()
    .from('posts')
    .select('id, user_id')
    .eq('id', postId)
    .maybeSingle()
  if (postError) throw new Error(postError.message)
  if (!post || (post as { user_id: string }).user_id !== currentUserId) {
    throw new Error(`Moment post ${postId} not found or not deletable`)
  }

  const [postMediaResult, commentsResult] = await Promise.all([
    moments()
      .from('post_media')
      .select('storage_bucket_id, storage_object_name')
      .eq('post_id', postId),
    moments().from('post_comments').select('id').eq('post_id', postId),
  ])
  if (postMediaResult.error) throw new Error(postMediaResult.error.message)
  if (commentsResult.error) throw new Error(commentsResult.error.message)
  const commentIds = ((commentsResult.data ?? []) as Array<{ id: string }>).map((row) => row.id)
  let commentMediaRows: StorageRow[] = []
  if (commentIds.length > 0) {
    const { data, error } = await moments()
      .from('comment_media')
      .select('storage_bucket_id, storage_object_name')
      .in('comment_id', commentIds)
    if (error) throw new Error(error.message)
    commentMediaRows = (data ?? []) as StorageRow[]
  }
  const mediaRows = [
    ...((postMediaResult.data ?? []) as StorageRow[]),
    ...commentMediaRows,
  ]
  await removeStorageRows(mediaRows)

  const { data: deleted, error: deleteError } = await moments()
    .from('posts')
    .delete()
    .eq('id', postId)
    .select('id')
  if (deleteError) throw new Error(deleteError.message)
  if (((deleted ?? []) as unknown[]).length === 0) {
    throw new Error(`Moment post ${postId} not found or not deletable`)
  }
}

/** Set the current user's desired like state for a visible post. */
export async function togglePostLike(postId: string, liked: boolean): Promise<void> {
  const userId = await getCurrentAuthUserId()
  if (liked) {
    const { error } = await moments().from('post_likes').upsert(
      { id: crypto.randomUUID(), post_id: postId, user_id: userId },
      { onConflict: 'post_id,user_id', ignoreDuplicates: true },
    )
    if (error) throw new Error(error.message)
    return
  }
  const { error } = await moments()
    .from('post_likes')
    .delete()
    .eq('post_id', postId)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
}

export async function listFeedPosts(limit = 20): Promise<MomentsPost[]> {
  const { data: rows, error } = await moments()
    .from('posts')
    .select('id, user_id, content, created_at, post_media(id, url, media_type, sort_order, storage_bucket_id, storage_object_name)')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  if (!rows || rows.length === 0) return []

  const postRows = rows as PostRow[]
  const postIds = postRows.map((row) => row.id)
  const userIds = [...new Set(postRows.map((row) => row.user_id))]
  const [currentUserId, authorById, likesResult, commentsResult] = await Promise.all([
    getCurrentAuthUserId(),
    fetchAuthors(userIds),
    moments().from('post_likes').select('post_id, user_id').in('post_id', postIds),
    moments().from('post_comments').select('post_id').in('post_id', postIds),
  ])
  if (likesResult.error) throw new Error(likesResult.error.message)
  if (commentsResult.error) throw new Error(commentsResult.error.message)

  const likeCountByPost = new Map<string, number>()
  const likedByMe = new Set<string>()
  for (const row of (likesResult.data ?? []) as LikeRow[]) {
    likeCountByPost.set(row.post_id, (likeCountByPost.get(row.post_id) ?? 0) + 1)
    if (row.user_id === currentUserId) likedByMe.add(row.post_id)
  }
  const commentCountByPost = new Map<string, number>()
  for (const row of (commentsResult.data ?? []) as CommentCountRow[]) {
    commentCountByPost.set(row.post_id, (commentCountByPost.get(row.post_id) ?? 0) + 1)
  }

  return postRows.map((row): MomentsPost => {
    const author = authorById.get(row.user_id)
    if (!author) throw new Error(`Moment post author is missing: ${row.user_id}`)
    return {
      id: row.id,
      author: mapAuthor(author),
      content: row.content,
      createdAt: row.created_at,
      media: sortedMedia(row.post_media),
      likeCount: likeCountByPost.get(row.id) ?? 0,
      likedByMe: likedByMe.has(row.id),
      commentCount: commentCountByPost.get(row.id) ?? 0,
      isMine: row.user_id === currentUserId,
    }
  })
}

export async function listPostComments(postId: string): Promise<MomentsComment[]> {
  const commentRows: CommentRow[] = []
  let offset = 0
  let hasMore = true
  while (hasMore) {
    const { data: rows, error } = await moments()
      .from('post_comments')
      .select('id, post_id, user_id, parent_id, content, created_at, comment_media(id, url, media_type, sort_order, storage_bucket_id, storage_object_name)')
      .eq('post_id', postId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + COMMENT_PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const page = (rows ?? []) as CommentRow[]
    commentRows.push(...page)
    hasMore = page.length === COMMENT_PAGE_SIZE
    if (hasMore) offset += COMMENT_PAGE_SIZE
  }
  if (commentRows.length === 0) return []

  commentRows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const userIds = [...new Set(commentRows.map((row) => row.user_id))]
  const [currentUserId, authorById] = await Promise.all([
    getCurrentAuthUserId(),
    fetchAuthors(userIds),
  ])
  const commentById = new Map(commentRows.map((row) => [row.id, row]))
  return commentRows.map((row): MomentsComment => {
    const author = authorById.get(row.user_id)
    if (!author) throw new Error(i18n.t('moments.errors.commentAuthorMissing', { ns: 'main' }))
    const parent = row.parent_id == null ? null : commentById.get(row.parent_id)
    if (row.parent_id != null && !parent) throw new Error(`Reply target is missing: ${row.parent_id}`)
    const parentAuthor = parent ? authorById.get(parent.user_id) : null
    if (parent && !parentAuthor) {
      throw new Error(i18n.t('moments.errors.commentAuthorMissing', { ns: 'main' }))
    }
    return {
      id: row.id,
      postId: row.post_id,
      parentId: row.parent_id,
      author: mapAuthor(author),
      content: row.content,
      createdAt: row.created_at,
      media: sortedMedia(row.comment_media),
      isMine: row.user_id === currentUserId,
      replyToName: parentAuthor?.display_name ?? null,
    }
  })
}

function commentBaseMatches(
  row: CommentRow,
  expected: { postId: string; userId: string; parentId: string | null; content: string },
): boolean {
  return row.post_id === expected.postId
    && row.user_id === expected.userId
    && row.parent_id === expected.parentId
    && row.content === expected.content
}

function commentMediaMatches(rows: MediaRow[], expected: MomentsUploadedMedia[]): boolean {
  if (rows.length !== expected.length) return false
  const expectedById = new Map(expected.map((item, sortOrder) => [item.id, { item, sortOrder }]))
  return rows.every((row) => {
    const match = expectedById.get(row.id)
    return match != null
      && row.url === match.item.url
      && row.media_type === match.item.mediaType
      && row.sort_order === match.sortOrder
      && row.storage_bucket_id === match.item.storageBucketId
      && row.storage_object_name === match.item.storageObjectName
  })
}

async function readCommentForConfirmation(commentId: string): Promise<{
  data: CommentRow | null
  error: { message: string } | null
}> {
  return moments()
    .from('post_comments')
    .select('id, post_id, user_id, parent_id, content, created_at, comment_media(id, url, media_type, sort_order, storage_bucket_id, storage_object_name)')
    .eq('id', commentId)
    .maybeSingle() as unknown as Promise<{
      data: CommentRow | null
      error: { message: string } | null
    }>
}

export async function createMomentComment(
  postId: string,
  content: string,
  commentId: string,
  opts: { parentId?: string | null; media?: MomentsUploadedMedia[] } = {},
): Promise<void> {
  const trimmed = content.trim()
  const parentId = opts.parentId ?? null
  const media = normalizeUploadedMedia(opts.media ?? [])
  if (!trimmed && media.length === 0) {
    throw new Error(i18n.t('moments.errors.commentRequired', { ns: 'main' }))
  }
  if (!commentId) throw new Error(i18n.t('moments.errors.commentIdRequired', { ns: 'main' }))

  const userId = await getCurrentAuthUserId()
  const expected = { postId, userId, parentId, content: trimmed }
  let insertFailure: Error | null = null
  try {
    const { error } = await moments().from('post_comments').insert({
      id: commentId,
      post_id: postId,
      user_id: userId,
      parent_id: parentId,
      content: trimmed,
    })
    if (error) insertFailure = new Error(error.message)
  } catch (error: unknown) {
    insertFailure = error instanceof Error
      ? error
      : new Error(i18n.t('moments.errors.commentWriteFailed', { ns: 'main' }))
  }

  if (insertFailure) {
    let verification: Awaited<ReturnType<typeof readCommentForConfirmation>>
    try {
      verification = await readCommentForConfirmation(commentId)
    } catch (error: unknown) {
      const detail = errorMessage(error)
      throw new Error(i18n.t('moments.errors.commentConfirmationFailed', {
        ns: 'main', error: insertFailure.message, detail,
      }))
    }
    if (verification.error) {
      throw new Error(i18n.t('moments.errors.commentConfirmationFailed', {
        ns: 'main', error: insertFailure.message, detail: verification.error.message,
      }))
    }
    if (!verification.data) throw insertFailure
    if (!commentBaseMatches(verification.data, expected)) {
      throw new Error(i18n.t('moments.errors.commentConflict', { ns: 'main' }))
    }
    const storedMedia = verification.data.comment_media ?? []
    if (commentMediaMatches(storedMedia, media)) return
    if (storedMedia.length > 0) {
      throw new Error(i18n.t('moments.errors.commentConflict', { ns: 'main' }))
    }
  }

  if (media.length === 0) return
  try {
    const { error } = await moments().from('comment_media').insert(
      media.map((item, sortOrder) => ({
        id: item.id,
        comment_id: commentId,
        url: item.url,
        media_type: item.mediaType,
        sort_order: sortOrder,
        storage_bucket_id: item.storageBucketId,
        storage_object_name: item.storageObjectName,
      })),
    )
    if (!error) return
    insertFailure = new Error(error.message)
  } catch (error: unknown) {
    insertFailure = error instanceof Error
      ? error
      : new Error(i18n.t('moments.errors.commentWriteFailed', { ns: 'main' }))
  }

  try {
    const verification = await readCommentForConfirmation(commentId)
    if (!verification.error && verification.data
      && commentBaseMatches(verification.data, expected)
      && commentMediaMatches(verification.data.comment_media ?? [], media)) {
      return
    }
  } catch {
    // The original media write remains the primary failure; cleanup below is bounded and fail loud.
  }
  return throwAfterCreateCleanup('post_comments', commentId, media, insertFailure)
}

export async function deleteMomentComment(commentId: string): Promise<void> {
  const { data: mediaRows, error: mediaError } = await moments()
    .from('comment_media')
    .select('storage_bucket_id, storage_object_name')
    .eq('comment_id', commentId)
  if (mediaError) throw new Error(mediaError.message)
  canonicalStorageReferences((mediaRows ?? []) as StorageRow[])
  const { data: deleted, error: deleteError } = await moments()
    .from('post_comments')
    .delete()
    .eq('id', commentId)
    .select('id')
  if (deleteError) throw new Error(deleteError.message)
  if (((deleted ?? []) as unknown[]).length === 0) {
    throw new Error(`Moment comment ${commentId} not found or not deletable`)
  }
  await removeStorageRows((mediaRows ?? []) as StorageRow[])
}

export function subscribeMoments(handlers: MomentsSubscriptionHandlers): () => void {
  let disposed = false
  let handle: PrivateUserEventBusHandle | null = null
  const invalidateAll = () => {
    handlers.onPostsChange?.()
    handlers.onLikesChange?.()
    handlers.onCommentsChange?.()
  }

  void getCurrentAuthUserId()
    .then((userId) => {
      if (disposed) return
      handle = subscribePrivateUserEventBus(
        userId,
        'moments_changed',
        (payload) => {
          const area = payload && typeof payload === 'object' && 'area' in payload
            ? (payload as { area?: unknown }).area
            : null
          if (area === 'posts') handlers.onPostsChange?.()
          else if (area === 'likes') handlers.onLikesChange?.()
          else if (area === 'comments') handlers.onCommentsChange?.()
          else invalidateAll()
        },
        { onSubscribed: invalidateAll },
      )
    })
    .catch((error) => momentsLog.error({ error }, 'realtime subscription failed'))

  return () => {
    disposed = true
    if (handle) unsubscribePrivateUserEventBus(handle)
  }
}
