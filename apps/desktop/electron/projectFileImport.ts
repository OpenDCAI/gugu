import { createReadStream, constants } from 'node:fs'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { FileRevision } from '@gugu/core/shared/fileResolver'
import { etagOf, inWorkspace } from './session/main/core/files/workspace-transfer'
import { sanitizeRemoteFileName } from './remoteFileOpen'

const digest = async (file: string) => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
/** Imported sends are project-owned copies; an existing published copy is reused only after re-verification. */
export async function importProjectFile(root: string, file: { path: string; name: string; size: number }, find: (sha: string) => Promise<FileRevision | null>) {
  const before = await stat(file.path, { bigint: true })
  if (!before.isFile() || Number(before.size) !== file.size) throw new Error('Selected file changed')
  const unchanged = async () => { if (etagOf(await stat(file.path, { bigint: true })) !== etagOf(before)) throw new Error('Selected file changed') }
  const sha = await digest(file.path)
  await unchanged()
  const saved = await find(sha)
  if (saved) {
    const path = await inWorkspace(root, saved.relative_path!)
    try { if ((await stat(path)).size === file.size && await digest(path) === sha) { await unchanged(); return path } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  // Create and re-check each level: an existing .gugu or attachments symlink cannot escape the root.
  for (const path of ['.gugu', '.gugu/attachments']) await mkdir(await inWorkspace(root, path), { recursive: true, mode: 0o700 })
  const directory = await inWorkspace(root, '.gugu/attachments/' + randomUUID())
  await mkdir(directory, { mode: 0o700 })
  const target = join(directory, sanitizeRemoteFileName(file.name))
  try {
    // A clone where the filesystem has copy-on-write (APFS, btrfs, XFS), a copy elsewhere: the version keeps its bytes when
    // the original is edited afterwards (an agent handed that original as its input), without a second full write.
    await copyFile(file.path, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    await unchanged()
    if (await digest(target) !== sha) throw new Error('Imported file changed')
    return target
  } catch (error) {
    await rm(directory, { recursive: true, force: true }) // Only this newly-created, not-yet-published directory.
    throw error
  }
}
