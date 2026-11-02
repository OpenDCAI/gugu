import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import type { SessionTreeNode } from '../sessions/session-tree';

export const PROJECT_SESSION_VISIBLE_LEVELS = 3;

export type SessionBranchSummary = {
  total: number;
  remainingDepth: number;
  active: { count: number; presentation: AgentStatusPresentation }[];
};

export type ProjectSessionTreeRow = {
  summary: SessionBranchSummary;
  continuingGuides: number[];
  lastChild: boolean;
};

const activeTones = ['running', 'parked'] as const;

/** Count the parent edge, not spawn history; a hidden descendant is still counted. */
export function summarizeSessionBranches<T extends {
  id: string;
  presentation?: AgentStatusPresentation | null;
}>(nodes: Iterable<SessionTreeNode<T>>): ReadonlyMap<string, SessionBranchSummary> {
  const summaries = new Map<string, SessionBranchSummary>();
  const visit = (node: SessionTreeNode<T>): SessionBranchSummary => {
    const cached = summaries.get(node.item.id);
    if (cached) return cached;
    const active = new Map<string, SessionBranchSummary['active'][number]>();
    const add = (presentation: AgentStatusPresentation, count: number) => {
      const previous = active.get('running');
      active.set('running', {
        presentation: previous?.presentation.tone === 'running' ? previous.presentation : presentation,
        count: (active.get('running')?.count ?? 0) + count,
      });
    };
    let total = 0;
    let remainingDepth = 0;
    for (const child of node.children) {
      const summary = visit(child);
      total += summary.total + 1;
      remainingDepth = Math.max(remainingDepth, summary.remainingDepth + 1);
      const presentation = child.item.presentation;
      if (presentation && activeTones.some((tone) => tone === presentation.tone)) add(presentation, 1);
      for (const state of summary.active) add(state.presentation, state.count);
    }
    const summary = {
      total,
      remainingDepth,
      active: [...active.values()],
    };
    summaries.set(node.item.id, summary);
    return summary;
  };
  for (const node of nodes) visit(node);
  return summaries;
}

/** Limit only the project projection; the complete graph and other lists stay intact. */
export function projectSessionTreeRows<T extends { sessionId: string; depth: number }>(
  rows: readonly T[],
  summaries: ReadonlyMap<string, SessionBranchSummary>,
): (T & { tree: ProjectSessionTreeRow })[] {
  const visible = rows.filter((row) => row.depth < PROJECT_SESSION_VISIBLE_LEVELS);
  const nextAtDepth: (T | undefined)[] = [];
  const projected: (T & { tree: ProjectSessionTreeRow })[] = [];
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const row = visible[index];
    const summary = summaries.get(row.sessionId);
    if (!summary) throw new Error(`Session branch summary missing for ${row.sessionId}`);
    projected.push({
      ...row,
      tree: {
        summary,
        lastChild: nextAtDepth[row.depth]?.depth !== row.depth,
        continuingGuides: Array.from({ length: Math.max(0, row.depth - 1) }, (_, depth) => depth)
          .filter((depth) => nextAtDepth[depth + 1]?.depth === depth + 1),
      },
    });
    for (let depth = row.depth; depth < PROJECT_SESSION_VISIBLE_LEVELS; depth += 1) nextAtDepth[depth] = row;
  }
  return projected.reverse();
}

export function sessionBranchGatewayDepth(row: {
  depth: number;
  hasChildren: boolean;
  tree?: ProjectSessionTreeRow;
}, expanded: boolean): number {
  return expanded && row.hasChildren && row.depth === PROJECT_SESSION_VISIBLE_LEVELS - 1
    ? row.tree?.summary.remainingDepth ?? 0
    : 0;
}
