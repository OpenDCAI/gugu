import { sha256 } from '@noble/hashes/sha2.js'
import { copyVerifiedFile, ciphertextSize, transformFile, type FileSink } from '../shared/fileCipher'
import { FILE_CHUNK_BYTES, MissingFileObjectError, fileRefKey, requireFileRange, parseFileMetadata, snapshotBlob, type FileBytes, type FileContext, type FileMetadata, type FileProviders, type FileRevision } from '../shared/fileResolver'
import type { FileChunkCache } from '../shared/fileCache'
import { attachmentRequest, type AttachmentsEndpoint } from './attachmentsApi'
import { withBoundedOperation } from './boundedOperation'

export type { FileChunkCache } from '../shared/fileCache'
type Download = { status: string; code?: string; url: string; expires_at?: string; thumb_url?: string | null; download_id: string; key?: string; codec?: string; sha256: string | null; size_bytes: number; ciphertext_bytes?: number; ciphertext_sha256?: string; bucket_id?: string; object_name?: string; message_id?: string }
const missingObject = (row: { status: string; code?: string }) => row.status === 'missing' && row.code === 'object_not_found'
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const cacheKey = (context: FileContext, digest: string) => hex(sha256(new TextEncoder().encode(JSON.stringify([context.actor, fileRefKey(context.ref), digest]))))
const sameLegacyObject = (revision: FileRevision, row: { bucket_id?: string; object_name?: string; message_id?: string }) =>
  !revision.legacy_object || row.bucket_id === revision.legacy_object.bucket_id && row.object_name === revision.legacy_object.object_name && row.message_id === revision.legacy_object.message_id
// An unhashed historical object cannot authenticate persistent cached chunks between opens.
const uncached: FileChunkCache = { get: async () => null, put: async () => {}, clear: async () => {} }

/** One GET continues after URL expiry. A later open replays cached chunks and ranges only the missing suffix. */
function remoteSource(size: number, key: string, cache: FileChunkCache, sign: () => Promise<Download>, fetcher: typeof fetch, signal?: AbortSignal) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, buffered: Uint8Array = new Uint8Array(), next = -1, interrupted = false
  const receive = async () => {
    try { return await reader!.read() } catch (error) { interrupted = true; throw error }
  }
  const chunk = async (index: number): Promise<Uint8Array> => {
    signal?.throwIfAborted()
    const offset = index * FILE_CHUNK_BYTES, length = Math.min(FILE_CHUNK_BYTES, size - offset)
    const hit = await cache.get(key, index)
    if (hit && hit.length !== length) throw new Error('Invalid cached file chunk')
    if (hit && (!reader || index < next)) return hit
    if (!reader) {
      const lease = await sign()
      let response: Response
      try { response = await fetcher(lease.url, { signal, headers: offset ? { Range: `bytes=${offset}-` } : {} }) }
      catch (error) { interrupted = true; throw error }
      if (response.status !== (offset ? 206 : 200) || !response.body || offset && response.headers.get('content-range') !== `bytes ${offset}-${size - 1}/${size}`) {
        await response.body?.cancel(); throw new Error(`Invalid file range response (HTTP ${response.status})`)
      }
      reader = response.body.getReader(); next = index
    }
    if (index !== next) throw new Error('File transfer must continue from its cached prefix')
    const bytes = new Uint8Array(length)
    for (let filled = 0; filled < length;) {
      if (!buffered.length) {
        const received = await receive()
        if (received.done) throw new Error('Truncated file response')
        buffered = received.value
      }
      const take = Math.min(buffered.length, length - filled)
      bytes.set(buffered.subarray(0, take), filled); buffered = buffered.subarray(take); filled += take
    }
    if (offset + length === size && (buffered.length || !(await receive()).done)) throw new Error('File response has extra bytes')
    await cache.put(key, index, bytes); next++
    return bytes
  }
  return { size, interrupted: () => interrupted, async dispose() { await reader?.cancel().catch(() => undefined) }, async read(offset: number, length: number) {
    requireFileRange(size, offset, length)
    if (!size) await chunk(0)
    const bytes = new Uint8Array(length)
    for (let filled = 0; filled < length;) {
      const at = offset + filled, part = await chunk(Math.floor(at / FILE_CHUNK_BYTES)), within = at % FILE_CHUNK_BYTES
      const take = Math.min(length - filled, part.length - within)
      bytes.set(part.subarray(within, within + take), filled); filled += take
    }
    return bytes
  } }
}

