import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionSummary, SessionpageSessionsEvent } from '@gugu/session-core/session-record/contract';

const host = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown) => void>(),
  subscribe: vi.fn<(input: { subscriptionId: string }) => Promise<unknown>>(),
  unsubscribe: vi.fn(),
  list: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', async () => {
  const { createEventEmitter } = await import('@shared/lib/ipc/events');
  return {
    events: createEventEmitter({
      on(channel, cb) {
        host.listeners.set(channel, cb);
        return () => { host.listeners.delete(channel); };
      },
      emit: () => { throw new Error('list consumer must not emit host events'); },
    }),
    rpcOn: () => ({ sessionTimeline: {
      sessionsSubscribe: host.subscribe, sessionsUnsubscribe: host.unsubscribe, sessionsList: host.list,
    } }),
  };
});
vi.mock('@renderer/utils/logger', () => ({ log: { warn: host.warn } }));
// The remote device connection manager has real connection side effects; local subscription tests stay on the IPC boundary.
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: {} }));

let store: typeof import('./assistant-home-sessions')['localHomeSessions'];
const releases = new Set<() => void>();
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const task = (id: string, agentStatus = 'working'): SessionpageSessionSummary => ({
  conversationId: id, projectId: 'project', title: id, harness: 'claude', runtime: 'acp',
  agentStatus, lastInteractedAt: null, supported: true,
});
function push(event: SessionpageSessionsEvent) {
  const receive = host.listeners.get(`session-list:push.${event.subscriptionId}`);
  if (!receive) throw new Error(`missing real IPC event listener for ${event.subscriptionId}`);
  receive(event);
}
async function use() {
  const stop = store.use();
  releases.add(stop);
  await settle();
  return () => { if (releases.delete(stop)) stop(); };
}
const subscriptionId = () => host.subscribe.mock.calls.at(-1)![0].subscriptionId;

beforeEach(async () => {
  vi.resetModules();
  host.listeners.clear();
  host.warn.mockReset();
  host.list.mockReset().mockResolvedValue({ projects: [], sessions: [] });
  host.unsubscribe.mockReset().mockResolvedValue(undefined);
  host.subscribe.mockReset().mockImplementation(async ({ subscriptionId }) => {
    // The first full list arrives before the subscribe RPC resolves, just as on the real host.
    push({ subscriptionId, full: { projects: [], sessions: [task('existing')] } });
    return { ok: true, value: { subscriptionId } };
  });
  store = (await import('./assistant-home-sessions')).localHomeSessions;
});
afterEach(async () => {
  for (const release of releases) release();
  releases.clear();
  await settle();
  vi.useRealTimers();
});

