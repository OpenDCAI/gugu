// The attachments function (gugu-supabase supabase/functions/attachments), one client for every host: the renderer, main,
// the agent inbox and the session MCP server all call these (#7290 gugu-3; 统筹 10-17: one copy, in core). Where the
// server is and whose token comes in, every time: the MCP server has its own (its context), the others read this
// build's config (`configuredEndpoint`).
//   upload → the bytes go straight to OSS (a signed form), then
//   commit → sent as a chat message (the file lands in the chat's 「附件」), or
//   place  → only put in the chat's folder (a new file, or a new version of one) — no message;
//   forward → a new-kind attachment message forwarded (the server makes the target's item);
//   urls   → signed links for items' versions or whisper messages.
import type { FileKeep } from '../shared/fileStorage'
import { getSupabaseAnonKey, getSupabaseUrl } from './config'

export type AttachmentByteProgress = { loaded: number; total?: number }
export type AttachmentUploadTransport = (url: string, init: {
  method: 'POST' | 'PUT'; body: Blob | FormData; headers?: Record<string, string>; signal?: AbortSignal
}, onProgress?: (progress: AttachmentByteProgress) => void) => Promise<{ status: number }>

export interface AttachmentsEndpoint {
  supabaseUrl: string
  anonKey: string
  token: string
  fetch?: typeof fetch
  upload?: AttachmentUploadTransport
}

/** This build's server (config), with `token`. */
export function configuredEndpoint(token: string): AttachmentsEndpoint {
  return { supabaseUrl: getSupabaseUrl(), anonKey: getSupabaseAnonKey(), token }
}

/** A refusal from the function, with its code (upload_used, version_conflict, too_large, denied, …) — said, never swallowed. */
export class AttachmentsError extends Error {
  constructor(readonly route: string, readonly status: number, readonly code: string, message: string) {
    super(`attachments/${route}: ${message}`)
  }
}

