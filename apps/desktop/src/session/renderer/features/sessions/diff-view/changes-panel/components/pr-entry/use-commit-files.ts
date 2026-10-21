import type { GitChange } from '@gugu/session-core/git';
import { useQuery } from '@tanstack/react-query';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

export const commitFilesQueryKey = (projectId: string, workspaceId: string, commitHash: string) =>
  [projectId, workspaceId, 'commit-files', commitHash] as const;

export function useCommitFiles(
  projectId: string,
  workspaceId: string,
  commitHash: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: commitFilesQueryKey(projectId, workspaceId, commitHash),
    queryFn: async (): Promise<GitChange[]> => {
      const result = await workspaceRpc(projectId).gitWorktree.getCommitFiles(
        projectId,
        workspaceId,
        commitHash
      );
      if (!result.success) throw new Error('Failed to load commit files');
      return result.data.files;
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}
