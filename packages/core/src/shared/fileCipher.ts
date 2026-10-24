import { sha256 } from '@noble/hashes/sha2.js'
import type { StateAddress } from 'libsodium-wrappers'
import { FILE_CHUNK_BYTES, requireFileRevision, type FileBytes, type FileRevision } from './fileResolver'

// Versioned framing, not a cipher: libsodium supplies the nonce, authentication and stream state.
const MAGIC = new TextEncoder().encode('GGFILE01')
const HEADER_BYTES = 24
const AUTH_BYTES = 17
export const FILE_FRAME_BYTES = 256 * 1024
export interface FileSink {
  /** Private staging only; commit atomically publishes the authenticated result. */
  write(bytes: Uint8Array): Promise<void>
  commit(): Promise<FileBytes>
  abort(): Promise<void>
}
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const loadSodium = async () => {
  const { default: sodium } = await import('libsodium-wrappers')
  await sodium.ready
  return sodium
}
export async function createFileKey(): Promise<Uint8Array> {
  return (await loadSodium()).crypto_secretstream_xchacha20poly1305_keygen()
}
export function ciphertextSize(size: number): number {
  const total = MAGIC.length + HEADER_BYTES + size + Math.max(1, Math.ceil(size / FILE_FRAME_BYTES)) * AUTH_BYTES
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(total)) throw new Error('Invalid file size')
  return total
}
/** All authenticated frames bind to the immutable revision, including its expected plaintext digest. */
function associatedData(revision: FileRevision): Uint8Array {
  requireFileRevision(revision)
  if (!revision.item_id || !Number.isSafeInteger(revision.version)) throw new Error('Missing immutable file revision')
  return new TextEncoder().encode(JSON.stringify(['GGFILE01', revision.item_id, revision.version, revision.sha256, revision.size_bytes]))
}
async function exact(source: FileBytes, offset: number, length: number): Promise<Uint8Array> {
  const bytes = await source.read(offset, length)
  if (bytes.byteLength !== length) throw new Error('Truncated file stream')
  return bytes
}

/** Managed bytes use the same digest check and private staging as local or decrypted bytes. */
export async function copyVerifiedFile(revision: FileRevision, source: FileBytes, sink: FileSink, signal?: AbortSignal): Promise<FileBytes> {
  const hash = sha256.create()
  try {
    requireFileRevision(revision)
    if (source.size !== revision.size_bytes) throw new Error('File stream size mismatch')
    for (let offset = 0; offset < source.size; offset += FILE_CHUNK_BYTES) {
      signal?.throwIfAborted()
      const bytes = await exact(source, offset, Math.min(FILE_CHUNK_BYTES, source.size - offset))
      hash.update(bytes)
      await sink.write(bytes)
    }
    signal?.throwIfAborted()
    if (hex(hash.digest()) !== revision.sha256) throw new Error('File SHA-256 mismatch')
    return await sink.commit()
  } catch (error) { await sink.abort(); throw error } finally { hash.destroy() }
}

/** Plaintext/ciphertext are bounded reads; neither a whole file nor secret stream state crosses IPC. */
export async function transformFile(input: {
  direction: 'encrypt' | 'decrypt'; revision: FileRevision; source: FileBytes; sink: FileSink
  key: Uint8Array; ciphertextSha256?: string; signal?: AbortSignal
}): Promise<{ file: FileBytes; ciphertextSha256: string }> {
  const { revision, source, sink, signal } = input
  const plainHash = sha256.create(), cipherHash = sha256.create()
  let sodium: Awaited<ReturnType<typeof loadSodium>> | undefined
  let state: StateAddress | undefined
  try {
    const aad = associatedData(revision)
    sodium = await loadSodium()
    if (sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES !== HEADER_BYTES ||
      sodium.crypto_secretstream_xchacha20poly1305_ABYTES !== AUTH_BYTES) throw new Error('Unsupported secretstream format')
    if (source.size !== (input.direction === 'encrypt' ? revision.size_bytes : ciphertextSize(revision.size_bytes))) throw new Error('File stream size mismatch')
    signal?.throwIfAborted()
    let header: Uint8Array
    if (input.direction === 'encrypt') {
      const initialized = sodium.crypto_secretstream_xchacha20poly1305_init_push(input.key)
      state = initialized.state
      header = new Uint8Array(MAGIC.length + HEADER_BYTES)
      header.set(MAGIC); header.set(initialized.header, MAGIC.length)
      await sink.write(header)
    } else {
      header = await exact(source, 0, MAGIC.length + HEADER_BYTES)
      if (!MAGIC.every((byte, index) => header[index] === byte)) throw new Error('Unknown encrypted file format')
      state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header.subarray(MAGIC.length), input.key)
    }
    cipherHash.update(header)
    const frames = Math.max(1, Math.ceil(revision.size_bytes / FILE_FRAME_BYTES))
    for (let frame = 0, encryptedOffset = header.length; frame < frames; frame++) {
      signal?.throwIfAborted()
      const offset = frame * FILE_FRAME_BYTES, length = Math.min(FILE_FRAME_BYTES, revision.size_bytes - offset)
      const tag = frame === frames - 1 ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      let plain: Uint8Array, cipher: Uint8Array
      if (input.direction === 'encrypt') {
        plain = await exact(source, offset, length)
        cipher = sodium.crypto_secretstream_xchacha20poly1305_push(state, plain, aad, tag)
        await sink.write(cipher)
      } else {
        cipher = await exact(source, encryptedOffset, length + AUTH_BYTES)
        const pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(state, cipher, aad)
        if (!pulled || pulled.tag !== tag || pulled.message.byteLength !== length) throw new Error('File authentication failed')
        plain = pulled.message
        await sink.write(plain)
      }
      plainHash.update(plain); cipherHash.update(cipher)
      encryptedOffset += cipher.length
    }
    signal?.throwIfAborted()
    const digest = hex(cipherHash.digest())
    if (hex(plainHash.digest()) !== revision.sha256 || input.ciphertextSha256 && digest !== input.ciphertextSha256) throw new Error('File SHA-256 mismatch')
    return { file: await sink.commit(), ciphertextSha256: digest }
  } catch (error) {
    await sink.abort()
    throw error
  } finally {
    plainHash.destroy(); cipherHash.destroy()
    // Pinned 0.8.4 returns a malloc-owned numeric state; its push/pull wrappers do not release it.
    if (state !== undefined) (sodium as unknown as { libsodium: { _free(address: number): void } }).libsodium._free(state as unknown as number)
  }
}
