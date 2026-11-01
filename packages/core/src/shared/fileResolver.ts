import { sha256 } from '@noble/hashes/sha2.js'
import { anySignal } from './anySignal'

/** One read-only entry point. Providers own byte acquisition; callers never select URLs or transports. */
export type FileRef = { item_id: string; version?: number } | { message_id: string } | { attachment_id: string }
export type FileActor = { accountId: string; actorId: string }
export const FILE_CHUNK_BYTES = 512 * 1024
/**
 * The project id a local revision names when its device has no project bound to the chat: the files that device sent
 * are kept in its own device store, which it serves like a project root.
 */
export const DEVICE_STORE = 'device-store'

export function fileRefKey(ref: FileRef): string {
  const keys = Object.keys(ref)
  if ('item_id' in ref && typeof ref.item_id === 'string' && ref.item_id && keys.every(key => key === 'item_id' || key === 'version') &&
    (ref.version === undefined || Number.isSafeInteger(ref.version) && ref.version >= 1)) return `item:${ref.item_id}@${ref.version ?? 'current'}`
  for (const key of ['message_id', 'attachment_id'] as const) {
    const value = (ref as unknown as Record<string, unknown>)[key]
    if (keys.length === 1 && typeof value === 'string' && value) return `${key}:${value}`
  }
  throw new Error('Invalid file reference')
}

export interface FileRevision {
  source: 'local' | 'managed-object'
  item_id?: string
  version?: number
  chat_id?: string
  file_name: string
  content_type: string
  size_bytes: number
  sha256: string | null
  /** Only server-identified historical chat-media messages lack a stored digest. */
  legacy_object?: { bucket_id: 'chat-media'; object_name: string; message_id: string }
  width?: number | null
  height?: number | null
  /** The device that keeps this version: the one that sent it. */
  host_device_id?: string
  host_project_id?: string
  host_account_id?: string
  /** That device's name and whether it is online now, as the backend resolved them (readers of other accounts included). */
  host_label?: string | null
  host_online?: boolean
  relative_path?: string
  temporary_transfer?: boolean
  /** Actual workspace metadata kept at publication in the existing local revision index. */
  workspace?: { path: string; parent_id: string | null; created_at: string | null; updated_at: string | null; created_by: string | null; source_message_ids: string[] }
}
export type FileMetadata = { status: 'ready'; revision: FileRevision } | { status: 'gone' | 'expired' | 'missing'; sha256: string | null }
/** The authenticated server explicitly identified a physically missing object. */
export class MissingFileObjectError extends Error {
  constructor() { super('missing') }
}
export interface FileBytes {
  /** An authorized immutable snapshot with exact length; stored digests are verified when present. */
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  dispose(): Promise<void>
}
export type ResolvedFile = Exclude<FileMetadata, { status: 'ready' }> | {
  status: 'ready'
  purpose: 'file'
  reader: Readonly<FileActor>
  revision: FileRevision
  read(offset: number, length: number): Promise<Uint8Array>
  stream(): AsyncIterable<Uint8Array>
  dispose(): Promise<void>
}
/** Display-only pixels/playback never confer a capability to download, open or re-upload the original. */
export type FileHandle = Extract<ResolvedFile, { status: 'ready' }>
export type FilePreviewContent = Blob | { url: string; expiresAt: number }
export type ResolvedPreview = Exclude<FileMetadata, { status: 'ready' }> | {
  status: 'ready'; purpose: 'preview'; revision: FileRevision
  content(): Promise<FilePreviewContent>; dispose(): Promise<void>
}
export type FileContext = { ref: FileRef; actor: FileActor; signal?: AbortSignal }
export interface FileProviders {
  /** Must check the current account, device and project binding locally, before any cloud lookup. */
  local(context: FileContext): Promise<{ revision: FileRevision; open(): Promise<FileBytes> } | null>
  metadata(context: FileContext): Promise<FileMetadata>
  managed(revision: FileRevision, context: FileContext): Promise<FileBytes>
  /** Only an already-held owner SSH link. Null means unavailable; ACL/integrity failures must throw. */
  ssh(revision: FileRevision, context: FileContext): Promise<FileBytes | null>
  temporary(revision: FileRevision, context: FileContext): Promise<FileBytes>
  preview?(revision: FileRevision, context: FileContext, full: () => Promise<FileBytes>): Promise<FilePreviewContent>
}

