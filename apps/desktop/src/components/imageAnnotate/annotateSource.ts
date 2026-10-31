import type { ImageViewerItem } from '@/lib/imageViewer'
import { getRendererSession } from '@/lib/sessionPublication'
import { composeInChat } from '@/session/shared/extensions/app-send-core'

/** A folder file can name its real chat without inventing an original message. */
export async function annotationItem(item: ImageViewerItem): Promise<ImageViewerItem> {
  if (item.source || item.resource?.target.kind !== 'file') return item
  const session = getRendererSession()
  if (!session) throw new Error('Sign in to read the source of this file')
  const file = item.resource.target
  const detail = await composeInChat({ account: async () => ({ token: session.access_token, userId: session.user.id }) }, {
    text: '', refs: [{ file: { id: file.itemId }, ...(file.version !== undefined ? { version: file.version } : {}) }],
  })
  return { ...item, source: { chatId: detail.chatId } }
}
