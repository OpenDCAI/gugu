import { describe, expect, it } from 'vitest';
import { accountProcessTrees, type ResourceProcessRoot } from './process-accounting';
import { resourceTotals } from '@shared/resource-monitor';

const roots: ResourceProcessRoot[] = [
  { id: 'app', pid: 1, kind: 'electron', label: 'Main' },
  { id: 'renderer', pid: 2, kind: 'electron', label: 'Renderer' },
  { id: 'worker', pid: 3, kind: 'runtime', label: 'ACP runtime' },
  { id: 'session-a', pid: 4, kind: 'session', label: 'Review', sessionId: 'a' },
  { id: 'session-b', pid: 7, kind: 'session', label: 'Build', sessionId: 'b' },
  { id: 'pty', pid: 9, kind: 'pty', label: 'Shell' },
];
const processes = [
  [1, 0, 'Electron'], [2, 1, 'Renderer'], [3, 1, 'acp-runtime'],
  [4, 3, 'adapter-a'], [5, 4, 'codex'], [6, 5, 'tsgo'],
  [7, 3, 'adapter-b'], [8, 7, 'vite'], [9, 1, 'zsh'], [10, 9, 'node'],
  [11, 0, 'foreign-instance'], [12, 11, 'foreign-codex'],
].map(([pid, ppid, name]) => ({ pid: Number(pid), ppid: Number(ppid), name: String(name) }));
const usage = Object.fromEntries(processes.map(p => [p.pid, { cpu: 1, memory: p.pid * 1024 }]));

describe('owned process accounting', () => {
  it('includes worker, adapters, engines and commands once, attributed to the closest session', () => {
    const result = accountProcessTrees(roots, processes, usage);
    expect(result.groups.map(g => [g.id, g.processes.map(p => p.pid)])).toEqual([
      ['worker', [3]], ['session:a', [4, 5, 6]], ['session:b', [7, 8]],
    ]);
    expect(result.pidsByRoot.get('pty')).toEqual([9, 10]);
    const all = [...result.pidsByRoot.values()].flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(11);
    expect(all).not.toContain(12);
    const snapshot = {
      timestamp: 1, cpuCount: 4, totalMemoryBytes: 1024,
      app: { memoryBytes: 3 * 1024, cpuPercent: 2 }, appProcesses: [],
      entries: [{ ptySessionId: 'pty', projectId: 'p', scopeId: 's', leafId: 'l', pid: 9, cpu: 2, memory: 19 * 1024 }],
      processGroups: result.groups,
    };
    expect(resourceTotals(snapshot)).toEqual({ memoryBytes: 55 * 1024, cpuPercent: 10 });
  });

  it('handles overlapping roots, reparented explicit owners, dead roots and cyclic process metadata', () => {
    const result = accountProcessTrees([
      ...roots, { id: 'reparented', pid: 12, kind: 'session', label: 'Owned engine' },
      { id: 'dead', pid: 99, kind: 'session', label: 'Exited' },
    ], [...processes, { pid: 20, ppid: 21, name: 'cycle' }, { pid: 21, ppid: 20, name: 'cycle' }], usage);
    expect(result.groups.find(g => g.id === 'reparented')?.processes.map(p => p.pid)).toEqual([12]);
    expect(result.pidsByRoot.has('dead')).toBe(false);
    expect([...result.pidsByRoot.values()].flat()).not.toContain(20);
  });

  it('includes otherwise unclassified app children while preserving old recorded samples', () => {
    const result = accountProcessTrees(roots.slice(0, 2), processes, usage);
    expect(result.groups[0].id).toBe('application-services');
    expect(result.groups[0].processes.map(p => p.pid)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(resourceTotals({ timestamp: 1, cpuCount: 1, totalMemoryBytes: 1, app: {}, appProcesses: [], entries: [] })).toEqual({ memoryBytes: undefined, cpuPercent: undefined });
  });
});
