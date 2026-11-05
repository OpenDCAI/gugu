import { autorun } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { setLocalAgentStatus } from '@/lib/agentPresenceStore';
import { SidebarStore } from './sidebar-store';

vi.mock('@renderer/lib/ipc', () => {
  const ipc = { events: { on: vi.fn() }, rpc: {} };
  return { ...ipc, onMachineEvent: (_machine: unknown, event: never, cb: never) => (ipc.events.on as (...args: unknown[]) => () => void)(event, cb) };
});
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));
vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({ AcpChatStore: class { sessionId = ''; dispose() {} bootstrap() {} } }));
vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({ AcpChatPanel: () => null }));
vi.mock('@/lib/supabase', () => ({ dataClient: { schema: () => ({ rpc: () => new Promise(() => {}) }) } }));
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => null }));

// One agent's status push used to rebuild every remote row of the sidebar (and deep-copy the machine's whole
// session list to do it) — per push O(n), O(n²) as agents multiply. A push must touch only the rows of that agent.
describe('a presence push re-derives only the rows of the agent it is about', () => {
  it('rebuilds the pushed agent\'s row and hands every other remote row back as the same object', () => {
    const projectId = 'remote-project';
    const sessions = Array.from({ length: 40 }, (_, i) => ({
      conversationId: `s-${i}`, projectId, title: `s-${i}`, runtime: 'acp', harness: 'codex', supported: true, unseen: false,
      lastInteractedAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`, agent: { userId: `agent-${i}` },
      agentStatus: 'idle', status: { status: 'idle', detail: null },
    }) as unknown as SessionpageSessionSummary);
    const store = new SidebarStore({
      projects: new Map([[projectId, { id: projectId, name: 'Remote', createdAt: '2026-01-01T00:00:00.000Z' }]]),
    } as unknown as ConstructorParameters<typeof SidebarStore>[0]);
    store.machines = {
      machineOf: () => 'machine', label: () => 'machine', homeDir: () => '/work', connected: () => true,
      sessionsOf: () => ({ live: true, sessions }),
      session: (_deviceId, id) => sessions.find((session) => session.conversationId === id) ?? null,
    };
    let shown: readonly { id: string }[] = [];
    const stop = autorun(() => { shown = store.placement.entries.get(projectId) ?? []; });
    try {
      expect(shown).toHaveLength(40);
      const before = new Map(shown.map((entry) => [entry.id, entry]));

      setLocalAgentStatus('agent-7', {
        sessionId: 's-7', reading: { status: 'working', detail: 'running', running: true, background: null },
        unseen: false, reviewGate: null, providerBlocker: null, statusSourceFault: null, life: null,
      });

      const after = new Map(shown.map((entry) => [entry.id, entry]));
      expect(after.get('s-7')).not.toBe(before.get('s-7'));
      const rebuilt = [...after].filter(([id, entry]) => id !== 's-7' && entry !== before.get(id)).map(([id]) => id);
      expect(rebuilt, 'rows of agents the push is not about').toEqual([]);
    } finally {
      stop();
      setLocalAgentStatus('agent-7', null);
    }
  });

  it('keeps a derived row only while someone shows it: rows leave with their sessions and with the last viewer', () => {
    const projectId = 'remote-project';
    let sessions = Array.from({ length: 5 }, (_, i) => ({
      conversationId: `s-${i}`, projectId, title: `s-${i}`, runtime: 'acp', harness: 'codex', supported: true, unseen: false,
      lastInteractedAt: null, agent: { userId: `agent-${i}` }, agentStatus: 'idle', status: { status: 'idle', detail: null },
    }) as unknown as SessionpageSessionSummary);
    const store = new SidebarStore({
      projects: new Map([[projectId, { id: projectId, name: 'Remote', createdAt: '2026-01-01T00:00:00.000Z' }]]),
    } as unknown as ConstructorParameters<typeof SidebarStore>[0]);
    const machinesFor = (listed: readonly SessionpageSessionSummary[]) => ({
      machineOf: () => 'machine', label: () => 'machine', homeDir: () => '/work', connected: () => true,
      sessionsOf: () => ({ live: true, sessions: listed }),
      session: (_deviceId: string, id: string) => listed.find((session) => session.conversationId === id) ?? null,
    });
    store.machines = machinesFor(sessions);
    const derived = (store as unknown as { remoteEntryById: Map<string, unknown> }).remoteEntryById;
    // An imperative read derives the rows but keeps none of them.
    expect(store.placement.entries.get(projectId)).toHaveLength(5);
    expect(derived.size).toBe(0);

    let shown: readonly { id: string }[] = [];
    const stop = autorun(() => { shown = store.placement.entries.get(projectId) ?? []; });
    expect(derived.size).toBe(5);
    // Two sessions leave the directory: their rows leave the table.
    sessions = sessions.slice(2);
    store.machines = machinesFor(sessions);
    expect(shown).toHaveLength(3);
    expect(derived.size).toBe(3);
    // Nobody shows the sidebar any more: nothing is kept.
    stop();
    expect(derived.size).toBe(0);
  });
});
