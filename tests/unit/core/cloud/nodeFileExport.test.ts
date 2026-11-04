import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { saveFileHandle, writeFileHandle } from '@gugu/core/local/files/fileSnapshots'
import { createFileResolver, type FileRevision } from '@gugu/core/shared/fileResolver'
import { verifiedFileHandle } from '../../../support/verifiedFileHandle'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'gugu-file-export-153-'))) throw Error('Foreign test path')
    await rm(root, { recursive: true, force: true })
  }
})
it('exports a backend-identified historical snapshot with a checksum for the saved copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-file-export-153-')); roots.push(root)
  const bytes = new Uint8Array([1, 2, 3]), revision: FileRevision = { source: 'managed-object', file_name: 'old.png', content_type: 'image/png', size_bytes: bytes.length, sha256: null,
    legacy_object: { bucket_id: 'chat-media', object_name: 'old/object', message_id: 'old-message' } }
  const file = await createFileResolver({ local: async () => null, metadata: async () => ({ status: 'ready', revision }), ssh: async () => null,
    temporary: async () => { throw Error('unexpected transfer') }, managed: async () => ({ size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length), dispose: async () => {} }),
  })({ message_id: 'old-message' }, { accountId: 'owner', actorId: 'owner' })
  if (file.status !== 'ready') throw Error('Expected ready')
  const saved = await saveFileHandle(file, root)
  expect(new Uint8Array(await readFile(saved.file_path))).toEqual(bytes)
  expect(saved.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(file.revision.sha256).toBeNull()
})
it('failed acquisition keeps a pre-existing empty user-selected directory while removing only its own partial file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-file-export-153-')); roots.push(root)
  const chosen = join(root, 'chosen-by-user'); await mkdir(chosen)
  const file = await verifiedFileHandle(new Uint8Array([1]), {}, async () => { throw Error('download denied') })
  await expect(writeFileHandle(file, join(chosen, 'file.bin'))).rejects.toThrow('download denied')
  expect(await readdir(root)).toEqual(['chosen-by-user']); expect(await readdir(chosen)).toEqual([])
})