describe('local assistant task-list subscription', () => {
  it('receives the first full list before subscribe resolves', async () => {
    let resolve!: (value: unknown) => void;
    host.subscribe.mockImplementationOnce(({ subscriptionId }) => {
      push({ subscriptionId, full: { projects: [], sessions: [task('existing')] } });
      return new Promise(done => { resolve = done; });
    });
    expect(store.loaded).toBe(false);
    await use();
    expect(store.loaded).toBe(true);
    expect(store.sessions.map(s => s.conversationId)).toEqual(['existing']);
    expect(store.error).toBeNull();
    resolve({ ok: true, value: { subscriptionId: subscriptionId() } });
    await settle();
    expect(host.subscribe).toHaveBeenCalledTimes(1);
  });

  it('shows a task created outside the consumer, its running-to-done change, and removal', async () => {
    await use();
    const id = subscriptionId();
    push({ subscriptionId: id, changed: [task('external')], removed: [] });
    expect(store.sessions.map(s => s.conversationId)).toEqual(['existing', 'external']);
    expect(store.sessions[1].agentStatus).toBe('working');
    push({ subscriptionId: id, changed: [task('external', 'idle')], removed: [] });
    expect(store.sessions[1].agentStatus).toBe('idle');
    push({ subscriptionId: id, changed: [], removed: ['external'] });
    expect(store.sessions.map(s => s.conversationId)).toEqual(['existing']);
  });

  it('shares one subscription and releases it only after the last consumer leaves', async () => {
    const leaveAssistant = await use();
    const leavePicker = await use();
    await settle();
    expect(host.subscribe).toHaveBeenCalledTimes(1);
    leaveAssistant();
    await settle();
    expect(host.unsubscribe).not.toHaveBeenCalled();
    push({ subscriptionId: subscriptionId(), changed: [task('picker-task')], removed: [] });
    expect(store.sessions.map(s => s.conversationId)).toContain('picker-task');
    leavePicker();
    await settle();
    expect(host.unsubscribe).toHaveBeenCalledExactlyOnceWith({ subscriptionId: subscriptionId() });
    expect(host.listeners.size).toBe(0);
  });

  it('does not periodically reread an unchanged list', async () => {
    vi.useFakeTimers();
    await use();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.subscribe).toHaveBeenCalledTimes(1);
    expect(host.list).not.toHaveBeenCalled();
    expect(store.sessions.map(s => s.conversationId)).toEqual(['existing']);
  });

  it('unsubscribes a setup completed after release and ignores its stale full list', async () => {
    let resolve!: (value: unknown) => void;
    host.subscribe.mockImplementation(() => new Promise(done => { resolve = done; }));
    const leave = await use();
    const id = subscriptionId();
    const late = host.listeners.get(`session-list:push.${id}`)!;
    leave();
    expect(host.listeners.size).toBe(0);
    expect(host.unsubscribe).not.toHaveBeenCalled();
    late({ subscriptionId: id, full: { projects: [], sessions: [task('late')] } });
    expect(store.loaded).toBe(false);
    expect(store.sessions).toEqual([]);
    resolve({ ok: true, value: { subscriptionId: id } });
    await settle();
    expect(host.unsubscribe).toHaveBeenCalledExactlyOnceWith({ subscriptionId: id });
  });

  it('does not apply an old subscription error to a reopened consumer', async () => {
    let reject!: (error: Error) => void;
    host.subscribe.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const leave = await use();
    const oldId = subscriptionId();
    leave();
    await use();
    expect(subscriptionId()).not.toBe(oldId);
    reject(new Error('old connection failed'));
    await settle();
    expect(store.error).toBeNull();
    expect(store.sessions.map(s => s.conversationId)).toEqual(['existing']);
    expect(host.unsubscribe).toHaveBeenCalledWith({ subscriptionId: oldId });
  });

  it.each(['reply', 'transport', 'synchronous bridge'])('keeps an initial %s failure visible and can reopen', async (kind) => {
    if (kind === 'reply') host.subscribe.mockResolvedValueOnce({ ok: false, error: { code: 'sessions_list_failed', message: 'list unreadable' } });
    else if (kind === 'transport') host.subscribe.mockRejectedValueOnce(new Error('list unreadable'));
    else host.subscribe.mockImplementationOnce(() => { throw new Error('list unreadable'); });
    const leave = await use();
    await settle();
    expect(store.loaded).toBe(false);
    expect(store.error).toBe('list unreadable');
    expect(host.warn).toHaveBeenCalled();
    leave();
    await use();
    await settle();
    expect(store.loaded).toBe(true);
    expect(store.error).toBeNull();
  });

  it('reports a delta before the first full list rather than accepting an incomplete list', async () => {
    host.subscribe.mockImplementation(async ({ subscriptionId }) => {
      push({ subscriptionId, changed: [task('orphan')], removed: [] });
      return { ok: true, value: { subscriptionId } };
    });
    await use();
    await settle();
    expect(store.loaded).toBe(false);
    expect(store.sessions).toEqual([]);
    expect(store.error).toContain('before the full list');
    expect(host.warn).toHaveBeenCalled();
  });
});
