import type { ResourceProcessGroup } from '@shared/resource-monitor';

export type ResourceProcessRoot = {
  id: string; pid: number; kind: 'electron' | 'runtime' | 'session' | 'pty'; label: string;
  sessionId?: string; projectId?: string;
};
export type ResourceProcess = { pid: number; ppid: number; name: string; command?: string };
export type ProcessUsage = { cpu?: number; memory: number; ppid?: number };

/** Assign each PID to its closest explicit owner. Ancestor roots never add it a second time. */
export function accountProcessTrees(
  roots: ResourceProcessRoot[], processes: ResourceProcess[], usage: Record<string, ProcessUsage>,
): { groups: ResourceProcessGroup[]; pidsByRoot: Map<string, number[]> } {
  const all = new Map(processes.map(p => [p.pid, p]));
  const rank = { electron: 0, runtime: 1, session: 2, pty: 3 };
  const owners = new Map<number, ResourceProcessRoot>();
  for (const root of roots) if (!owners.has(root.pid) || rank[root.kind] > rank[owners.get(root.pid)!.kind]) owners.set(root.pid, root);
  const groups = new Map<string, ResourceProcessGroup>();
  const pidsByRoot = new Map<string, number[]>();
  for (const process of processes) {
    let pid: number | undefined = process.pid;
    let owner: ResourceProcessRoot | undefined;
    const visited = new Set<number>();
    while (pid && !visited.has(pid)) {
      visited.add(pid); owner = owners.get(pid);
      if (owner) break;
      pid = all.get(pid)?.ppid;
    }
    if (!owner) continue;
    const pids = pidsByRoot.get(owner.id) ?? [];
    pids.push(process.pid); pidsByRoot.set(owner.id, pids);
    if (owner.kind === 'electron' && owner.pid === process.pid) continue;
    if (owner.kind === 'pty') continue;
    const key = owner.kind === 'electron' ? 'application-services'
      : owner.kind === 'session' && owner.sessionId ? `session:${owner.sessionId}` : owner.id;
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key, kind: owner.kind === 'electron' ? 'runtime' : owner.kind,
        label: owner.kind === 'electron' ? 'Application services' : owner.label,
        sessionId: owner.sessionId, projectId: owner.projectId, processes: [], memory: 0,
      };
      groups.set(key, group);
    }
    const item = usage[String(process.pid)];
    if (!item) continue;
    group.processes.push({ pid: process.pid, ppid: process.ppid, name: process.name, memory: item.memory, cpu: item.cpu });
    group.memory += item.memory;
    if (item.cpu !== undefined) group.cpu = (group.cpu ?? 0) + item.cpu;
  }
  return { groups: [...groups.values()].filter(g => g.processes.length > 0), pidsByRoot };
}
