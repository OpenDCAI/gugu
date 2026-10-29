import { attachmentRequest, uploadAttachmentPlan, type AttachmentsEndpoint, type AttachmentUploadPlan, type CommitArgs } from './attachmentsApi'
import { ciphertextSize, createFileKey, fileSha256, transformFile, type FileSink } from '../shared/fileCipher'
import { requireFileRange, type FileBytes, type FileRevision } from '../shared/fileResolver'

/**
 * #577/#791: a member on another machine hands a new file or a changed copy to the project's file host: encrypted,
 * uploaded, committed (gugu-supabase file_version_handoffs). The existing device wakeup and drain keep the bytes in the
 * host's project and publish the version and message under the requester's name.
 */
export type HandoffHost = { host_device_id?: string; host_label?: string | null; host_account_id?: string | null; host_online?: boolean }
export type HandoffOutcome = HandoffHost & (
  | { status: 'published'; version: number; message_id: string | null }
  | { status: 'conflict'; current_version: number }
  | { status: 'host_offline' | 'timeout' | 'cancelled' | 'expired' })
export type HandoffRequest = {
  itemId: string; fileName: string; contentType: string; bytes: Uint8Array; as: string
  message?: Partial<Pick<CommitArgs, 'message_id' | 'caption' | 'to_user_ids' | 'reply_to_message_id' | 'thread_root_id' | 'is_thread_root' | 'via_app'>>
} & ({ expectedVersion: number; chatId?: never } | { chatId: string; expectedVersion?: never })
/** An answer as it comes over the wire: an outcome, or a handoff still open (uploading, ready). */
type Wire = HandoffHost & { status: string }
/** A pending row the host reads (file_version_handoff_pending); a null base creates v1. */
export type PendingHandoff = { id: string; item_id: string; base_version: number | null; chat_id: string; host_device_id: string; requester_actor: string
  file_name: string; content_type: string; size_bytes: number; sha256: string; ciphertext_bytes: number; ciphertext_sha256: string }

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))

/** Both sides bind the ciphertext to the version it is meant to become. */
function nextRevision(itemId: string, baseVersion: number | null, fileName: string, contentType: string, size: number, sha256: string): FileRevision {
  return { source: 'managed-object', item_id: itemId, version: baseVersion === null ? 1 : baseVersion + 1, file_name: fileName, content_type: contentType, size_bytes: size, sha256 }
}
function memoryBytes(bytes: Uint8Array): FileBytes {
  return { size: bytes.byteLength, async read(offset, length) { requireFileRange(bytes.byteLength, offset, length); return bytes.slice(offset, offset + length) }, async dispose() {} }
}
function memorySink(size: number): FileSink & { bytes(): Uint8Array } {
  const out = new Uint8Array(size)
  let written = 0
  return {
    async write(bytes) { requireFileRange(size, written, bytes.byteLength); out.set(bytes, written); written += bytes.byteLength },
    async commit() { if (written !== size) throw new Error('Incomplete file staging'); return memoryBytes(out) },
    async abort() { out.fill(0) },
    bytes: () => out,
  }
}

/**
 * The requester's side. Answers once the host has written it, or why not: the copy is of an older version (conflict),
 * the host machine is offline (refused at once, nothing uploaded), or the host did not write it within `waitMs` (then the
 * handoff is withdrawn, so it is never written later).
 */
