import type { ResourceProcessRoot } from '../../resource-monitor/process-accounting';
import { peekAcpResourceHandle } from './host';
import { resourceSessionLabels } from './resource-session-labels';

/** Observe an existing worker; opening the monitor must never start an agent runtime. */
export async function collectAcpResourceRoots(): Promise<ResourceProcessRoot[]> {
  const handle = await peekAcpResourceHandle();
  if (!handle) return [];
  const roots: ResourceProcessRoot[] = [];
  if (handle.pid) roots.push({ id: 'acp-runtime', kind: 'runtime', label: 'ACP runtime', pid: handle.pid });
  const { data } = await handle.client.sessions.state(undefined, 'list').snapshot();
  const labels = await resourceSessionLabels(Object.keys(data));
  const label = (session: typeof data[string]) => labels.get(session.sessionId) || session.title || `${session.providerId} · ${session.sessionId.slice(0, 8)}`;
  const adapters = await Promise.all(Object.values(data).map(async session => {
    const process = await handle.client.adapterProvenance({ sessionId: session.sessionId });
    return process?.pid ? { session, pid: process.pid } : null;
  }));
  const byPid = new Map<number, NonNullable<typeof adapters[number]>[]>();
  for (const adapter of adapters) if (adapter) {
    const owners = byPid.get(adapter.pid) ?? [];
    owners.push(adapter); byPid.set(adapter.pid, owners);
  }
  for (const [pid, owners] of byPid) {
    const session = owners[0].session;
    roots.push({
      id: `acp-adapter:${pid}`, pid,
      kind: owners.length === 1 ? 'session' : 'runtime',
      label: owners.length === 1 ? label(session) : `Shared adapter · ${owners.map(owner => label(owner.session)).join(', ')}`,
      ...(owners.length === 1 ? { sessionId: session.sessionId, projectId: session.projectId } : {}),
    });
  }
  return roots;
}
