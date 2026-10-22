import { workspaceEvents } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { queryClient } from '@renderer/lib/query-client';
import { gitRepoUpdateChannel } from '@shared/core/git/events';

export function wireCommitHistoryInvalidation(): void {
  workspaceEvents.on(gitRepoUpdateChannel, (p) => {
    if (p.update.kind !== 'refs') return;
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[1] === 'pr-commits',
    });
  });
}