export async function handOffNextVersion(endpoint: AttachmentsEndpoint, input: HandoffRequest,
  { waitMs = 120_000, pollMs = 700, now = () => Date.now(), sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) } = {}): Promise<HandoffOutcome> {
  const handoffId = crypto.randomUUID(), sha256 = hex(fileSha256(input.bytes)), size = input.bytes.byteLength, cipherBytes = ciphertextSize(size)
  const asked = await attachmentRequest(endpoint, 'file-handoff-request', {
    handoff_id: handoffId, item_id: input.itemId, ...(input.expectedVersion === undefined ? { chat_id: input.chatId } : { expected_version: input.expectedVersion }),
    file_name: input.fileName, content_type: input.contentType,
    size_bytes: size, sha256, ciphertext_bytes: cipherBytes, as: input.as, ...(input.message ? { message: input.message } : {}),
  }) as Wire & { upload?: AttachmentUploadPlan }
  if (asked.status !== 'uploading') return asked as HandoffOutcome
  if (!asked.upload || asked.upload.max_bytes < cipherBytes) throw new Error('Next version upload permit size mismatch')
  const key = await createFileKey(), sink = memorySink(cipherBytes)
  try {
    const revision = nextRevision(input.itemId, input.expectedVersion ?? null, input.fileName, input.contentType, size, sha256)
    const { ciphertextSha256 } = await transformFile({ direction: 'encrypt', revision, key, sink, source: memoryBytes(input.bytes) })
    await uploadAttachmentPlan(endpoint, asked.upload, { bytes: sink.bytes(), name: 'file.enc', contentType: 'application/octet-stream' })
    // The key travels over the authenticated API only.
    await attachmentRequest(endpoint, 'file-handoff-commit', { handoff_id: handoffId, ciphertext_bytes: cipherBytes, ciphertext_sha256: ciphertextSha256, key: base64(key) })
  } finally { key.fill(0); await sink.abort() }
  const deadline = now() + waitMs
  for (;;) {
    const state = await attachmentRequest(endpoint, 'file-handoff-status', { handoff_id: handoffId, ...(now() >= deadline ? { cancel: true } : {}) }) as Wire
    if (state.status !== 'ready' && state.status !== 'uploading') return (state.status === 'cancelled' ? { ...state, status: 'timeout' } : state) as HandoffOutcome
    await sleep(pollMs)
  }
}

/** The host's side: the plaintext of a pending handoff, verified against what the requester committed. */
export async function openHandoff(endpoint: AttachmentsEndpoint, row: PendingHandoff): Promise<Uint8Array> {
  const lease = await attachmentRequest(endpoint, 'file-handoff-download', { handoff_id: row.id }) as { url: string; key: string; codec: string; ciphertext_bytes: number; ciphertext_sha256: string }
  if (lease.codec !== 'secretstream-v1' || lease.ciphertext_bytes !== ciphertextSize(row.size_bytes) || lease.ciphertext_sha256 !== row.ciphertext_sha256) {
    throw new Error('Next version commitment changed')
  }
  const response = await (endpoint.fetch ?? fetch)(lease.url)
  if (!response.ok) throw new Error(`Next version download failed (${response.status})`)
  const cipher = new Uint8Array(await response.arrayBuffer()), key = Uint8Array.from(atob(lease.key), char => char.charCodeAt(0))
  const sink = memorySink(row.size_bytes)
  try {
    if (cipher.byteLength !== lease.ciphertext_bytes || hex(fileSha256(cipher)) !== lease.ciphertext_sha256) throw new Error('Next version ciphertext changed')
    const revision = nextRevision(row.item_id, row.base_version, row.file_name, row.content_type, row.size_bytes, row.sha256)
    await transformFile({ direction: 'decrypt', revision, key, sink, source: memoryBytes(cipher), ciphertextSha256: lease.ciphertext_sha256 })
    return sink.bytes()
  } catch (error) { await sink.abort(); throw error } finally { key.fill(0) }
}

/**
 * The host did not write a handed-over file and the file did not move on: it is offline, or did not take it in
 * time. Callers say so for people, naming the machine (`outcome.host_label`, `outcome.host_account_id`). A copy of an
 * older version is not this: it is the ordinary `File revision conflict`.
 */
export class NextVersionHandoffRefused extends Error {
  override readonly name = 'NextVersionHandoffRefused'
  constructor(readonly outcome: Exclude<HandoffOutcome, { status: 'published' | 'conflict' }>) { super(`Next version handoff ${outcome.status}`) }
}
