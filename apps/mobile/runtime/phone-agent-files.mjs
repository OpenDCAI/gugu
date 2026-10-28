import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { downloadSessionFile } from '../../../packages/core/src/local/agent/sessionFileHandoff.ts'
import { basename, join } from 'node:path'
import { receivePhoneDeviceFile } from '../../desktop/electron/phone-device-file.ts'
import { uploadAttachmentBytes, commitAttachment } from '../../../packages/core/src/cloud/attachmentsApi.ts'
import { parseAttachmentContent } from '../../../packages/core/src/shared/ui/attachmentModels.ts'
import { createNodeFileResolver, saveFileHandle } from '../../../packages/core/src/local/files/fileSnapshots.ts'
import { resolveAttachmentMimeType } from '../../../packages/core/src/shared/imageMime.mjs'
import { phoneArtifactListTool, phoneTextFileTool } from './phone-agent-file-read.mjs'
import { phoneTextWriteTool } from './phone-agent-file-write.mjs'
import { createPhoneChatAccess } from './phone-agent-chat.mjs'
import { stableId, uuid } from './phone-agent-store.mjs'

const result = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], details: data })
const asResult = (data, id) => data?.ok === false ? { v: 1, call_id: id, ...data } : { v: 1, call_id: id, ok: true, data }

/** The phone admits attachment messages without auto-downloading bytes into the model context. */
export function phoneInboxAttachmentRow(row) {
  if (row.contentType !== 'attachment') return row
  const attachment = parseAttachmentContent(row.content, { id: row.id, file_item_id: row.fileItemId, file_version: row.fileVersion, file_blob_id: row.fileBlobId })
  if (!attachment) return row
  const metadata = { source_message_id: `msg:${uuid(row.id, 'attachment message id')}`, file_name: attachment.fileName, mime_type: attachment.mimeType, size: attachment.sizeBytes, kind: attachment.kind, available: attachment.source.kind !== 'gone', ...(attachment.caption ? { caption: attachment.caption } : {}) }
  return { ...row, content: `聊天附件元数据（文件内容尚未读取）：\n${JSON.stringify(metadata)}\n${metadata.available ? '需要完整文件时，调用 message_download_file，并使用以上 source_message_id；它会按你的实际可见性解析附件。' : '这个附件已删除或不可见，没有文件内容可供读取。'}` }
}

export async function registerArtifact({ store, agent, file, groups }) {
  file = { ...file, file_path: await realpath(file.file_path) }
  const id = stableId('phone-artifact', store.state.ownerId, agent.agentUserId, file.file_path, file.sha256)
  store.state.artifacts ??= {}
  store.state.artifacts[id] = { ...file, artifact_id: id, ownerId: store.state.ownerId, agentUserId: agent.agentUserId, sessionId: agent.sessionId, groups, createdAt: new Date().toISOString() }
  await store.save()
  const { permissionRequirements: _privateProof, ...shown } = file
  return { ...shown, artifact_id: id }
}

/** Media bytes stay between native and Node. Pi sees a complete private artifact, never a base64 string. */
export async function receivePhoneArtifact({ first, args, read, agent, job, signal, store, root, group }) {
  const id = randomUUID()
  const complete = await receivePhoneDeviceFile({ first: asResult(first, id), args, root: join(root, 'artifacts', store.state.ownerId, uuid(agent.sessionId)), signal, read: async (next) => asResult(await read(next), id) })
  if (!complete.ok) throw Object.assign(new Error(complete.message), { code: complete.code })
  if (!complete.data?.file_path) throw new Error('手机没有返回完整文件')
  const { pictures: _pictures, ...metadata } = complete.data
  const data = await registerArtifact({ store, agent, file: { ...metadata, permissionRequirements: structuredClone(job?.permissionRequirements ?? []) }, groups: [group] })
  if (job) { job.usedGroups = [...new Set([...(job.usedGroups ?? []), group])]; await store.save() }
  // Mobile Pi currently advertises text-only model input. Native thumbnails may be used
  // by device callers, but cannot be injected as image blocks into this model session.
  return { data, content: [{ type: 'text', text: JSON.stringify(data) }] }
}

