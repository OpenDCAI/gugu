import { isAbsolute, relative } from 'node:path'
import { err, ok } from '@gugu/session-shared'
import type { IFilesRuntime, FileChangeUpdate } from '@gugu/session-core/files'

/** A directory hint only feeds watchers rooted in the workspace. Explicitly
 * watched external directories need their own feed, on the same leased API. */
export async function watchWorkspaceDirectory(
  files: Pick<IFilesRuntime, 'watchDirectory' | 'watchChanges'>,
  root: string, directory: string, changed: (update: FileChangeUpdate) => void,
) {
  const path = relative(root, directory)
  if (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')) {
    return files.watchDirectory(directory)
  }
  const subscribed = files.watchChanges(directory, changed, { recursive: false })
  if (!subscribed.success) return subscribed
  const ready = await subscribed.data.ready()
  if (!ready.success) { subscribed.data.unsubscribe(); return err(ready.error) }
  return ok(subscribed.data.unsubscribe)
}