export function requireFileRange(size: number, offset: number, length: number): void {
  if (![size, offset, length].every(Number.isSafeInteger) || size < 0 || offset < 0 || length < 0 ||
    length > FILE_CHUNK_BYTES || offset > size || length > size - offset) throw new Error('Invalid file range')
}

export function requireFileRevision(revision: FileRevision): void {
  requireFileRange(revision.size_bytes, 0, 0)
  const legacy = revision.sha256 === null && revision.source === 'managed-object' && !revision.item_id && revision.version == null &&
    revision.legacy_object?.bucket_id === 'chat-media' && typeof revision.legacy_object.object_name === 'string' && !!revision.legacy_object.object_name &&
    typeof revision.legacy_object.message_id === 'string' && !!revision.legacy_object.message_id
  if (!(typeof revision.sha256 === 'string' && /^[0-9a-f]{64}$/.test(revision.sha256) || legacy) || revision.legacy_object && !legacy || typeof revision.file_name !== 'string' || !revision.file_name || typeof revision.content_type !== 'string' || !revision.content_type ||
    !['local', 'managed-object'].includes(revision.source)) throw new Error('Invalid file revision')
  if (revision.source === 'local' && (!revision.item_id || !Number.isSafeInteger(revision.version) || revision.version! < 1 ||
    !revision.host_device_id || !revision.host_project_id || !revision.host_account_id || typeof revision.relative_path !== 'string' || !revision.relative_path ||
    /(^\/|\/\/|\/$|:|\\|\p{Cc}|(^|\/)\.\.?($|\/))/u.test(revision.relative_path))) throw new Error('Invalid local file revision')
}

/** The resolver response and an authorized message projection carry the same display metadata. */
export function parseFileMetadata(value: unknown, ref?: FileRef): FileMetadata {
  if (!value || typeof value !== 'object') throw new Error('Invalid file metadata')
  const row = value as FileRevision & { status: string; code?: string; bucket_id?: string; object_name?: string; message_id?: string }
  if (row.status === 'missing' && row.code === 'object_not_found') return { status: 'missing', sha256: row.sha256 ?? null }
  if (row.status === 'gone' || row.status === 'expired') return { status: row.status, sha256: row.sha256 ?? null }
  if (row.status !== 'ready') throw new Error('Invalid file metadata')
  const { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, width, height, host_device_id, host_project_id, host_account_id, host_label, host_online, relative_path, temporary_transfer } = row
  const revision = { source, item_id, version, chat_id, file_name, content_type, size_bytes, sha256, width, height, host_device_id, host_project_id, host_account_id, host_label, host_online, relative_path, temporary_transfer }
  if (source === 'managed-object' && sha256 === null && row.bucket_id === 'chat-media' && typeof row.object_name === 'string' && row.object_name &&
    ref && 'message_id' in ref && row.message_id === ref.message_id) {
    Object.assign(revision, { legacy_object: Object.freeze({ bucket_id: 'chat-media', object_name: row.object_name, message_id: row.message_id }) })
  }
  requireFileRevision(revision)
  return { status: 'ready', revision }
}

