import type { FileChange } from '@gugu/session-core/files';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { gitRepoUpdateChannel, gitWorktreeUpdateChannel } from '@shared/core/git/events';
import { HEAD_REF, STAGED_REF } from '@shared/core/git/types';
import type { TextModelRegistry } from './model-registry';
import { workspaceEvents } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { log } from '@renderer/utils/logger';

/** Disk models for paths affected by a watch event (atomic saves often use create/delete, not modify). */
function diskUrisForFileChange(
  registry: TextModelRegistry,
  workspaceId: string,
  change: FileChange
): string[] {
  if (change.path.split(/[\\/]/).includes('.git')) return [];

  if (change.entryType !== 'directory') {
    return registry.findDiskUris({ workspaceId, filePath: change.path });
  }
  return [];
}

/**
 * Wire all three invalidation bridges for the given registry. Returns a
 * teardown function that removes all event subscriptions.
 *
 * Call once in `bootstrap()`.
 */
export function wireModelRegistryInvalidation(registry: TextModelRegistry): () => void {
  const refresh = (uri: string) => {
    void registry.invalidateModel(uri).catch(error => log.error('Failed to refresh editor model', { uri, error }));
  };
  // Disk file modifications → invalidate matching disk:// models.
  const unsubFs = workspaceEvents.on(fileChangesChannel, ({ workspaceId, update }) => {
    if (update.kind === 'resync') {
      for (const uri of registry.findDiskUris({ workspaceId })) {
        refresh(uri);
      }
      registry.noteDiskChange(workspaceId);
      return;
    }

    for (const change of update.changes) {
      if (change.entryType !== 'directory') registry.noteDiskChange(workspaceId, change.path);
      const uris = diskUrisForFileChange(registry, workspaceId, change);
      for (const uri of uris) {
        refresh(uri);
      }
    }
  });

  // Workspace index/HEAD changes → invalidate staged or HEAD git:// models.
  const unsubWorkspace = workspaceEvents.on(gitWorktreeUpdateChannel, ({ workspaceId, update }) => {
    const ref = update.kind === 'status' ? STAGED_REF : HEAD_REF;
    for (const uri of registry.findGitUris({ workspaceId, ref })) {
      refresh(uri);
    }
  });

  const unsubRefs = workspaceEvents.on(gitRepoUpdateChannel, ({ projectId, update }) => {
    if (update.kind !== 'refs') return;
    const refKind = 'branch';
    for (const uri of registry.findGitUris({ projectId, refKind })) {
      refresh(uri);
    }
  });

  return () => {
    unsubFs();
    unsubWorkspace();
    unsubRefs();
  };
}
