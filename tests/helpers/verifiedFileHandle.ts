import { createHash } from 'node:crypto'
import { createFileResolver, type FileHandle, type FileRevision } from '../../packages/core/src/shared/fileResolver'

/** A real canonical handle over a test-only immutable provider; no URL or download implementation is mocked. */
export async function verifiedFileHandle(bytes: Uint8Array, fields: Partial<FileRevision> = {}, acquire?: (signal?: AbortSignal) => Promise<Uint8Array>): Promise<FileHandle> {
  const revision: FileRevision = { source: 'managed-object', file_name: 'file.bin', content_type: 'application/octet-stream', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...fields }
  const open = async (_revision: FileRevision, context: { signal?: AbortSignal }) => {
    const snapshot = acquire ? await acquire(context.signal) : bytes.slice()
    if (snapshot.length !== revision.size_bytes || createHash('sha256').update(snapshot).digest('hex') !== revision.sha256) throw Error('Fixture file commitment changed')
    return { size: snapshot.length, read: async (offset: number, length: number) => new Uint8Array(snapshot.subarray(offset, offset + length)), dispose: async () => {} }
  }
  const file = await createFileResolver({ local: async () => null, metadata: async () => ({ status: 'ready', revision }), managed: open, ssh: async () => null, temporary: open })({ message_id: 'test' }, { accountId: 'owner', actorId: 'agent' })
  if (file.status !== 'ready') throw Error('Expected fixture file')
  return file
}
