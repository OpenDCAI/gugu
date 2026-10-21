import { dataClient } from './supabase'

/** The public bucket people's shared files go in: chat attachments, moments, feedback screenshots, group avatars. */
export const CHAT_MEDIA_BUCKET = 'chat-media'

/**
 * A file the person shares openly (a moment's image, a feedback screenshot, a group's avatar) into the public `chat-media` bucket at
 * `<userId>/<sub>/<uuid>-<name>`: the bucket's RLS reads the first segment as the uploader; the uuid keeps two files of one
 * name apart. Its public URL, and its path to take it back out if what it was for is not saved.
 */
export async function uploadPublicMedia(userId: string, sub: string, file: File): Promise<{ url: string; path: string }> {
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'file'
  const path = `${userId}/${sub}/${crypto.randomUUID()}-${safeName}`
  const { error } = await dataClient.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (error) throw new Error(error.message)
  const { data: { publicUrl } } = dataClient.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path)
  return { url: publicUrl, path }
}