/** Resolving metadata never signs or reads. The first byte read opens exactly one authorized snapshot. */
export function createFileResolver(providers: FileProviders) {
  function resolveFile(ref: FileRef, actor: FileActor, options: { localOnly: true; purpose?: 'file'; signal?: AbortSignal }): Promise<ResolvedFile | null>
  function resolveFile(ref: FileRef, actor: FileActor, options: { purpose: 'preview'; metadata?: FileMetadata; signal?: AbortSignal }): Promise<ResolvedPreview>
  function resolveFile(ref: FileRef, actor: FileActor, options?: { purpose?: 'file'; signal?: AbortSignal }): Promise<ResolvedFile>
  async function resolveFile(ref: FileRef, actor: FileActor, options: { purpose?: 'file' | 'preview'; metadata?: FileMetadata; localOnly?: boolean; signal?: AbortSignal } = {}): Promise<ResolvedFile | ResolvedPreview | null> {
    if (!actor.accountId || !actor.actorId) throw new Error('File reader is not signed in')
    fileRefKey(ref)
    const cancellation = new AbortController()
    const context = { ref: Object.freeze({ ...ref }), actor: Object.freeze({ ...actor }), signal: options.signal }
    context.signal?.throwIfAborted()
    const local = await providers.local(context)
    if (options.localOnly && !local) return null
    if (local && (local.revision.source !== 'local' || local.revision.host_account_id !== context.actor.accountId)) throw new Error('Local file is not owned by this account')
    // A message supplies display metadata only. Full-file reads always re-resolve authorization.
    const projected = options.purpose === 'preview' ? options.metadata : undefined
    if (projected && projected.status !== 'ready') return projected
    if (projected?.status === 'ready' && 'item_id' in ref && (projected.revision.item_id !== ref.item_id ||
      ref.version !== undefined && projected.revision.version !== ref.version)) throw new Error('File preview reference changed')
    const metadata = local ? { status: 'ready' as const, revision: local.revision } : projected ?? await providers.metadata(context)
    if (metadata.status !== 'ready') return metadata
    const revision = Object.freeze({ ...metadata.revision })
    requireFileRevision(revision)
    if (revision.legacy_object && (!('message_id' in context.ref) || context.ref.message_id !== revision.legacy_object.message_id)) throw new Error('Historical file reference changed')
    context.signal = anySignal([options.signal, cancellation.signal])
    let disposed = false
    let opened: Promise<FileBytes> | undefined
    const check = () => {
      context.signal?.throwIfAborted()
      if (disposed) throw new Error('File handle is disposed')
    }
    const open = async (): Promise<FileBytes> => {
      if (local) return local.open()
      if (revision.source === 'managed-object') return providers.managed(revision, context)
      if (context.actor.accountId === revision.host_account_id && context.actor.actorId === context.actor.accountId) {
        const ownSsh = await providers.ssh(revision, context)
        if (ownSsh) return ownSsh
      }
      if (!revision.temporary_transfer) throw new Error('Cloud transfer is disabled for this file')
      return providers.temporary(revision, context)
    }
    const get = () => opened ??= open().then(async file => {
      try {
        check()
        if (file.size !== revision.size_bytes) throw new Error('File snapshot size changed')
        return file
      } catch (error) { await file.dispose(); throw error }
    })
    const read = async (offset: number, length: number) => {
      requireFileRange(revision.size_bytes, offset, length)
      check()
      if (!length) return new Uint8Array()
      const bytes = await (await get()).read(offset, length)
      check()
      if (bytes.byteLength !== length) throw new Error('File snapshot length changed')
      return bytes
    }
    const dispose = async () => {
      if (disposed) return
      disposed = true
      cancellation.abort(new Error('File handle is disposed'))
      await opened?.then(file => file.dispose(), () => undefined)
    }
    if (options.purpose === 'preview') {
      let image: Promise<FilePreviewContent> | undefined
      return { status: 'ready', purpose: 'preview', revision, dispose, content() {
        check()
        if (!providers.preview) throw new Error('File preview is unavailable')
        const load = () => providers.preview!(revision, context, get).then(content => { check(); return content })
        // A video may request a new short lease after a late Range request expires; never extend a signed URL.
        return revision.source === 'managed-object' && revision.content_type.startsWith('video/') ? load() : image ??= load()
      } }
    }
    return { status: 'ready', purpose: 'file', reader: context.actor, revision, read, dispose,
      async *stream() {
        check()
        await get() // Empty files still authenticate their final frame when deliberately opened.
        for (let offset = 0; offset < revision.size_bytes; offset += FILE_CHUNK_BYTES) {
          yield await read(offset, Math.min(FILE_CHUNK_BYTES, revision.size_bytes - offset))
        }
        check()
      },
    }
  }
  return resolveFile
}

