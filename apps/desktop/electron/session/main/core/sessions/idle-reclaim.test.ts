import { describe, expect, it } from 'vitest';
import {
  IDLE_RECLAIM_AFTER_MS,
  IdleReclaimer,
  type SessionFacts,
  type IdleReclaimDeps,
  type LiveSession,
  type ReclaimTarget,
} from './idle-reclaim';

const MINUTE = 60_000;

function harness(opts: {
  live?: LiveSession[];
  facts?: Record<string, SessionFacts | null>;
  onScreen?: string[];
  terminals?: string[];
  watched?: string[];
  stopFails?: boolean;
} = {}) {
  let now = 1_000_000;
  const stopped: ReclaimTarget[] = [];
  const reclaimed: ReclaimTarget[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const state = {
    live: opts.live ?? [],
    facts: opts.facts ?? {},
    onScreen: new Set(opts.onScreen ?? []),
    terminals: new Set(opts.terminals ?? []),
    watched: new Set(opts.watched ?? []),
    stopFails: opts.stopFails ?? false,
  };
  const deps: IdleReclaimDeps = {
    now: () => now,
    listLive: () => state.live,
    facts: (id) => (id in state.facts ? state.facts[id] ?? null : { status: 'idle', resumable: true }),
    onScreen: (id) => state.onScreen.has(id),
    watchedRemotely: (id) => state.watched.has(id),
    sessionsWithLiveTerminals: () => state.terminals,
    stop: async (target) => {
      if (state.stopFails) throw new Error('adapter refused to close');
      stopped.push(target);
      state.live = state.live.filter((entry) => entry.sessionId !== target.sessionId);
    },
    reclaimed: (target) => reclaimed.push(target),
    log: (event, fields) => logs.push({ event, fields }),
  };
  const reclaimer = new IdleReclaimer(deps);
  return {
    reclaimer,
    state,
    stopped,
    reclaimed,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const pty = (id: string): LiveSession => ({
  projectId: 'p', sessionId: id, runtime: 'pty',
});
const acp = (id: string, atRest: boolean): LiveSession => ({
  projectId: 'p', sessionId: id, runtime: 'acp', acpAtRest: atRest,
});

describe('IdleReclaimer', () => {
  it('stops a live idle session once it has been idle for the full window, then tells the renderer', async () => {
    const h = harness({ live: [pty('a')] });
    // 第一次看见:从现在起算,❌ 往前补。
    expect(await h.reclaimer.tick()).toEqual([]);
    h.advance(IDLE_RECLAIM_AFTER_MS - 1);
    expect(await h.reclaimer.tick()).toEqual([]);
    h.advance(1);
    const target = { projectId: 'p', sessionId: 'a' };
    expect(await h.reclaimer.tick()).toEqual([target]);
    expect(h.stopped).toEqual([target]);
    expect(h.reclaimed).toEqual([target]);
    expect(h.logs).toEqual([{ event: 'reclaimed', fields: { ...target, runtime: 'pty', idleMs: IDLE_RECLAIM_AFTER_MS } }]);
  });

  it('restarts the clock on every status publish: a turn in between keeps it running', async () => {
    const h = harness({ live: [pty('a')] });
    await h.reclaimer.tick();
    h.advance(9 * MINUTE);
    h.reclaimer.observeStatus('a', 'working');
    h.state.facts.a = { status: 'working', resumable: true };
    h.advance(MINUTE);
    expect(await h.reclaimer.tick()).toEqual([]);
    h.reclaimer.observeStatus('a', 'idle');
    h.state.facts.a = { status: 'idle', resumable: true };
    h.advance(IDLE_RECLAIM_AFTER_MS - 1);
    expect(await h.reclaimer.tick()).toEqual([]);
    h.advance(1);
    expect(await h.reclaimer.tick()).toHaveLength(1);
  });

  it.each([
    ['not idle', { facts: { a: { status: 'needs_user', resumable: true } } }],
    ['no status source', { facts: { a: { status: null, resumable: true } } }],
    ['row gone', { facts: { a: null } }],
    ['cannot come back as the same conversation', { facts: { a: { status: 'idle', resumable: false } } }],
    ['it is on screen', { onScreen: ['a'] }],
    ['it has a live terminal shell', { terminals: ['a'] }],
    ['a remote desktop is watching it', { watched: ['a'] }],
  ] as const)('keeps a session running when %s', async (_why, opts) => {
    const h = harness({ live: [pty('a')], ...opts } as Parameters<typeof harness>[0]);
    await h.reclaimer.tick();
    h.advance(2 * IDLE_RECLAIM_AFTER_MS);
    expect(await h.reclaimer.tick()).toEqual([]);
    expect(h.stopped).toEqual([]);
    expect(h.reclaimed).toEqual([]);
  });

  it('only stops an ACP session whose runtime summary is at rest', async () => {
    const h = harness({ live: [acp('busy', false), acp('rest', true)] });
    await h.reclaimer.tick();
    h.advance(IDLE_RECLAIM_AFTER_MS);
    expect((await h.reclaimer.tick()).map((t) => t.sessionId)).toEqual(['rest']);
  });

  it('drops the clock of a session whose process went away; it starts over when it comes back', async () => {
    const h = harness({ live: [pty('a')] });
    await h.reclaimer.tick();
    h.advance(9 * MINUTE);
    h.state.live = [];
    await h.reclaimer.tick();
    h.state.live = [pty('a')];
    h.advance(2 * MINUTE);
    expect(await h.reclaimer.tick()).toEqual([]);
    h.advance(IDLE_RECLAIM_AFTER_MS);
    expect(await h.reclaimer.tick()).toHaveLength(1);
  });

  it('a failed stop is logged and retried on the next sweep, never reported as reclaimed', async () => {
    const h = harness({ live: [pty('a')], stopFails: true });
    await h.reclaimer.tick();
    h.advance(IDLE_RECLAIM_AFTER_MS);
    expect(await h.reclaimer.tick()).toEqual([]);
    expect(h.reclaimed).toEqual([]);
    expect(h.logs.map((l) => l.event)).toEqual(['failed']);
    h.state.stopFails = false;
    h.advance(MINUTE);
    expect(await h.reclaimer.tick()).toHaveLength(1);
  });

  it('runs one sweep at a time', async () => {
    const h = harness({ live: [pty('a')] });
    await h.reclaimer.tick();
    h.advance(IDLE_RECLAIM_AFTER_MS);
    const [first, second] = await Promise.all([h.reclaimer.tick(), h.reclaimer.tick()]);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(h.stopped).toHaveLength(1);
  });
});
