import type { WorkspaceKind, WorkspaceType } from '@shared/core/workspaces/workspaces';

type WorkspaceRow = {
  kind: WorkspaceKind | null | undefined;
  type: WorkspaceType;
  path: string | null | undefined;
};

/**
 * Derives a `WorkspaceKind` for a workspace row, falling back to inference
 * from legacy columns when `kind` is null (i.e. pre-migration rows).
 *
 * This is a retrieval-path compatibility helper — it must never be used to
 * backfill or write values; new rows should always set `kind` explicitly.
 */
/**
 * 「自带机器」(BYOI)与项目 SSH 工作区随 SSH 远程一起下架(#6264),产品不再写这种行;库里留下的旧行不在这台电脑上,
 * ❌ 当本机目录去开、去扫、去删。这几列在下次迁移时删。
 */
export function isRetiredRemoteWorkspace(row: {
  kind?: string | null;
  type?: WorkspaceType | null;
  location?: 'local' | 'remote' | null;
}): boolean {
  return row.kind === 'byoi' || row.location === 'remote' || (row.type != null && row.type !== 'local');
}

export function resolveWorkspaceKind(row: WorkspaceRow): WorkspaceKind {
  if (row.kind) return row.kind;

  // Legacy inference from workspace type and path presence.
  if (row.type === 'byoi') return 'byoi';

  // Local/SSH workspaces with a resolved path are either a worktree or a
  // project-root.  We cannot distinguish them without additional context, so
  // we default to 'worktree' which covers the common case.
  return 'worktree';
}
