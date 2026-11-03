import { describe, expect, it, vi } from 'vitest';
const peek = vi.fn();
vi.mock('./host', () => ({ peekAcpResourceHandle: () => peek() }));
vi.mock('./resource-session-labels', () => ({ resourceSessionLabels: async () => new Map([['a', 'Persisted task title']]) }));
import { collectAcpResourceRoots } from './resource-roots';

describe('ACP resource roots', () => {
  it('does not initialize a worker for observation', async () => {
    peek.mockResolvedValue(null);
    expect(await collectAcpResourceRoots()).toEqual([]);
  });
  it('attributes adapters to sessions and keeps a shared adapter in its own row', async () => {
    const sessions = {
      a: { sessionId: 'a', projectId: 'p', providerId: 'codex', title: 'Review' },
      b: { sessionId: 'b', projectId: 'p', providerId: 'codex', title: 'Shared A' },
      c: { sessionId: 'c', projectId: 'p', providerId: 'codex', title: 'Shared B' },
    };
    peek.mockResolvedValue({ pid: 10, client: {
      sessions: { state: () => ({ snapshot: async () => ({ data: sessions }) }) },
      adapterProvenance: async ({ sessionId }: { sessionId: string }) => ({ pid: sessionId === 'a' ? 11 : 12 }),
    } });
    const roots = await collectAcpResourceRoots();
    expect(roots.map(r => [r.pid, r.kind, r.sessionId])).toEqual([[10, 'runtime', undefined], [11, 'session', 'a'], [12, 'runtime', undefined]]);
    expect(roots[1].label).toBe('Persisted task title');
  });
});
