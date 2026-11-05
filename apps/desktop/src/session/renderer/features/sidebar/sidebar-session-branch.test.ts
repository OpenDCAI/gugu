import { describe, expect, it } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { buildSessionTree, flattenSessionTree } from '../sessions/session-tree';
import { projectSessionTreeRows, sessionBranchGatewayDepth, summarizeSessionBranches } from './sidebar-session-branch';

const working = presentAgentStatus({ reading: { status: 'working', detail: null } });
const parked = presentAgentStatus({ reading: { status: 'working', detail: 'parked' } });
const waiting = presentAgentStatus({ reading: { status: 'needs_user', detail: 'question' } });

describe('project session branch projection', () => {
  it('counts hidden descendants and running work, excluding the parent and parked work', () => {
    const roots = buildSessionTree([
      { id: 'root', presentation: working },
      { id: 'live', parentSessionId: 'root', presentation: working },
      { id: 'background', parentSessionId: 'root', presentation: parked },
      { id: 'waiting', parentSessionId: 'background', presentation: waiting },
      { id: 'quiet', parentSessionId: 'waiting', presentation: null },
    ]);
    const summaries = summarizeSessionBranches(roots);
    expect(summaries.get('root')).toMatchObject({
      total: 4,
      remainingDepth: 3,
      active: [{ count: 1, presentation: { tone: 'running', animate: true } }],
    });
    expect(summaries.get('live')).toMatchObject({ total: 0, active: [] });
    expect(summaries.get('background')).toMatchObject({ total: 2, active: [] });
  });

  it('does not call parked background or scheduled work running', () => {
    const roots = buildSessionTree([{ id: 'root' }, { id: 'parked', parentSessionId: 'root', presentation: parked }]);
    expect(summarizeSessionBranches(roots).get('root')?.active)
      .toEqual([]);
  });

  it('still counts a running descendant underneath a parked parent', () => {
    const roots = buildSessionTree([
      { id: 'root' },
      { id: 'parked', parentSessionId: 'root', presentation: parked },
      { id: 'live', parentSessionId: 'parked', presentation: working },
    ]);
    expect(summarizeSessionBranches(roots).get('root')?.active)
      .toEqual([{ count: 1, presentation: working }]);
  });

  it('fails loudly if a projected row does not come from the indexed forest', () => {
    expect(() => projectSessionTreeRows([{ sessionId: 'missing', depth: 0 }], new Map()))
      .toThrow('Session branch summary missing for missing');
  });

  it('limits project rows to three levels while preserving a gateway to deeper sessions', () => {
    const items = [
      { id: 'root' },
      { id: 'child', parentSessionId: 'root' },
      { id: 'third', parentSessionId: 'child' },
      { id: 'fourth', parentSessionId: 'third' },
      { id: 'fifth', parentSessionId: 'fourth' },
      { id: 'sibling', parentSessionId: 'root' },
    ];
    const roots = buildSessionTree(items);
    const flat = flattenSessionTree(roots, new Set(items.map((item) => item.id)))
      .map(({ item, ...row }) => ({ ...row, sessionId: item.id }));
    const projected = projectSessionTreeRows(flat, summarizeSessionBranches(roots));
    expect(projected.map((row) => [row.sessionId, row.depth])).toEqual([
      ['root', 0], ['child', 1], ['third', 2], ['sibling', 1],
    ]);
    const third = projected.find((row) => row.sessionId === 'third')!;
    expect(sessionBranchGatewayDepth(third, true)).toBe(2);
    expect(sessionBranchGatewayDepth(third, false)).toBe(0);
    expect(third.tree.continuingGuides).toEqual([0]);
    expect(projected.at(-1)?.tree.lastChild).toBe(true);
    expect(flat.map((row) => row.sessionId)).toContain('fifth');
  });
});
