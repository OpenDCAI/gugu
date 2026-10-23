import { attachmentRequest, type AttachmentsEndpoint } from './attachmentsApi'

export type SessionFileInput = { file_path: string; file_name?: string; mime_type?: string }
export type SessionAttachmentRef = { attachment_id: string; file_name: string; sha256: string; size_bytes: number; content_type: string }
export type SessionAttachmentDownload = SessionAttachmentRef & { url: string; expires_at: string }

export async function commitSessionAttachment(endpoint: AttachmentsEndpoint, args: {
  staging_key: string; attachment_id: string; sender_user_id: string; sender_session_id: string;
  recipient_user_ids: string[]; file_name: string; content_type: string;
}): Promise<SessionAttachmentRef> {
  const answer = await attachmentRequest(endpoint, 'session-commit', args) as { attachment?: SessionAttachmentRef }
  if (!answer.attachment) throw new Error('Session attachment commit returned no receipt')
  return answer.attachment
}

export async function resolveSessionAttachment(endpoint: AttachmentsEndpoint, id: string, actor: string): Promise<SessionAttachmentDownload> {
  const answer = await attachmentRequest(endpoint, 'session-urls', { attachment_ids: [id], as: actor }) as { attachments?: SessionAttachmentDownload[] }
  const file = answer.attachments?.find(item => item.attachment_id === id)
  if (!file) throw new Error('Session attachment is unavailable or not addressed to this Agent')
  return file
}

/** References are data, carried inside the existing durable message envelope. No signed URLs or bytes. */
export function withSessionAttachments(text: string, files?: SessionAttachmentRef[]): string {
  if (!files?.length) return text
  if (files.length > 8 || files.some(file => !/^[0-9a-f-]{36}$/i.test(file.attachment_id)
    || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0
    || typeof file.file_name !== 'string' || typeof file.content_type !== 'string')) throw new Error('Invalid session attachment references')
  return `${text}\n\n附件（原件引用与校验信息；仅元数据）：\n${JSON.stringify(files)}`
}


export async function revokeSessionAttachment(endpoint: AttachmentsEndpoint, id: string, actor: string): Promise<void> {
  await attachmentRequest(endpoint, 'session-revoke', { attachment_id: id, as: actor })
}
