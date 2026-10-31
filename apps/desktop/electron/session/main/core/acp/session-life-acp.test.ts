import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExitFact, Gen, ProcessLease, StageOut } from '@gugu/core/local/session-life/types';

type Summary = { lifecycle: string; failure?: { kind: string; message: string; exitCode?: number | null; signal?: string | null } | null };
const h = vi.hoisted(() => ({
  watchers: new Map<string, (summary: Summary | undefined) => void>(),
  gone: null as ((cause: string) => void) | null,
  client: { tag: 'worker-client' },
  stopAndSettle: vi.fn(async (_client: unknown, _id: string) => undefined),
  inject: vi.fn(),
  release: vi.fn(async (_id: string) => undefined),
  identity: null as unknown,
  parentAgent: null as { gugu_user_id?: string } | null,
  summaries: {} as Record<string, { lifecycle: string }>,
}));
vi.mock('./session-summary-reader', () => ({ readAcpSessionSummaries: async () => h.summaries }));

vi.mock('./agent-status-bridge', () => ({
  acpAgentStatusBridge: { watch: (id: string, cb: (summary: Summary | undefined) => void) => { h.watchers.set(id, cb); return () => h.watchers.delete(id); } },
}));
vi.mock('./runtime-process/host', () => ({
  acpWorkerLease: async () => ({ client: h.client, onGone: (cb: (cause: string) => void) => { h.gone = cb; return () => { h.gone = null; }; } }),
  stopAcpSessionAndSettle: h.stopAndSettle,
  readSessionInjectionFacts: async () => ({ agentDisplayName: undefined }),
  provisionStartIdentity: async () => h.identity,
}));
vi.mock('./inject-prompt', () => ({ injectEmdashPromptDetached: h.inject }));
vi.mock('./emdash-platform-injector', () => ({ releaseEmdashPlatformSession: h.release }));
vi.mock('@main/core/sessions/runtime-fork-ownership', () => ({ recordRuntimeForkOwnership: vi.fn() }));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ localAgentForSession: async () => h.parentAgent }));
vi.mock('@main/core/projects/utils', () => ({ resolveWorkspace: () => ({ path: '/repo' }) }));
vi.mock('@main/core/sessions/getSessions', () => ({ getSessions: async () => [{ id: 's', runtime: 'acp', providerId: 'claude', projectId: 'p', workspaceId: 'w', providerSessionId: null }] }));
vi.mock('@main/core/sessions/session-service', () => ({ sessionService: {} }));
vi.mock('./runtime-process/resume-history', () => ({ resumeHistoryFacts: vi.fn() }));
vi.mock('./runtime-process/session-persistence-policy', () => ({ persistAcpStartResult: vi.fn() }));

import { acpWorkerLease } from './runtime-process/host';
import { createAcpLegAdapter } from './session-life-acp';

const gen = { auth: 1, attempt: 1 } as unknown as Gen;
const ctx = () => ({ gen, signal: new AbortController().signal });
const row = { seq: 1, sessionId: 's', kind: 'ordinary', state: 'dispatching', message: { id: 'm', text: 'hi' }, sources: [], turn: { kind: 'prompt' } } as never;
const processLease = async () => (await acpWorkerLease()) as unknown as ProcessLease;
/** An attempt past its identity stage: dispatch reads the session's harness from it. */
async function boundAdapter() {
  h.identity = { guguAgentUserId: 'agent-1', chatId: 'dm' };
  const adapter = createAcpLegAdapter('s', null);
  await adapter.run('identity', {}, ctx());
  return adapter;
}

