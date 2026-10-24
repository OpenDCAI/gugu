/** One read-only entry point. Providers own byte acquisition; callers never select URLs or transports. */
export type FileRef = { item_id: string; version?: number } | { message_id: string } | { attachment_id: string }
export type FileActor = { accountId: string; actorId: string }
export const FILE_CHUNK_BYTES = 512 * 1024

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
  sha256: string
  width?: number | null
  height?: number | null
  host_device_id?: string
  host_project_id?: string
  host_account_id?: string
  relative_path?: string
  temporary_transfer?: boolean
}
export type FileMetadata = { status: 'ready'; revision: FileRevision } | { status: 'gone' | 'expired'; sha256: string | null }
export interface FileBytes {
  /** An immutable, verified snapshot; length is exact. No filesystem path or write capability escapes. */
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  dispose(): Promise<void>
}
export type ResolvedFile = Exclude<FileMetadata, { status: 'ready' }> | {
  status: 'ready'
  revision: FileRevision
  read(offset: number, length: number): Promise<Uint8Array>
  stream(): AsyncIterable<Uint8Array>
  dispose(): Promise<void>
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
}

export function requireFileRange(size: number, offset: number, length: number): void {
  if (![size, offset, length].every(Number.isSafeInteger) || size < 0 || offset < 0 || length < 0 ||
    length > FILE_CHUNK_BYTES || offset > size || length > size - offset) throw new Error('Invalid file range')
}

export function requireFileRevision(revision: FileRevision): void {
  requireFileRange(revision.size_bytes, 0, 0)
  if (!/^[0-9a-f]{64}$/.test(revision.sha256) || typeof revision.file_name !== 'string' || !revision.file_name || typeof revision.content_type !== 'string' || !revision.content_type ||
    !['local', 'managed-object'].includes(revision.source)) throw new Error('Invalid file revision')
  if (revision.source === 'local' && (!revision.item_id || !Number.isSafeInteger(revision.version) || revision.version! < 1 ||
    !revision.host_device_id || !revision.host_project_id || !revision.host_account_id || typeof revision.relative_path !== 'string' || !revision.relative_path ||
    /(^\/|\/\/|\/$|:|\\|\p{Cc}|(^|\/)\.\.?($|\/))/u.test(revision.relative_path))) throw new Error('Invalid local file revision')
}

/** Resolving metadata never signs or reads. The first byte read opens exactly one verified snapshot. */
export function createFileResolver(providers: FileProviders) {
  return async function resolveFile(ref: FileRef, actor: FileActor, options: { signal?: AbortSignal } = {}): Promise<ResolvedFile> {
    if (!actor.accountId || !actor.actorId) throw new Error('File reader is not signed in')
    fileRefKey(ref)
    const context = { ref: Object.freeze({ ...ref }), actor: Object.freeze({ ...actor }), signal: options.signal }
    context.signal?.throwIfAborted()
    const local = await providers.local(context)
    if (local && (local.revision.source !== 'local' || local.revision.host_account_id !== context.actor.accountId)) throw new Error('Local file is not owned by this account')
    const metadata = local ? { status: 'ready' as const, revision: local.revision } : await providers.metadata(context)
    if (metadata.status !== 'ready') return metadata
    const revision = Object.freeze({ ...metadata.revision })
    requireFileRevision(revision)
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
      if (!revision.temporary_transfer) throw new Error('Cloud transfer is disabled for this project')
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
    return { status: 'ready', revision, read,
      async *stream() {
        check()
        await get() // Empty files still authenticate their final frame when deliberately opened.
        for (let offset = 0; offset < revision.size_bytes; offset += FILE_CHUNK_BYTES) {
          yield await read(offset, Math.min(FILE_CHUNK_BYTES, revision.size_bytes - offset))
        }
      },
      async dispose() {
        if (disposed) return
        disposed = true
        await opened?.then(file => file.dispose(), () => undefined)
      },
    }
  }
}
