import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { writeFileHandle } from '@gugu/core/local/files/fileSnapshots'
import { verifiedFileHandle } from '../../../helpers/verifiedFileHandle'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'gugu-file-export-153-'))) throw Error('Foreign test path')
    await rm(root, { recursive: true, force: true })
  }
})
it('failed acquisition keeps a pre-existing empty user-selected directory while removing only its own partial file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-file-export-153-')); roots.push(root)
  const chosen = join(root, 'chosen-by-user'); await mkdir(chosen)
  const file = await verifiedFileHandle(new Uint8Array([1]), {}, async () => { throw Error('download denied') })
  await expect(writeFileHandle(file, join(chosen, 'file.bin'))).rejects.toThrow('download denied')
  expect(await readdir(root)).toEqual(['chosen-by-user']); expect(await readdir(chosen)).toEqual([])
})