export async function authorizedPhoneArtifact({ agent, job, store, authorize }, path) {
    if (typeof path !== 'string') throw new Error('file_path 必须使用手机工具或 message_download_file 返回的路径')
    const file = Object.values(store.state.artifacts ?? {}).find((entry) => entry.file_path === path && entry.ownerId === store.state.ownerId && entry.agentUserId === agent.agentUserId)
    if (!file) throw new Error('只能发送你这位手机 Agent 已读取并登记的完整文件，请先用手机媒体读取工具或 message_download_file')
    if (await realpath(path) !== path) throw new Error('登记文件路径发生变化，未发送')
    const before = await stat(path)
    if (!before.isFile() || before.size !== file.size) throw new Error('登记文件已变化，未发送')
    const bytes = await readFile(path)
    if (bytes.length !== before.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('登记文件内容已变化，未发送')
    await authorize([...new Set([...(job.usedGroups ?? []), ...file.groups])], file)
    return { file, bytes }
}

export function phoneFileTools({ agent, job, cloud, store, env, authorize, emit }) {
  const access = createPhoneChatAccess({ agent, cloud, store, env })
  const files = createNodeFileResolver(join(store.directory, 'file-cache'), () => cloud.attachmentEndpoint())
  const artifact = (path) => authorizedPhoneArtifact({ agent, job, store, authorize }, path)
  return [
    phoneArtifactListTool({ agent, job, store, authorize }),
    phoneTextFileTool({ agent, job, store, authorize }),
    phoneTextWriteTool({ agent, job, store, authorize, registerArtifact }),
    {
      name: 'message_send_file', label: '发送手机文件', description: '以你自己的 Agent 身份，把手机媒体读取或 message_download_file 返回的完整私有文件作为咕咕附件发送。只传 file_path，不传文件内容或base64；发送前重新检查权限、群规、成员和文件hash。',
      parameters: { type: 'object', required: ['chat_id', 'file_path'], properties: { chat_id: { type: 'string' }, file_path: { type: 'string' }, file_name: { type: 'string' }, mime_type: { type: 'string' }, caption: { type: 'string' }, to_user_ids: { type: 'array', items: { type: 'string' } }, reply_to_message_id: { type: 'string' } } },
      execute: async (_callId, args) => {
        const id = await access.chatId(args.chat_id)
        const recipients = args.to_user_ids ? await Promise.all(args.to_user_ids.map(access.userId)) : []
        await access.beforeWrite(id, recipients)
        const { file, bytes } = await artifact(args.file_path)
        const groups = [...new Set([...(job.usedGroups ?? []), ...file.groups])]
        await authorize(groups, file)
        const name = args.file_name?.trim() || file.name || basename(file.file_path)
        const messageId = stableId('phone-file-message', agent.agentUserId, job.id, id, file.sha256, name, recipients, args.caption ?? '')
        store.state.fileOutbox ??= {}
        const entry = store.state.fileOutbox[messageId] ??= { id: messageId, agentUserId: agent.agentUserId, artifactId: file.artifact_id, groups, status: 'pending', chatId: id, fileName: name, recipients, caption: args.caption ?? '', replyToMessageId: args.reply_to_message_id ? uuid(args.reply_to_message_id.replace(/^msg:/, ''), 'reply source') : null }
        if (entry.status === 'sent') return result({ ok: true, message_id: `msg:${messageId}`, chat_id: id })
        await store.save()
        let endpoint = await cloud.attachmentEndpoint()
        const contentType = resolveAttachmentMimeType(name, args.mime_type ?? file.mime_type)
        if (!entry.stagingKey) {
          entry.stagingKey = await uploadAttachmentBytes(endpoint, { bytes, name, contentType }, { chat_id: id, as: agent.agentUserId })
          await store.save()
        }
        // Upload is not delivery. Recheck after uploading and refresh the short owner token before commit.
        await authorize(groups, file); await access.beforeWrite(id, recipients)
        endpoint = await cloud.attachmentEndpoint()
        const message = await commitAttachment(endpoint, { staging_key: entry.stagingKey, message_id: messageId, chat_id: id, sender_user_id: agent.agentUserId, file_name: name, content_type: contentType, to_user_ids: recipients, reply_to_message_id: args.reply_to_message_id ? uuid(args.reply_to_message_id.replace(/^msg:/, ''), 'reply source') : null, thread_root_id: job.route?.chatId === id ? job.route.threadRootId ?? null : null, is_thread_root: false, is_whisper: false, caption: args.caption })
        if (message.id !== messageId) throw new Error('文件发送回执与请求不一致，请先查看消息历史再重试')
        entry.status = 'sent'; entry.sentAt = new Date().toISOString()
        job.sent = [...new Set([...(job.sent ?? []), messageId])]
        await store.save(); emit({ type: 'file_sent', sessionId: agent.sessionId, agentUserId: agent.agentUserId, messageId, chatId: id })
        return result({ ok: true, message_id: `msg:${messageId}`, chat_id: id, file_name: name, size: file.size })
      },
    },
    {
      name: 'message_download_file', label: '读取聊天附件', description: '按聊天消息 source_message_id 或会话消息附件引用 source_attachment_id 下载完整文件到这台手机的 App 私有目录。只返回可供 message_send_file 复用的路径和hash，文件字节不进入文字上下文。',
      parameters: { type: 'object', properties: { source_message_id: { type: 'string' }, source_attachment_id: { type: 'string' } } },
      execute: async (_callId, args, signal) => {
        if (Boolean(args.source_message_id) === Boolean(args.source_attachment_id)) throw new Error('Provide exactly one attachment source')
        if (args.source_attachment_id) {
          const file = await downloadSessionFile(await cloud.attachmentEndpoint(), uuid(args.source_attachment_id), agent.agentUserId, join(store.directory, 'downloads', agent.sessionId), signal)
          return result(await registerArtifact({ store, agent, groups: [], file: { file_path: file.file_path, name: file.file_name, size: file.size_bytes, sha256: file.sha256, mime_type: file.content_type } }))
        }
        const id = uuid(String(args.source_message_id).replace(/^msg:/, ''), 'source_message_id')
        if (await cloud.rpc('chat', 'can_read_message', { p_message_id: id, p_user_id: agent.agentUserId }) !== true) throw new Error('这条附件消息对你不可见')
        const { data: message, error } = await cloud.chat.from('messages').select('id,chat_id,content,content_type,file_item_id,file_version,file_blob_id').eq('id', id).single()
        if (error) throw new Error(error.message)
        const attachment = message.content_type === 'attachment' ? parseAttachmentContent(message.content, message) : null
        if (!attachment) throw new Error('这条消息没有附件')
        const full = await files({ message_id: id }, { accountId: store.state.ownerId, actorId: agent.agentUserId }, { signal })
        if (full.status !== 'ready') throw new Error('这条消息的附件已删除或不可见')
        const file = await saveFileHandle(full, join(store.directory, 'downloads', agent.sessionId), attachment.fileName)
        return result(await registerArtifact({ store, agent, groups: [], file: { file_path: file.file_path, name: file.file_name, size: file.size_bytes, sha256: file.sha256, mime_type: file.content_type } }))
      },
    },
  ]
}
