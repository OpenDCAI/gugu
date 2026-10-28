// 渲染层调 attachments 函数(core 的那一份客户端,packages/core/src/cloud/attachmentsApi.ts):这个构建的服务器,登录的人现在的令牌。
import { commitAttachment, configuredEndpoint, uploadAttachmentBytes, type AttachmentsEndpoint, type CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import { resolveFileMimeType } from '@gugu/core/shared/ui/attachmentModels'
import { getRendererAccessToken } from './sessionPublication'
import { i18n } from '../i18n'

// 令牌只读会话协调器已发布的那一份,和数据客户端(supabase.ts 的 accessToken)同一个来源:数据客户端没有自己的 auth 会话,
// 在它身上 auth.getSession() 直接抛(「configured with the accessToken option」)。
export async function attachmentsEndpoint(): Promise<AttachmentsEndpoint> {
  const token = getRendererAccessToken()
  if (!token) throw new Error('attachments: not signed in')
  return configuredEndpoint(token)
}

/** Planning does not publish a file. The ordered commit invokes the same publisher as group-file Apps. */
export type PreparedChatAttachment = { staging_key: string } | { local: File }
async function publishNative(args: Record<string, unknown>) {
  try { return await window.electronAPI!.invoke('files:publish', args) }
  catch { throw new Error(i18n.t('attachmentView.fileUnavailable', { ns: 'messaging' })) }
}
const cloudChatAttachment = async (endpoint: AttachmentsEndpoint, file: File, chatId: string, actor: string): Promise<PreparedChatAttachment> => ({
  staging_key: await uploadAttachmentBytes(endpoint, { bytes: file, name: file.name || 'file', contentType: resolveFileMimeType(file) }, { chat_id: chatId, as: actor }),
})
export async function prepareChatAttachment(endpoint: AttachmentsEndpoint, file: File, scope: { chat_id: string; as: string; is_whisper?: boolean }): Promise<PreparedChatAttachment> {
  const native = globalThis.window?.electronAPI
  if (native && !scope.is_whisper && await publishNative({ chatId: scope.chat_id }) === true) return { local: file }
  return cloudChatAttachment(endpoint, file, scope.chat_id, scope.as)
}
export async function commitPreparedChatAttachment(endpoint: AttachmentsEndpoint, prepared: PreparedChatAttachment, args: Omit<CommitArgs, 'staging_key'>): Promise<Record<string, unknown>> {
  if ('staging_key' in prepared) return commitAttachment(endpoint, { ...args, staging_key: prepared.staging_key })
  if (args.is_whisper || !window.electronAPI) throw new Error('Project file audience changed')
  const file = prepared.local
  // A pasted file is memory-backed and has no disk path: hand main its bytes instead.
  const path = window.electronAPI.getPathForFile(file), data = path ? undefined : await file.arrayBuffer()
  const row = await publishNative({ chatId: args.chat_id, file: { name: file.name, path, size: file.size, contentType: resolveFileMimeType(file), ...(data && { data }) }, message: args }) as { id: string; version: number; message?: Record<string, unknown> } | null
  // A policy changed after planning: the same cloud provider must authorize any upload afresh.
  if (!row) return commitPreparedChatAttachment(endpoint, await cloudChatAttachment(endpoint, file, args.chat_id, args.sender_user_id), args)
  const message = row.message
  if (!message || message.id !== args.message_id || message.sender_user_id !== args.sender_user_id || message.chat_id !== args.chat_id || message.file_item_id !== row.id || message.file_version !== row.version) throw new Error('Project attachment was not committed')
  return message
}

/** One file sent to a chat as an attachment message (upload, then commit): the message row as `messages_view` has it. */
export async function sendFileToChat(file: File, to: { chatId: string; senderId: string; toUserIds?: string[] }): Promise<Record<string, unknown>> {
  const endpoint = await attachmentsEndpoint()
  const contentType = file.type || 'application/octet-stream'
  const prepared = await prepareChatAttachment(endpoint, file, { chat_id: to.chatId, as: to.senderId })
  return commitPreparedChatAttachment(endpoint, prepared, {
    message_id: crypto.randomUUID(),
    chat_id: to.chatId,
    sender_user_id: to.senderId,
    file_name: file.name || 'file',
    content_type: contentType,
    to_user_ids: to.toUserIds ?? [],
  })
}
