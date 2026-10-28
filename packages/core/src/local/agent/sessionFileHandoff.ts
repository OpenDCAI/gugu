import { createHash, randomUUID } from 'node:crypto'
import { readFile, rmdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { uploadAttachmentBytes, type AttachmentsEndpoint } from '../../cloud/attachmentsApi'
import { commitSessionAttachment, revokeSessionAttachment, type SessionFileInput } from '../../cloud/sessionAttachments'
import { resolveAttachmentMimeType } from '../../shared/imageMime.mjs'
import { userIdFromSupabaseAccessToken } from '../../cloud/runtimeAuthProvider'
import { createNodeFileResolver, saveFileHandle } from '../files/fileSnapshots'

const MAX_BYTES = 25 * 1024 * 1024
export async function uploadSessionFile(endpoint: AttachmentsEndpoint, file: SessionFileInput, sender: {
  agentId: string; sessionId: string; recipients: string[]; expectedSha256?: string;
  beforeCommit?: () => Promise<void>; attachmentId?: string; stagingKey?: string; onStaged?: (key: string) => Promise<void>;
}) {
  const info = await stat(file.file_path)
  if (!info.isFile()) throw new Error('Session attachment must be a regular file')
  const size = info.size
  if (size > MAX_BYTES) throw new Error('Session attachment exceeds 25 MiB')
  const bytes = await readFile(file.file_path)
  if (bytes.length > MAX_BYTES) throw new Error('Session attachment exceeds 25 MiB')
  const name = file.file_name ?? basename(file.file_path)
  const contentType = resolveAttachmentMimeType(name, file.mime_type)
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sender.expectedSha256 && sender.expectedSha256 !== sha) throw new Error('Registered artifact changed before upload')
  const stagingKey = sender.stagingKey ?? await uploadAttachmentBytes(endpoint, { bytes, name, contentType }, { chat_id: null, as: sender.agentId })
  await sender.onStaged?.(stagingKey)
  await sender.beforeCommit?.()
  const args = { staging_key: stagingKey, attachment_id: sender.attachmentId ?? randomUUID(), sender_user_id: sender.agentId,
    sender_session_id: sender.sessionId, recipient_user_ids: sender.recipients, file_name: name, content_type: contentType }
  // Retry the same upload and id; never create another file to recover a lost receipt.
  let receipt
  for (let attempt = 0; ; attempt++) {
    try { receipt = await commitSessionAttachment(endpoint, args); break } catch (error) {
      if (attempt >= 2 || (typeof (error as { status?: number }).status === 'number' && (error as { status: number }).status < 500)) throw error
    }
  }
  if (receipt.sha256 !== sha || Number(receipt.size_bytes) !== bytes.length) {
    await revokeSessionAttachment(endpoint, args.attachment_id, sender.agentId)
    throw new Error('Uploaded session attachment differs from the original bytes')
  }
  return receipt
}

export async function downloadSessionFile(endpoint: AttachmentsEndpoint, id: string, actor: string, directory: string, signal?: AbortSignal) {
  const accountId = userIdFromSupabaseAccessToken(endpoint.token)
  if (!accountId) throw new Error('Session attachment reader is not signed in')
  const staging = join(directory, '.staging')
  try {
    const file = await createNodeFileResolver(staging, async () => endpoint)({ attachment_id: id }, { accountId, actorId: actor }, { signal })
    if (file.status !== 'ready') throw new Error('Session attachment is no longer readable')
    if (file.revision.size_bytes > MAX_BYTES) { await file.dispose(); throw new Error('Session attachment exceeds 25 MiB') }
    return { ...await saveFileHandle(file, directory), attachment_id: id }
  } finally { await rmdir(staging).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }) }
}

/** No recipient is admitted yet. Revoke only references created by this failed preparation. */
export async function uploadSessionFiles(endpoint: AttachmentsEndpoint, files: SessionFileInput[], sender: Parameters<typeof uploadSessionFile>[2]) {
  for (const file of files) {
    const info = await stat(file.file_path)
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Session attachment must be a regular file of at most 25 MiB')
  }
  const refs = []
  try {
    for (const file of files) refs.push(await uploadSessionFile(endpoint, file, sender))
    return refs
  } catch (error) {
    const cleanup = await Promise.allSettled(refs.map(ref => revokeSessionAttachment(endpoint, ref.attachment_id, sender.agentId)))
    const failures = cleanup.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
    if (failures.length) throw new AggregateError([error, ...failures.map(entry => entry.reason)], 'File preparation failed and reference revocation could not be confirmed')
    throw error
  }
}
