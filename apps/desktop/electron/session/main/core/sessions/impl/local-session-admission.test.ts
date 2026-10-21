import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSessionAdmission } from './local-session-admission';

type SessionEvent = { sourceId: string; providerSessionId: string };
type StatusEvent = { sourceId?: string; reading: { status: string } };

const sessions = vi.hoisted(() => new Set<(event: SessionEvent) => void>());
const statuses = vi.hoisted(() => new Set<(event: StatusEvent) => void>());
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: {
    on: (name: string, listener: (event: never) => void) => {
      if (name !== 'agent:session') throw new Error(`unexpected agentHookService.on(${name})`);
      sessions.add(listener as never);
      return () => { sessions.delete(listener as never); };
    },
  },
}));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: {
    on: (name: string, listener: (event: never) => void) => {
      if (name !== 'agent:status') throw new Error(`unexpected agentStatusWriter.on(${name})`);
      statuses.add(listener as never);
      return () => { statuses.delete(listener as never); };
    },
  },
}));

afterEach(() => { sessions.clear(); statuses.clear(); vi.useRealTimers(); });

function acknowledge(sourceId = 'spawn-2', providerSessionId = 'native-1') {
  for (const listener of sessions) listener({ sourceId, providerSessionId });
}

function report(status: string, sourceId = 'spawn-2') {
  for (const listener of statuses) listener({ sourceId, reading: { status } });
}

/** The on-exit reset to idle: a status the writer published without a source event. */
function reportWithoutSource(status: string) {
  for (const listener of statuses) listener({ reading: { status } });
}

describe('local native session admission', () => {
  it('waits for this spawn’s own native session event and retains an early acknowledgment', async () => {
    const admission = new LocalSessionAdmission('conversation', 'spawn-2');
    const settled = vi.fn();
    const waiting = admission.waitUntilReady().then(settled);
    // The retired spawn of the same conversation is still posting; its acknowledgment must not
    // admit this one, or a reopen publishes `live` for a session that never came back.
    acknowledge('spawn-1');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    acknowledge();
    await waiting;
    await expect(admission.waitUntilReady()).resolves.toBeUndefined();
    expect(sessions.size).toBe(0);
    admission.dispose();
    await expect(admission.waitUntilReady()).rejects.toThrow('exited');
  });

  it('rejects all waiters on exit and cannot be revived by a later event', async () => {
    const admission = new LocalSessionAdmission('conversation', 'spawn-2');
    const first = expect(admission.waitUntilReady()).rejects.toThrow('exited');
    const second = expect(admission.waitUntilReady()).rejects.toThrow('exited');
    admission.dispose();
    acknowledge();
    await Promise.all([first, second]);
    expect(sessions.size).toBe(0);
  });

  it('fails explicitly when native admission never arrives, without calling the live agent idle', async () => {
    vi.useFakeTimers();
    const admission = new LocalSessionAdmission('conversation', 'spawn-2');
    report('working');
    const waiting = expect(admission.waitUntilReady()).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(15_000);
    await waiting;
    expect(sessions.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The process is still running: a timed-out admission that reported idle here would let the gate
    // reopen on top of a live turn.
    expect(statuses.size).toBe(1);
    expect(admission.isTurnInFlight()).toBe(true);
  });

  it('refuses a resume that came back on a different native session', async () => {
    const admission = new LocalSessionAdmission('conversation', 'spawn-2', 'native-expected');
    const waiting = expect(admission.waitUntilReady()).rejects.toThrow('different native session');
    acknowledge('spawn-2', 'native-other');
    await waiting;
    // That spawn is running, just not on the session it was told to resume.
    expect(statuses.size).toBe(1);
  });

  it('admits a resume that came back on the session it was told to resume', async () => {
    const admission = new LocalSessionAdmission('conversation', 'spawn-2', 'native-expected');
    const waiting = admission.waitUntilReady();
    acknowledge('spawn-2', 'native-expected');
    await expect(waiting).resolves.toBeUndefined();
  });

  it('reports turn activity from this spawn only', () => {
    const admission = new LocalSessionAdmission('conversation', 'spawn-2');
    expect(admission.isTurnInFlight()).toBe(false);
    report('working');
    expect(admission.isTurnInFlight()).toBe(true);
    // A retired spawn finishing its last turn must not clear the live spawn's busy state.
    report('idle', 'spawn-1');
    reportWithoutSource('idle');
    expect(admission.isTurnInFlight()).toBe(true);
    report('idle');
    expect(admission.isTurnInFlight()).toBe(false);
  });

  it('does not hold the gate open for an agent that stopped to wait for a person', () => {
    const admission = new LocalSessionAdmission('conversation', 'spawn-2');
    report('working');
    expect(admission.isTurnInFlight()).toBe(true);
    // spec hook-status-derivation: `needs_user` = the agent really stopped and is waiting for a
    // human. Nothing of the provider's is in flight, and it would otherwise defer the credential
    // rotation until someone answers.
    report('needs_user');
    expect(admission.isTurnInFlight()).toBe(false);
  });

  it('stops reporting activity once the spawn is gone', () => {
    const admission = new LocalSessionAdmission('conversation', 'spawn-2');
    report('working');
    expect(admission.isTurnInFlight()).toBe(true);
    admission.dispose();
    expect(statuses.size).toBe(0);
    expect(admission.isTurnInFlight()).toBe(false);
  });
});