/** A browser Blob consumes only the original capability; previews cannot be passed here. */
export async function fileBlob(file: FileHandle): Promise<Blob> {
  const chunks = file.stream()[Symbol.asyncIterator]()
  try {
    return await new Response(new ReadableStream({ async pull(controller) {
      const next = await chunks.next()
      if (next.done) controller.close(); else controller.enqueue(next.value)
    }, async cancel() { await chunks.return?.(); } })).blob().then(blob => blob.slice(0, blob.size, file.revision.content_type))
  } finally { await file.dispose() }
}

/** Only already-verified snapshots reach this display adapter. */
export async function snapshotBlob(file: FileBytes, contentType: string): Promise<Blob> {
  let offset = 0
  return new Response(new ReadableStream({ async pull(controller) {
    if (offset === file.size) { controller.close(); return }
    const length = Math.min(FILE_CHUNK_BYTES, file.size - offset), bytes = await file.read(offset, length)
    if (bytes.length !== length) throw new Error('File snapshot length changed')
    offset += bytes.length; controller.enqueue(bytes)
  } })).blob().then(blob => blob.slice(0, blob.size, contentType))
}

type FileStageSource = { revision: Pick<FileRevision, 'size_bytes' | 'sha256' | 'content_type'>; stream(): AsyncIterable<Uint8Array>; dispose(): Promise<void> }
export type FileStageCommand = { op: 'begin'; name: string; revision: FileStageSource['revision'] } | { op: 'chunk'; id: string; bytes: Uint8Array } | { op: 'commit' | 'abort'; id: string }
/** Existing native caches receive bounded frames, then verify and atomically publish a private file token. */
export async function stageFileHandle(file: FileHandle, name: string, send: (command: FileStageCommand) => Promise<unknown>): Promise<string> {
  if (file.revision.sha256 !== null) return stageFileSource(file, name, send)
  // A historical source has no server digest. Bind the native copy to the already-authorized
  // immutable snapshot with a local checksum; the historical revision itself stays unhashed.
  const hash = sha256.create()
  let observedSha: string
  try {
    requireFileRevision(file.revision)
    for await (const bytes of file.stream()) hash.update(bytes)
    observedSha = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
  } catch (error) { await file.dispose(); throw error } finally { hash.destroy() }
  return stageFileSource({ revision: { size_bytes: file.revision.size_bytes, content_type: file.revision.content_type, sha256: observedSha },
    stream: () => file.stream(), dispose: () => file.dispose() }, name, send)
}
/** Generated Blob saves use the same sink protocol, without inventing a message/file authority. */
export async function stageFileSource(file: FileStageSource, name: string, send: (command: FileStageCommand) => Promise<unknown>): Promise<string> {
  let id: string | undefined, written = 0
  try {
    const opened = await send({ op: 'begin', name, revision: file.revision }) as { id?: string }
    if (!opened?.id || typeof opened.id !== 'string') throw new Error('Invalid native file stage')
    id = opened.id
    for await (const bytes of file.stream()) { requireFileRange(file.revision.size_bytes, written, bytes.length); await send({ op: 'chunk', id, bytes }); written += bytes.length }
    if (written !== file.revision.size_bytes) throw new Error('Incomplete native file stage')
    await send({ op: 'commit', id }); return id
  } catch (error) { if (id) await send({ op: 'abort', id }); throw error }
  finally { await file.dispose() }
}
