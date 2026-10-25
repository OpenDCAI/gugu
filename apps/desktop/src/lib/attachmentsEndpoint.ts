// 渲染层调 attachments 函数(core 的那一份客户端,packages/core/src/cloud/attachmentsApi.ts):这个构建的服务器,登录的人现在的令牌。
import { commitAttachment, configuredEndpoint, uploadAttachmentBytes, type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { getRendererAccessToken } from './sessionPublication'

// 令牌只读会话协调器已发布的那一份,和数据客户端(supabase.ts 的 accessToken)同一个来源:数据客户端没有自己的 auth 会话,
// 在它身上 auth.getSession() 直接抛(「configured with the accessToken option」)。
export async function attachmentsEndpoint(): Promise<AttachmentsEndpoint> {
  const token = getRendererAccessToken()
  if (!token) throw new Error('attachments: not signed in')
  return configuredEndpoint(token)
}

/** One file sent to a chat as an attachment message (upload, then commit): the message row as `messages_view` has it. */
export async function sendFileToChat(file: File, to: { chatId: string; senderId: string; toUserIds?: string[] }): Promise<Record<string, unknown>> {
  const endpoint = await attachmentsEndpoint()
  const contentType = file.type || 'application/octet-stream'
  const stagingKey = await uploadAttachmentBytes(endpoint, { bytes: file, name: file.name || 'file', contentType }, { chat_id: to.chatId, as: to.senderId })
  return commitAttachment(endpoint, {
    staging_key: stagingKey,
    message_id: crypto.randomUUID(),
    chat_id: to.chatId,
    sender_user_id: to.senderId,
    file_name: file.name || 'file',
    content_type: contentType,
    to_user_ids: to.toUserIds ?? [],
  })
}
