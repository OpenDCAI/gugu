import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { copyVerifiedFile, createFileKey, ciphertextSize, FILE_FRAME_BYTES, transformFile, type FileSink } from '../../../../packages/core/src/shared/fileCipher'
import { FILE_CHUNK_BYTES, type FileBytes, type FileRevision } from '../../../../packages/core/src/shared/fileResolver'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function revision(bytes: Uint8Array): FileRevision {
  return { source: 'local', item_id: 'file', version: 3, chat_id: 'group', file_name: 'original.bin', content_type: 'application/octet-stream',
    sha256: digest(bytes), size_bytes: bytes.length, host_device_id: 'device', host_project_id: 'project', host_account_id: 'owner', relative_path: 'original.bin' }
}
function source(bytes: Uint8Array): FileBytes {
  return { size: bytes.length, read: vi.fn(async (offset: number, length: number) => bytes.slice(offset, offset + length)), dispose: vi.fn(async () => {}) }
}
/** An in-memory test sink only. Product sinks must use private disk/cache staging. */
function sink() {
  const chunks: Uint8Array[] = []
  const bytes = () => {
    const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
    return out
  }
  const api: FileSink = { write: vi.fn(async chunk => { chunks.push(chunk.slice()) }), commit: vi.fn(async () => source(bytes())), abort: vi.fn(async () => { chunks.length = 0 }) }
  return { api, bytes }
}
async function encrypted(plain: Uint8Array) {
  const metadata = revision(plain), key = await createFileKey(), output = sink(), input = source(plain)
  const result = await transformFile({ direction: 'encrypt', revision: metadata, source: input, sink: output.api, key })
  return { metadata, key, bytes: output.bytes(), input, result }
}
describe('client encrypted temporary file format', () => {
  it.each([0, 3, FILE_FRAME_BYTES, FILE_FRAME_BYTES * 2 + 7])('roundtrips %i bytes with bounded reads and authenticates before publishing', async size => {
    const plain = Uint8Array.from({ length: size }, (_, i) => i % 251)
    const f = await encrypted(plain), output = sink(), input = source(f.bytes)
    expect(f.bytes.length).toBe(ciphertextSize(size))
    expect(f.result.ciphertextSha256).toBe(digest(f.bytes))
    const result = await transformFile({ direction: 'decrypt', revision: f.metadata, source: input, sink: output.api,
      key: f.key, ciphertextSha256: f.result.ciphertextSha256 })
    expect(output.bytes()).toEqual(plain)
    expect(result.file.size).toBe(size)
    expect(output.api.commit).toHaveBeenCalledTimes(1); expect(output.api.abort).not.toHaveBeenCalled()
    for (const read of [f.input.read, input.read]) {
      const calls = vi.mocked(read).mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every(([, length]) => length <= FILE_CHUNK_BYTES)).toBe(true)
    }
  })
  it('uses a fresh library header even when encrypting the same revision with the same key', async () => {
    const plain = new TextEncoder().encode('abc'), f = await encrypted(plain), output = sink()
    expect(f.metadata.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    await transformFile({ direction: 'encrypt', revision: f.metadata, source: source(plain), sink: output.api, key: f.key })
    expect(output.bytes()).not.toEqual(f.bytes)
    expect(f.key.length).toBe(32)
  })
  it.each(['key', 'format', 'header', 'ciphertext', 'version', 'plaintext-sha', 'ciphertext-sha', 'truncate', 'append', 'duplicate', 'reorder'] as const)('rejects %s corruption and never commits partial plaintext', async mutation => {
    const f = await encrypted(Uint8Array.from({ length: FILE_FRAME_BYTES * 2 + 5 }, (_, i) => i % 251))
    let bytes = f.bytes.slice(), metadata = { ...f.metadata }, cipherSha = f.result.ciphertextSha256
    const key = f.key.slice()
    if (mutation === 'key') key[0] ^= 1
    if (mutation === 'format') bytes[0] ^= 1
    if (mutation === 'header') bytes[8] ^= 1
    if (mutation === 'ciphertext') bytes[40] ^= 1
    if (mutation === 'version') metadata = { ...metadata, version: metadata.version! + 1 }
    if (mutation === 'plaintext-sha') metadata = { ...metadata, sha256: '00'.repeat(32) }
    if (mutation === 'ciphertext-sha') cipherSha = '00'.repeat(32)
    if (mutation === 'truncate') bytes = bytes.slice(0, -1)
    if (mutation === 'append') { const longer = new Uint8Array(bytes.length + 1); longer.set(bytes); bytes = longer }
    const frameLength = FILE_FRAME_BYTES + 17
    if (mutation === 'duplicate') bytes.set(bytes.slice(32, 32 + frameLength), 32 + frameLength)
    if (mutation === 'reorder') {
      const first = bytes.slice(32, 32 + frameLength), second = bytes.slice(32 + frameLength, 32 + 2 * frameLength)
      bytes.set(second, 32); bytes.set(first, 32 + frameLength)
    }
    const output = sink()
    await expect(transformFile({ direction: 'decrypt', revision: metadata, source: source(bytes), sink: output.api, key, ciphertextSha256: cipherSha })).rejects.toThrow()
    expect(output.api.commit).not.toHaveBeenCalled(); expect(output.api.abort).toHaveBeenCalledTimes(1)
    expect(output.bytes().length).toBe(0)
  })
  it('rejects an authentic last message lacking TAG_FINAL, not merely damaged ciphertext', async () => {
    const { default: sodium } = await import('libsodium-wrappers'); await sodium.ready
    const plain = new TextEncoder().encode('abc'), f = await encrypted(plain), initialized = sodium.crypto_secretstream_xchacha20poly1305_init_push(f.key)
    const aad = new TextEncoder().encode(JSON.stringify(['GGFILE01', f.metadata.item_id, f.metadata.version, f.metadata.sha256, f.metadata.size_bytes]))
    try {
      const tail = sodium.crypto_secretstream_xchacha20poly1305_push(initialized.state, plain, aad, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
      const bytes = new Uint8Array(32 + tail.length)
      bytes.set(new TextEncoder().encode('GGFILE01')); bytes.set(initialized.header, 8); bytes.set(tail, 32)
      const output = sink()
      await expect(transformFile({ direction: 'decrypt', revision: f.metadata, source: source(bytes), sink: output.api, key: f.key })).rejects.toThrow('authentication')
      expect(output.api.commit).not.toHaveBeenCalled(); expect(output.api.abort).toHaveBeenCalledTimes(1)
    } finally {
      (sodium as unknown as { libsodium: { _free(address: number): void } }).libsodium._free(initialized.state as unknown as number)
    }
  })
  it('can restart decoding by replaying a cached ciphertext prefix without fetching that prefix again', async () => {
    const plain = Uint8Array.from({ length: FILE_FRAME_BYTES * 2 + 9 }, (_, i) => i % 251), f = await encrypted(plain)
    const prefixLength = 32 + FILE_FRAME_BYTES + 17, network = vi.fn(async (offset: number, length: number) => f.bytes.slice(offset, offset + length))
    const input: FileBytes = { size: f.bytes.length, dispose: async () => {},
      read: async (offset, length) => offset + length <= prefixLength ? f.bytes.slice(offset, offset + length) : network(offset, length) }
    const output = sink()
    await transformFile({ direction: 'decrypt', revision: f.metadata, source: input, sink: output.api, key: f.key, ciphertextSha256: f.result.ciphertextSha256 })
    expect(output.bytes()).toEqual(plain)
    expect(network).toHaveBeenCalled()
    expect(network.mock.calls.every(([offset]) => offset >= prefixLength)).toBe(true)
  })
  it('cancellation aborts private staging before any output handle is published', async () => {
    const f = await encrypted(new Uint8Array(FILE_FRAME_BYTES + 1)), output = sink(), cancel = new AbortController()
    vi.mocked(output.api.write).mockImplementation(async () => { cancel.abort(new Error('Cancelled by reader')) })
    await expect(transformFile({ direction: 'decrypt', revision: f.metadata, source: source(f.bytes), sink: output.api, key: f.key, signal: cancel.signal })).rejects.toThrow('Cancelled by reader')
    expect(output.api.commit).not.toHaveBeenCalled(); expect(output.api.abort).toHaveBeenCalledTimes(1)
  })
  it('a changed host source cannot become an uploadable ciphertext snapshot', async () => {
    const plain = new TextEncoder().encode('abc'), changed = new TextEncoder().encode('abd'), output = sink()
    await expect(transformFile({ direction: 'encrypt', revision: revision(plain), source: source(changed), sink: output.api, key: await createFileKey() })).rejects.toThrow('SHA-256 mismatch')
    expect(output.api.commit).not.toHaveBeenCalled(); expect(output.api.abort).toHaveBeenCalledTimes(1)
  })
  it('the managed provider uses the same bounded SHA validation and rejects a changed copy', async () => {
    const plain = Uint8Array.from({ length: FILE_CHUNK_BYTES + 1 }, (_, i) => i % 251), metadata = { ...revision(plain), source: 'managed-object' as const }
    const input = source(plain), output = sink()
    expect((await copyVerifiedFile(metadata, input, output.api)).size).toBe(plain.length)
    expect(output.bytes()).toEqual(plain)
    expect(vi.mocked(input.read).mock.calls.every(([, length]) => length <= FILE_CHUNK_BYTES)).toBe(true)
    const changed = plain.slice(); changed[0] ^= 1
    const refused = sink()
    await expect(copyVerifiedFile(metadata, source(changed), refused.api)).rejects.toThrow('SHA-256 mismatch')
    expect(refused.api.commit).not.toHaveBeenCalled(); expect(refused.api.abort).toHaveBeenCalledTimes(1)
  })
})