export function cloudFileProviders(deps: {
  endpoint(context: FileContext): Promise<AttachmentsEndpoint>
  sink(size: number, context: FileContext): Promise<FileSink>
  cache: FileChunkCache; fetch?: typeof fetch
  metadata?(context: FileContext): Promise<unknown>
  image?(file: FileBytes, revision: FileRevision): Promise<Blob>
  imageCache?: Pick<Cache, 'match' | 'put'>
}): Pick<FileProviders, 'metadata' | 'managed' | 'temporary' | 'preview'> {
  const request = async (context: FileContext, route: string, body: Record<string, unknown>) => {
    const endpoint = await deps.endpoint(context)
    return attachmentRequest({ ...endpoint, fetch: (url, init) => (endpoint.fetch ?? fetch)(url, { ...init, signal: context.signal }) }, route, body)
  }
  const objectFetch = async (context: FileContext, url: RequestInfo | URL, init?: RequestInit) =>
    (deps.fetch ?? (await deps.endpoint(context)).fetch ?? fetch)(url, init)
  const read = async (revision: FileRevision, context: FileContext, encrypted: boolean): Promise<FileBytes> => {
    const ref = 'item_id' in context.ref ? { ...context.ref, version: revision.version } : context.ref
    if (encrypted) await withBoundedOperation(600_000, () => new Error('File device is unavailable or its transfer timed out'), async timeout => {
      const waiting = { ...context, signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout }, requestId = crypto.randomUUID()
      for (;;) {
        waiting.signal.throwIfAborted()
        const state = await request(waiting, 'file-request', { ref, as: context.actor.actorId, request_id: requestId }) as { status: string; transfer_status: string }
        if (state.status !== 'ready' || state.transfer_status === 'retired') throw new Error('File transfer is no longer available')
        if (state.transfer_status === 'ready') break
        await new Promise(resolve => setTimeout(resolve, 700))
      }
    })
    let lease: Download | undefined
    const sign = async () => {
      const row = await request(context, 'file-download', { ref, as: context.actor.actorId, request_id: crypto.randomUUID() }) as Download
      if (missingObject(row)) throw new MissingFileObjectError()
      if (row.status !== 'ready' || typeof row.url !== 'string' || row.size_bytes !== (encrypted ? ciphertextSize(revision.size_bytes) : revision.size_bytes) || row.sha256 !== revision.sha256 || !sameLegacyObject(revision, row) ||
        encrypted && (row.ciphertext_bytes !== row.size_bytes || row.codec !== 'secretstream-v1' || !row.key || !/^[0-9a-f]{64}$/.test(row.ciphertext_sha256 ?? ''))) throw new Error('File download commitment changed')
      return lease = row
    }
    // A key still requires the current download ACL, even if every ciphertext chunk is cached.
    if (encrypted) await sign()
    const digest = encrypted ? lease!.ciphertext_sha256! : revision.sha256, key = cacheKey(context, digest ?? crypto.randomUUID())
    const source = remoteSource(encrypted ? ciphertextSize(revision.size_bytes) : revision.size_bytes, key, revision.legacy_object ? uncached : deps.cache, async () => lease ?? await sign(), (url, init) => objectFetch(context, url, init), context.signal)
    let dataKey: Uint8Array | undefined
    let sink: FileSink | undefined
    try {
      sink = await deps.sink(revision.size_bytes, context)
      if (!revision.size_bytes && !encrypted) await source.read(0, 0)
      if (encrypted) {
        dataKey = Uint8Array.from(atob(lease!.key!), char => char.charCodeAt(0))
        if (dataKey.length !== 32) throw new Error('Invalid file decryption key')
      }
      const file = encrypted ? (await transformFile({ direction: 'decrypt', revision, source, sink, key: dataKey!, ciphertextSha256: lease!.ciphertext_sha256!, signal: context.signal })).file : await copyVerifiedFile(revision, source, sink, context.signal)
      const current = await metadata({ ...context, ref }) as Download
      if (missingObject(current)) throw new MissingFileObjectError()
      if (current.status !== 'ready' || current.sha256 !== revision.sha256 || current.size_bytes !== revision.size_bytes || !sameLegacyObject(revision, current)) throw new Error('File access or revision changed during download')
      if (encrypted) await request(context, 'file-read-complete', { download_id: lease!.download_id, as: context.actor.actorId })
      return file
    } catch (error) {
      await sink?.abort()
      if (!source.interrupted() && !context.signal?.aborted) await deps.cache.clear(key)
      throw error
    } finally { dataKey?.fill(0); if (lease) delete lease.key; await source.dispose() }
  }
  const metadata = deps.metadata ?? ((context: FileContext) => request(context, 'file-resolve', { ref: context.ref, as: context.actor.actorId }))
  return {
    async metadata(context): Promise<FileMetadata> {
      return parseFileMetadata(await metadata(context), context.ref)
    },
    managed: (revision, context) => read(revision, context, false),
    temporary: (revision, context) => read(revision, context, true),
    async preview(revision, context, full) {
      const video = revision.content_type.startsWith('video/')
      if (!video && !revision.content_type.startsWith('image/')) throw new Error('File has no media preview')
      if (revision.source === 'managed-object') {
        const key = revision.sha256 === null ? null : `https://attachments.gugu.invalid/preview/${cacheKey(context, revision.sha256)}`
        const hit = key ? await deps.imageCache?.match(key) : null
        if (!video && hit) return hit.blob()
        const ref = 'item_id' in context.ref ? { ...context.ref, version: revision.version } : context.ref
        const lease = await request(context, 'file-download', { ref, as: context.actor.actorId, request_id: crypto.randomUUID() }) as Download
        if (missingObject(lease)) throw new MissingFileObjectError()
        if (lease.status !== 'ready' || lease.sha256 !== revision.sha256 || lease.size_bytes !== revision.size_bytes || !sameLegacyObject(revision, lease)) throw new Error('File preview commitment changed')
        if (video) {
          const expiresAt = Date.parse(lease.expires_at ?? '')
          if (typeof lease.url !== 'string' || !lease.url || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid video preview lease')
          return { url: lease.url, expiresAt } // Every renewal goes through the same ACL and quota signer.
        }
        if (lease.thumb_url) {
          const response = await objectFetch(context, lease.thumb_url, { signal: context.signal })
          if (!response.ok) throw new Error(`File preview HTTP ${response.status}`)
          const blob = await response.blob()
          if (!blob.type.startsWith('image/')) throw new Error('Invalid file preview image')
          if (key) await deps.imageCache?.put(key, new Response(blob)); return blob
        }
        // The signer owns thumbnail eligibility; formats without one are safe image sources as original blobs.
        return snapshotBlob(await full(), revision.content_type)
      }
      if (video) return snapshotBlob(await full(), revision.content_type)
      if (!deps.image) throw new Error('Local image preview is unavailable')
      return deps.image(await full(), revision) // The original is fully verified/decrypted before generating pixels.
    },
  }
}
