import { observer } from 'mobx-react-lite';
import { getSessionGitWorktreeStore } from '@renderer/features/sessions/stores/session-selectors';
import { isRegistered, type SessionPageStore } from '@renderer/features/sessions/stores/session-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { formatDiffLineCount } from '@renderer/utils/format-diff-line-count';
import { cn } from '@renderer/utils/utils';

export function useSessionGitDiffStats(session: SessionPageStore): {
  linesAdded: number;
  linesDeleted: number;
  visible: boolean;
} {
  const projectId = isRegistered(session) ? session.data.projectId : undefined;
  const git = projectId ? getSessionGitWorktreeStore(projectId, session.data.id) : undefined;
  const cachedGit = isRegistered(session) ? session.workspaceGit : undefined;
  const linesAdded = git?.totalLinesAdded ?? cachedGit?.linesAdded ?? 0;
  const linesDeleted = git?.totalLinesDeleted ?? cachedGit?.linesDeleted ?? 0;
  const visible =
    (git !== undefined || cachedGit !== undefined) &&
    !git?.error &&
    (linesAdded > 0 || linesDeleted > 0);
  return { linesAdded, linesDeleted, visible };
}

/**
 * Working-tree line add/remove totals for a task.
 * Uses live GitWorktreeStore data when the task is provisioned; falls back to the
 * cached workspaceGit snapshot (stored in SQLite) for unprovisioned tasks.
 * Renders nothing when loading, in error, or clean.
 */
export const SessionGitDiffStats = observer(function SessionGitDiffStats({
  session,
  className,
}: {
  session: SessionPageStore;
  className?: string;
}) {
  const { linesAdded, linesDeleted, visible } = useSessionGitDiffStats(session);
  const { translate } = useSessionMessages();

  if (!visible) return null;

  // 读屏说法:只说非零的那一半;两半都有时用同一条模板拼(与变更列表行一致)。
  const added = linesAdded > 0 ? translate('changes.linesAdded', { count: linesAdded }) : null;
  const removed = linesDeleted > 0 ? translate('changes.linesRemoved', { count: linesDeleted }) : null;
  const label = added && removed ? translate('changes.lineDelta', { additions: added, deletions: removed }) : (added ?? removed ?? undefined);

  return (
    <span
      className={cn(
        'shrink-0 tabular-nums leading-none text-foreground-muted flex items-center gap-1 text-xs',
        className
      )}
      aria-label={label}
    >
      {linesAdded > 0 ? (
        <span className="text-foreground-diff-added">+{formatDiffLineCount(linesAdded)}</span>
      ) : null}
      {linesDeleted > 0 ? (
        <span className="text-foreground-diff-deleted">-{formatDiffLineCount(linesDeleted)}</span>
      ) : null}
    </span>
  );
});
