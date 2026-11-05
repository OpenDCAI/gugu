import { ChevronRight } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { AgentStatusGlyph } from '@renderer/lib/components/agent-status-indicator';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { sidebarRowInsetPx, SIDEBAR_ROW_DEPTH_STEP_PX } from './sidebar-row-metrics';
import type { ProjectSessionTreeRow, SessionBranchSummary } from './sidebar-session-branch';

export function SidebarSessionBranchCount({ summary, expanded, onToggle }: {
  summary: SessionBranchSummary;
  expanded: boolean;
  onToggle?: () => void;
}) {
  const { translate } = useSessionMessages();
  const label = translate('sidebar.sessionBranchCount', { count: summary.total });
  const states = summary.active.map(({ presentation, count }) =>
    `${translate(`agentStatus.${presentation.label}`)} ${count}`).join(', ');
  return (
    <button
      type="button"
      data-session-branch-count={summary.total}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-sm group-hover/row:hidden bg-foreground/5 px-1 text-[length:var(--font-caption)] leading-none text-foreground-muted tabular-nums hover:bg-foreground/10"
      aria-label={`${translate(expanded ? 'sidebar.collapseChildSessions' : 'sidebar.expandChildSessions')}: ${label}`}
      aria-expanded={expanded}
      title={states ? `${label}: ${states}` : label}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => { event.stopPropagation(); onToggle?.(); }}
    >
      <span data-branch-total>{summary.total}</span>
      {!expanded && summary.active.length > 0 ? <>
        <span aria-hidden className="mx-px h-2.5 border-l border-foreground/10" />
        {summary.active.map(({ presentation, count }) => (
          <span key={presentation.tone} className="inline-flex items-center gap-[3px]">
            <span className="inline-flex size-[9px] shrink-0 items-center justify-center"><AgentStatusGlyph presentation={presentation} label={translate(`agentStatus.${presentation.label}`)} variant="2" /></span>
            <span data-branch-running>{count}</span>
          </span>
        ))}
      </> : null}
    </button>
  );
}

export function SidebarSessionTreeGuides({ depth, tree }: { depth: number; tree: ProjectSessionTreeRow }) {
  if (depth === 0) return null;
  const parentGuide = sidebarRowInsetPx('tree', depth) - SIDEBAR_ROW_DEPTH_STEP_PX / 2;
  return <span aria-hidden className="pointer-events-none absolute inset-0">
    {tree.continuingGuides.map((level) => (
      <span key={level} className="absolute inset-y-0 border-l border-foreground/10" style={{ left: sidebarRowInsetPx('tree', level) + 8 }} />
    ))}
    <span className="absolute top-0 border-l border-foreground/10" style={{ left: parentGuide, height: tree.lastChild ? 16 : '100%' }} />
    <span className="absolute top-4 w-2 border-t border-foreground/10" style={{ left: parentGuide }} />
  </span>;
}

export function SidebarSessionBranchGateway({ sessionId, depth, remainingDepth }: {
  sessionId: string;
  depth: number;
  remainingDepth: number;
}) {
  const { translate } = useSessionMessages();
  return <button
    type="button"
    data-session-branch-gateway={sessionId}
    className="flex h-7 max-w-full items-center gap-1 rounded-sm text-xs text-foreground-muted hover:text-foreground"
    style={{ marginInlineStart: sidebarRowInsetPx('tree', depth) + 20 }}
    onClick={() => sidebarStore.showSessionBranch(sessionId)}
  >
    <ChevronRight className="size-3 shrink-0" />
    <span className="truncate">{translate('sidebar.sessionBranchMoreLevels', { count: remainingDepth })}</span>
  </button>;
}

export const SidebarSessionBranchNavigation = observer(function SidebarSessionBranchNavigation() {
  const { translate } = useSessionMessages();
  const trail = sidebarStore.sessionBranchTrail;
  if (trail.length === 0) return null;
  return <nav aria-label={translate('sidebar.sessionBranchNavigation')} className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-foreground/10 px-2 py-2 text-xs text-foreground-muted">
    <button type="button" className="hover:text-foreground" onClick={() => sidebarStore.showSessionBranch(null)}>{translate('sidebar.allProjectSessions')}</button>
    {trail.map((entry, index) => <span key={entry.id} className="inline-flex min-w-0 max-w-full items-center gap-1">
      <ChevronRight className="size-3 shrink-0" />
      <button
        type="button"
        className="truncate hover:text-foreground"
        aria-current={index === trail.length - 1 ? 'page' : undefined}
        onClick={() => sidebarStore.showSessionBranch(entry.id)}
      >{entry.title}</button>
    </span>)}
  </nav>;
});
