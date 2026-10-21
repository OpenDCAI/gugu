import { err, ok, withLease } from '@gugu/session-shared';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import type {
  BrowseDirectoryParams,
  BrowseDirectoryResult,
  DirectoryEntry,
} from '@shared/core/fs/fs';

export async function browseDirectory(
  params: BrowseDirectoryParams
): Promise<BrowseDirectoryResult> {
  return withLease(runtimeManager.acquire(), async (runtime) => {
    const files = runtime.files;
    if (!files.path.isAbsolute(params.path)) {
      return err({
        type: 'invalid-path',
        path: params.path,
        message: `Expected absolute path: ${params.path}`,
      });
    }

    const opened = files.fileSystem();
    if (!opened.success) {
      return err({
        type: 'filesystem-error',
        path: params.path,
        message: opened.error.message,
      });
    }

    const listing = await opened.data.readDirectory(params.path);
    if (!listing.success) {
      return err({
        // Keep the variant the filesystem reported — flattening an
        // `invalid-path` into `filesystem-error` throws away a distinction
        // this function makes itself a few lines above.
        type: listing.error.type === 'invalid-path' ? 'invalid-path' : 'filesystem-error',
        path: listing.error.path || params.path,
        message: listing.error.message,
      });
    }

    const entries: DirectoryEntry[] = listing.data.map((stat) => ({
      path: stat.path,
      name: files.path.basename(stat.path),
      type: stat.type,
      size: stat.size,
      modifiedAt: stat.mtime,
    }));

    return ok(entries.sort(compareDirectoryEntries));
  });
}

function compareDirectoryEntries(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.type === 'directory' && right.type !== 'directory') return -1;
  if (left.type !== 'directory' && right.type === 'directory') return 1;
  return left.name.localeCompare(right.name);
}