describe('session-life ACP leg', () => {
  beforeEach(() => { h.watchers.clear(); h.gone = null; h.identity = null; h.parentAgent = null; h.summaries = {}; vi.clearAllMocks(); });

  it('one exit per attempt, from whichever fact ends the session first', async () => {
    const process = await processLease();
    for (const end of [
      () => h.watchers.get('s')!({ lifecycle: 'lost' }),
      () => h.watchers.get('s')!({ lifecycle: 'closed' }),
      () => h.watchers.get('s')!(undefined),
      () => h.gone!('ACP runtime restarted'),
    ]) {
      const exits: ExitFact[] = [];
      const off = createAcpLegAdapter('s', null).onExit({ process }, exit => exits.push(exit));
      h.watchers.get('s')!({ lifecycle: 'starting' });
      end();
      h.gone?.('ACP runtime exited');
      h.watchers.get('s')?.({ lifecycle: 'lost' });
      expect(exits).toHaveLength(1);
      off();
      expect(h.watchers.has('s')).toBe(false);
    }
  });

  it("a stale lost/closed or an absence before this attempt saw the session alive is not this attempt's exit", async () => {
    const exits: ExitFact[] = [];
    createAcpLegAdapter('s', null).onExit({ process: await processLease() }, exit => exits.push(exit));
    h.watchers.get('s')!({ lifecycle: 'lost' });
    h.watchers.get('s')!(undefined);
    h.watchers.get('s')!({ lifecycle: 'closed' });
    expect(exits).toEqual([]);
  });

  it("the exit carries the runtime's own failure, so the cause survives a race with the channel failure", async () => {
    const exits: ExitFact[] = [];
    createAcpLegAdapter('s', null).onExit({ process: await processLease() }, exit => exits.push(exit));
    h.watchers.get('s')!({ lifecycle: 'starting' });
    h.watchers.get('s')!({ lifecycle: 'lost', failure: { kind: 'adapter-exit', message: 'claude exited: login required', exitCode: 1, signal: null } });
    expect(exits).toEqual([{ cause: { name: 'adapter-exit', message: 'claude exited: login required' }, code: 1, signal: null }]);
  });

  it('maps the worker admission: started/queued is accepted with its turn, declined is rejected, missing is a lost channel', async () => {
    const adapter = await boundAdapter();
    h.inject.mockResolvedValueOnce({ outcome: 'queued', completion: Promise.resolve(), turnId: 't1' });
    expect(await adapter.dispatch({} as StageOut, row, ctx())).toEqual({ result: 'accepted', nativeReceiptId: 't1' });
    h.inject.mockResolvedValueOnce({ outcome: 'declined', completion: Promise.resolve() });
    expect(await adapter.dispatch({} as StageOut, row, ctx())).toMatchObject({ result: 'rejected-before-admission' });
    // #552: the runtime no longer has the session (its executor ended before admission): no byte taken, channel lost.
    h.inject.mockResolvedValueOnce({ outcome: 'missing', completion: Promise.resolve() });
    expect(await adapter.dispatch({} as StageOut, row, ctx())).toMatchObject({ result: 'channel-lost' });
  });

  it("a row's turn decides how it is sent: prompt as-is with its own origin; the first turn rendered from the landed context", async () => {
    const adapter = await boundAdapter();
    h.inject.mockResolvedValue({ outcome: 'started', completion: Promise.resolve(), turnId: 't' });
    const prompt = { ...(row as object), message: { id: 'm', text: 'hi', delivery: { queue: true } }, turn: { kind: 'prompt', origin: 'communication', hiddenContext: 'ctx' } } as never;
    await adapter.dispatch({} as StageOut, prompt, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', { origin: 'communication', hiddenContext: 'ctx' });
    const first = { ...(row as object), turn: { kind: 'chat-page-first-turn' } } as never;
    await adapter.dispatch({ capabilities: { injection: { firstTurn: { kind: 'plain' } } } } as never, first, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', { origin: 'manual' });
    await expect(adapter.dispatch({ capabilities: { injection: {} } } as never, first, ctx())).rejects.toThrow(/did not land/);
  });

  it('#552: a refusal from an executor that ended before admission is a lost channel; a live session\'s refusal is thrown', async () => {
    const adapter = await boundAdapter();
    h.inject.mockRejectedValueOnce(new Error('Session not found'));
    h.summaries = { s: { lifecycle: 'lost' } };
    expect(await adapter.dispatch({} as StageOut, row, ctx())).toMatchObject({ result: 'channel-lost', cause: { message: 'Session not found' } });
    h.inject.mockRejectedValueOnce(new Error('worker RPC failed'));
    h.summaries = { s: { lifecycle: 'ready' } };
    await expect(adapter.dispatch({} as StageOut, row, ctx())).rejects.toThrow('worker RPC failed');
  });

  it('#552: an exit seen while that dispatch is out is subsumed by the lost channel; otherwise it is reported', async () => {
    const adapter = await boundAdapter();
    const process = await processLease();
    const exits: ExitFact[] = [];
    adapter.onExit({ process }, exit => exits.push(exit));
    let refuse!: (error: Error) => void;
    h.inject.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const lostDispatch = adapter.dispatch({} as StageOut, row, ctx());
    h.watchers.get('s')!({ lifecycle: 'ready' });
    h.watchers.get('s')!({ lifecycle: 'lost' });
    h.summaries = { s: { lifecycle: 'lost' } };
    refuse(new Error('Session not found'));
    expect(await lostDispatch).toMatchObject({ result: 'channel-lost' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(exits).toEqual([]);
  });

  it('a delivery into a next-tool-call harness steers its running turn unless the sender queued it (#4708)', async () => {
    const adapter = await boundAdapter();
    h.inject.mockResolvedValue({ outcome: 'started', completion: Promise.resolve(), turnId: 't' });
    await adapter.dispatch({} as StageOut, row, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', { steerIfBusy: true });
    await adapter.dispatch({} as StageOut, { ...(row as object), message: { id: 'm', text: 'hi', delivery: { queue: true } } } as never, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', {});
  });

  it('teardown uses the one ACP stop; without a process it only settles the ticket; a failed stop fails loudly', async () => {
    const process = await processLease();
    await createAcpLegAdapter('s', null).teardown({ process, platform: {} as never }, { gen });
    expect(h.stopAndSettle).toHaveBeenCalledWith(h.client, 's');
    expect(h.release).not.toHaveBeenCalled();
    await createAcpLegAdapter('s', null).teardown({ platform: {} as never }, { gen });
    expect(h.release).toHaveBeenCalledWith('s');
    h.stopAndSettle.mockRejectedValueOnce(new Error('ACP session s did not stop: busy'));
    await expect(createAcpLegAdapter('s', null).teardown({ process }, { gen })).rejects.toThrow(/did not stop/);
  });

  it('identity: a persisted session without a provisionable identity fails the identity stage', async () => {
    await expect(createAcpLegAdapter('s', null).run('identity', {}, ctx())).rejects.toThrow(/has no gugu identity/);
    h.identity = { guguAgentUserId: 'agent-1', chatId: 'dm' };
    await expect(createAcpLegAdapter('s', null).run('identity', {}, ctx())).resolves.toEqual({ kind: 'bound', agentUserId: 'agent-1' });
  });

  it('identity: a side chat is its session\'s binding, read only; an unbound session fails the fork\'s identity stage', async () => {
    const fork = { forkId: 'view-1', parentId: 's', forkFromProviderSessionId: 'native-s' };
    await expect(createAcpLegAdapter('view-1', fork).run('identity', {}, ctx())).rejects.toThrow(/session s has no gugu identity/);
    h.parentAgent = { gugu_user_id: 'agent-1' };
    await expect(createAcpLegAdapter('view-1', fork).run('identity', {}, ctx())).resolves.toEqual({ kind: 'bound', agentUserId: 'agent-1' });
  });
});
