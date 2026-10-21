import { parseAttachmentContent, type AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import { parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels'
import type { AttachmentResolution } from '@gugu/core/shared/attachmentUrls'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ShareToAppsPayload } from '../platform/types'

type ShareMessage = Pick<MessageItem, 'content' | 'content_type' | 'file_item_id' | 'file_version' | 'file_blob_id'> & { id?: string }

/** 要分享的东西:附件先记字节从哪来,点下去那一刻再签成链接(安卓原生按链接下载)。 */
export interface SharePlan {
  text?: string
  files?: Array<{ source: AttachmentSource; name: string; mimeType?: string }>
}

/** 点下「分享」时把附件签成链接;条目删了就抛(整组不分享,❌ 悄悄漏掉)。 */
export async function resolveSharePlan(plan: SharePlan, resolve: (source: AttachmentSource) => Promise<AttachmentResolution>): Promise<ShareToAppsPayload> {
  const files = await Promise.all((plan.files ?? []).map(async ({ source, name, mimeType }) => {
    const link = await resolve(source)
    if (link.status === 'gone') throw new Error(`${name} was deleted`)
    return { url: link.url, name, ...(mimeType ? { mimeType } : {}) }
  }))
  return { ...(plan.text ? { text: plan.text } : {}), ...(files.length > 0 ? { files } : {}) }
}

/**
 * 几条消息一起交出去(多选转发):文字按顺序空一行接起来,附件依次排开。
 * 有一条分享不了就整组返回 null —— ❌ 悄悄漏掉其中一条。
 */
export function sharePayloadForMessages(
  messages: ReadonlyArray<ShareMessage>,
): SharePlan | null {
  const payloads = messages.map(sharePayloadForMessage)
  if (payloads.length === 0 || payloads.some((payload) => payload === null)) return null
  const texts = payloads.flatMap((payload) => (payload?.text ? [payload.text] : []))
  const files = payloads.flatMap((payload) => payload?.files ?? [])
  return {
    ...(texts.length > 0 ? { text: texts.join('\n\n') } : {}),
    ...(files.length > 0 ? { files } : {}),
  }
}

/**
 * 一条消息交给系统分享面板的内容(product spec):文字发文字;图片、文件发附件本身,附言随行。
 * 分享不了的返回 null,转发页里就不出现「分享到其他应用」:
 *   语音 —— 消息里没有可取的文件地址;文件已从群文件夹删了;卡片 / 组件 / 系统消息 —— 不是一段能交给别的 App 的内容。
 */
export function sharePayloadForMessage(
  message: ShareMessage,
): SharePlan | null {
  const content = message.content
  if (!content) return null
  if (message.content_type === 'text') return content.trim() ? { text: content } : null
  if (message.content_type !== 'attachment' || parseVoiceAttachmentContent(content)) return null
  const attachment = parseAttachmentContent(content, message)
  if (!attachment || attachment.source.kind === 'gone') return null
  return {
    files: [{ source: attachment.source, name: attachment.fileName, ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}) }],
    ...(attachment.caption ? { text: attachment.caption } : {}),
  }
}