async function call(endpoint: AttachmentsEndpoint, route: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await (endpoint.fetch ?? fetch)(`${endpoint.supabaseUrl.replace(/\/+$/, '')}/functions/v1/attachments/${route}`, {
    method: 'POST',
    headers: { apikey: endpoint.anonKey, Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not json: said below as it is */ }
  if (!response.ok) {
    const said = (json ?? {}) as { error?: unknown; message?: unknown }
    throw new AttachmentsError(route, response.status, typeof said.error === 'string' ? said.error : 'failed',
      typeof said.message === 'string' ? said.message : `HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  return json
}

/** Uploads to the configured object store using the server-issued scoped upload plan. */
export async function uploadAttachmentBytes(
  endpoint: AttachmentsEndpoint,
  file: { bytes: Uint8Array | Blob; name: string; contentType: string },
  scope: { chat_id: string | null; as: string; request_id?: string },
  options?: { onPlan?: (plan: AttachmentUploadPlan) => void; retry?: boolean; onProgress?: (progress: AttachmentByteProgress) => void },
): Promise<string> {
  const size = file.bytes instanceof Blob ? file.bytes.size : file.bytes.byteLength
  const form = await call(endpoint, 'upload', {
    size_bytes: size, content_type: file.contentType, as: scope.as, chat_id: scope.chat_id, request_id: scope.request_id ?? crypto.randomUUID(),
  }) as { staging_key: string; url: string; fields: Record<string, string>; max_bytes: number; expires_at?: string; method?: 'POST' | 'PUT'; headers?: Record<string, string> }
  options?.onPlan?.(form)
  await uploadAttachmentPlan(endpoint, form, file, options?.retry === true && !!scope.request_id, options?.onProgress)
  return form.staging_key
}

export type AttachmentUploadPlan = { expires_at?: string; url: string; fields: Record<string, string>; max_bytes: number; method?: 'POST' | 'PUT'; headers?: Record<string, string> }

/** Ordinary and temporary uploads execute the same scoped provider plan; signing remains server-side. */
export async function uploadAttachmentPlan(endpoint: AttachmentsEndpoint, form: AttachmentUploadPlan, file: { bytes: Uint8Array | Blob; name: string; contentType: string }, allowExisting = false, onProgress?: (progress: AttachmentByteProgress) => void): Promise<void> {
  const size = file.bytes instanceof Blob ? file.bytes.size : file.bytes.byteLength
  if (size > form.max_bytes) throw new AttachmentsError('upload', 413, 'too_large', `${file.name} is ${size} bytes; a file is at most ${form.max_bytes}`)
  const method = form.method ?? 'POST'
  if (method !== 'POST' && method !== 'PUT') throw new AttachmentsError('upload', 502, 'invalid', 'unsupported upload method')
  const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as BlobPart], { type: file.contentType })
  let body: Blob | FormData = blob
  if (method === 'POST') {
    body = new FormData()
    for (const [key, value] of Object.entries(form.fields)) body.append(key, value)
    body.append('file', blob, file.name)
  }
  const init = { method, body, headers: method === 'PUT' ? { 'content-type': file.contentType, ...form.headers } : form.headers }
  const posted = endpoint.upload ? await endpoint.upload(form.url, init, onProgress)
    : await (endpoint.fetch ?? fetch)(form.url, init)
  if (posted.status !== 200 && posted.status !== 204 && !(allowExisting && posted.status === 409)) {
    throw new AttachmentsError('upload', posted.status, 'failed', `storing ${file.name} failed: HTTP ${posted.status}`)
  }
}

export interface CommitArgs {
  staging_key: string
  message_id: string
  chat_id: string
  sender_user_id: string
  file_name: string
  content_type?: string
  to_user_ids?: string[]
  reply_to_message_id?: string | null
  thread_root_id?: string | null
  is_thread_root?: boolean
  is_whisper?: boolean
  via_app?: string | null
  /** 图配文字:服务端接在信封后面(首尾空白去掉;空的就没有)。 */
  caption?: string
  /** The upload is this folder file's next version, from expected_version (a newer one stored since ⇒ refused, version_conflict). */
  item_id?: string
  expected_version?: number
  /** How long this copy stays (temporary | permanent); not given, the chat's rule. Needs a backend with file_storage_mark_as. */
  keep?: FileKeep
}

/** Sends the upload as an attachment message: the message row as `messages_view` has it. */
export async function commitAttachment(endpoint: AttachmentsEndpoint, args: CommitArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'commit', { ...args }) as { message: Record<string, unknown> | null }
  if (!answer.message) throw new AttachmentsError('commit', 500, 'failed', `no message came back for ${args.message_id}`)
  return answer.message
}

export interface OwnerSendArgs {
  staging_key: string
  friend_user_id: string
  agent_user_id: string
  request_id: string
  file_name: string
  content_type?: string
  caption?: string
}

/** An agent sends a file to its owner's friend as the owner (message_send_file_as_owner): the send, as the server answers it. */
export async function sendFileAsOwner(endpoint: AttachmentsEndpoint, args: OwnerSendArgs): Promise<{ chat_id: string; message_id: string; sender_user_id: string; sent_by_agent: boolean }> {
  const answer = await call(endpoint, 'commit', { ...args }) as { message: { chat_id: string; message_id: string; sender_user_id: string; sent_by_agent: boolean } | null }
  if (!answer.message) throw new AttachmentsError('commit', 500, 'failed', `no send came back for ${args.request_id}`)
  return answer.message
}

export type PlaceArgs =
  | { staging_key: string; chat_id: string; file_name: string; folder?: string | null; as_user_id?: string | null; source_message_ids?: string[]; content_type?: string; keep?: FileKeep }
  | { staging_key: string; item_id: string; expected_version: number; as_user_id?: string | null; content_type?: string; keep?: FileKeep }

/** Puts the upload in a chat's folder — a new file, or (item_id) a new version of one: the item row, as the *_as functions answer. */
export async function placeAttachment(endpoint: AttachmentsEndpoint, args: PlaceArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'place', { ...args }) as { item: Record<string, unknown> | null }
  if (!answer.item) throw new AttachmentsError('place', 500, 'failed', 'no item came back')
  return answer.item
}

export interface ForwardArgs {
  source_message_id: string
  message_id: string
  chat_id: string
  sender_user_id: string
  to_user_ids?: string[]
  thread_root_id?: string | null
  is_thread_root?: boolean
  is_whisper?: boolean
}

/** Forwards an attachment message of the new kind (its own item in the target's folder, the same bytes): the new message row. */
export async function forwardAttachment(endpoint: AttachmentsEndpoint, args: ForwardArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'forward', { ...args }) as { message: Record<string, unknown> | null }
  if (!answer.message) throw new AttachmentsError('forward', 500, 'failed', `no message came back for ${args.source_message_id}`)
  return answer.message
}

export interface ShareArgs {
  item_id: string
  /** A stored file's version (none = its current one); a text document is always sent as its text is now. */
  version?: number | null
  message_id: string
  chat_id: string
  sender_user_id: string
  to_user_ids?: string[]
  thread_root_id?: string | null
}

/** Sends a file of a chat's folder by reference — no bytes from here; the one way a folder file becomes a file card: the new message row. */
export async function shareAttachment(endpoint: AttachmentsEndpoint, args: ShareArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'share', { ...args }) as { message: Record<string, unknown> | null }
  if (!answer.message) throw new AttachmentsError('share', 500, 'failed', `no message came back for ${args.item_id}`)
  return answer.message
}

/** Shared authenticated transport for additional private attachment scopes. */
export { call as attachmentRequest }
