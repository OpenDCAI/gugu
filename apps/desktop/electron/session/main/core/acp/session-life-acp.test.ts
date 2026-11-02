import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExitFact, Gen, ProcessLease, StageOut } from '@gugu/core/local/session-life/types';

type Summary = { lifecycle: string; failure?: { kind: string; message: string; exitCode?: number | null; signal?: string | null } | null };
const h = vi.hoisted(() => ({
  watchers: new Map<string, (summary: Summary | undefined) => void>(),
  gone: null as ((cause: string) => void) | null,
  client: { tag: 'worker-client' },
  stopAndSettle: vi.fn(async (_client: unknown, _id: string) => undefined),
  inject: vi.fn(),
  turnFiles: vi.fn(),
  release: vi.fn(async (_id: string) => undefined),
  identity: null as unknown,
  parentAgent: null as { gugu_user_id?: string } | null,
  /** The in-memory registry: empty until something mounts the session (e.g. right after a restart). */
  registered: true,
  identityCwd: null as string | null,
  startSession: vi.fn(),
  /** The session's queue as the channel stage reads it when it is admitted. */
  pending: { queued: [] as number[], dispatching: [] as number[] },
}));

vi.mock('./agent-status-bridge', () => ({
  acpAgentStatusBridge: { watch: (id: string, cb: (summary: Summary | undefined) => void) => { h.watchers.set(id, cb); return () => h.watchers.delete(id); } },
}));
vi.mock('./runtime-process/host', () => ({
  callSessionStart: (start: () => Promise<unknown>) => start(),
  persistProviderSessionMissing: vi.fn(),
  persistReturnedProviderSessionId: vi.fn(),
  persistSessionMcpServers: vi.fn(async () => undefined),
  acpWorkerLease: async () => ({ client: h.client, onGone: (cb: (cause: string) => void) => { h.gone = cb; return () => { h.gone = null; }; } }),
  stopAcpSessionAndSettle: h.stopAndSettle,
  readSessionInjectionFacts: async () => ({ agentDisplayName: undefined }),
  provisionStartIdentity: async (input: { cwd: string }) => { h.identityCwd = input.cwd; return h.identity; },
}));
vi.mock('../session-timeline/turn-files', () => ({ turnFileText: h.turnFiles }));
vi.mock('./inject-prompt', () => ({ injectEmdashPromptDetached: h.inject }));
vi.mock('./emdash-platform-injector', () => ({ releaseEmdashPlatformSession: h.release }));
vi.mock('@main/core/sessions/runtime-fork-ownership', () => ({ recordRuntimeForkOwnership: vi.fn() }));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ localAgentForSession: async () => h.parentAgent }));
vi.mock('@main/core/projects/utils', () => ({ resolveWorkspace: () => (h.registered ? { path: '/repo' } : null), persistedWorkspacePath: () => '/repo' }));
vi.mock('@main/core/sessions/getSessions', () => ({ getSessions: async () => [{ id: 's', runtime: 'acp', providerId: 'claude', projectId: 'p', workspaceId: 'w', providerSessionId: null }] }));
vi.mock('@main/core/sessions/session-service', () => ({ sessionService: {} }));
vi.mock('./runtime-process/resume-history', () => ({ resumeHistoryFacts: vi.fn() }));
vi.mock('../sessions/session-pending', () => ({ lifeStore: { pending: () => h.pending, unaccepted: () => [] } }));
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

beforeEach(() => { h.watchers.clear(); h.gone = null; h.identity = null; h.parentAgent = null; vi.clearAllMocks(); });

describe('session-life ACP leg', () => {

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

  it('#552: only the runtime\'s typed refusal (missing) is a lost channel; a thrown refusal is the owner\'s exit', async () => {
    const adapter = await boundAdapter();
    h.inject.mockRejectedValueOnce(new Error('Session not found'));
    // The prompt may have reached the worker before it broke: not a lost channel, whatever the session reads after.
    await expect(adapter.dispatch({} as StageOut, row, ctx())).rejects.toThrow('Session not found');
  });

  it('a session that closes while its start is out is that start\'s typed failure, never a bare exit that beats it', async () => {
    const adapter = await boundAdapter();
    const process = { ...(await processLease()), client: { startSession: h.startSession } } as unknown as ProcessLease;
    const exits: ExitFact[] = [];
    adapter.onExit({ process }, exit => exits.push(exit));
    let answer!: (value: unknown) => void;
    h.startSession.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const have = { process, cli: { command: { input: { projectId: 'p' } } }, platform: { injected: false }, capabilities: {} } as never;
    const channel = adapter.run('channel', have, ctx());
    // The resume of a record the engine no longer has: the runtime session closes, then the start answers why.
    h.watchers.get('s')!({ lifecycle: 'starting' });
    h.watchers.get('s')!({ lifecycle: 'closed' });
    answer({ success: false, error: { type: 'provider_session_missing', message: 'Resource not found' } });
    await expect(channel).rejects.toMatchObject({ name: 'AcpStartFailed', data: expect.stringContaining('provider_session_missing'), awaitsPerson: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(exits).toEqual([]);
  });

  it('#552: an exit seen while a missing dispatch is out is subsumed by the lost channel', async () => {
    const adapter = await boundAdapter();
    const process = await processLease();
    const exits: ExitFact[] = [];
    adapter.onExit({ process }, exit => exits.push(exit));
    let answer!: (value: unknown) => void;
    h.inject.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const lostDispatch = adapter.dispatch({} as StageOut, row, ctx());
    h.watchers.get('s')!({ lifecycle: 'ready' });
    h.watchers.get('s')!({ lifecycle: 'closed' });
    answer({ outcome: 'missing', completion: Promise.resolve() });
    expect(await lostDispatch).toMatchObject({ result: 'channel-lost' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(exits).toEqual([]);
  });

  it('#552: the worker going away while a dispatch is out releases the exit at once; the dispatch ends by its own rejection', async () => {
    const adapter = await boundAdapter();
    const process = await processLease();
    const exits: ExitFact[] = [];
    adapter.onExit({ process }, exit => exits.push(exit));
    let refuse!: (error: Error) => void;
    h.inject.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const dispatch = adapter.dispatch({} as StageOut, row, ctx());
    h.gone!('ACP runtime exited');
    expect(exits).toHaveLength(1);
    // session-wire rejects every call still out when the worker transport closes.
    refuse(Object.assign(new Error('Wire transport disconnected'), { code: 'DISCONNECTED' }));
    await expect(dispatch).rejects.toThrow('Wire transport disconnected');
    expect(exits).toHaveLength(1);
  });

  it('a delivery into a next-tool-call harness steers its running turn unless the sender queued it (#4708)', async () => {
    const adapter = await boundAdapter();
    h.inject.mockResolvedValue({ outcome: 'started', completion: Promise.resolve(), turnId: 't' });
    await adapter.dispatch({} as StageOut, row, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', { steerIfBusy: true });
    await adapter.dispatch({} as StageOut, { ...(row as object), message: { id: 'm', text: 'hi', delivery: { queue: true } } } as never, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', {});
  });

  it('a backlog waiting when the channel was admitted goes out turn by turn; only later input steers the running turn', async () => {
    const adapter = await boundAdapter();
    const process = { ...(await processLease()), client: { startSession: h.startSession } } as unknown as ProcessLease;
    h.startSession.mockResolvedValueOnce({ success: true, data: { providerSessionId: 'native-s' } });
    h.pending = { queued: [1, 2], dispatching: [] };
    const have = { process, cli: { command: { input: { projectId: 'p', providerId: 'claude', cwd: '/repo' } } }, platform: { injected: false },
      capabilities: { injection: {}, facts: { mcpDisabledServers: [] } } } as never;
    await adapter.run('channel', have, ctx());
    h.inject.mockResolvedValue({ outcome: 'started', completion: Promise.resolve(), turnId: 't' });
    await adapter.dispatch({} as StageOut, { ...(row as object), seq: 2 } as never, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', {});
    await adapter.dispatch({} as StageOut, { ...(row as object), seq: 3 } as never, ctx());
    expect(h.inject).toHaveBeenLastCalledWith('s', 'hi', { steerIfBusy: true });
    h.pending = { queued: [], dispatching: [] };
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

  it('identity: a session nothing has mounted yet (after a restart, first started by a delivery) binds at its persisted path', async () => {
    h.registered = false;
    h.identity = { guguAgentUserId: 'agent-1', chatId: 'dm' };
    await expect(createAcpLegAdapter('s', null).run('identity', {}, ctx())).resolves.toEqual({ kind: 'bound', agentUserId: 'agent-1' });
    expect(h.identityCwd).toBe('/repo');
    h.registered = true;
  });

  it('identity: a side chat is its session\'s binding, read only; an unbound session fails the fork\'s identity stage', async () => {
    const fork = { forkId: 'view-1', parentId: 's', forkFromProviderSessionId: 'native-s' };
    await expect(createAcpLegAdapter('view-1', fork).run('identity', {}, ctx())).rejects.toThrow(/session s has no gugu identity/);
    h.parentAgent = { gugu_user_id: 'agent-1' };
    await expect(createAcpLegAdapter('view-1', fork).run('identity', {}, ctx())).resolves.toEqual({ kind: 'bound', agentUserId: 'agent-1' });
  });
});

it('resolves a queued missing file only at admission, sends its not-saved context and admits following text', async () => {
  const adapter = await boundAdapter();
  const files = [{ itemId: 'gone', version: 1, name: 'gone.txt', mimeType: 'text/plain', sizeBytes: 1 }];
  h.turnFiles.mockResolvedValue({ files: [{ ...files[0], promptText: '[File not saved: File is no longer available]' }], images: [] });
  h.inject.mockResolvedValue({ outcome: 'queued', turnId: 't' });
  const pending = { ...(row as object), message: { id: 'm-file', text: 'original caption', delivery: { queue: true, origin: 'manual', files } }, turn: { kind: 'prompt' } } as never;
  await expect(adapter.dispatch({} as StageOut, pending, ctx())).resolves.toMatchObject({ result: 'accepted' });
  expect(h.inject).toHaveBeenLastCalledWith('s', 'original caption', expect.objectContaining({ files: [expect.objectContaining({ promptText: expect.stringContaining('not saved') })] }));
  expect((pending as { message: { text: string } }).message.text).toBe('original caption');
  await expect(adapter.dispatch({} as StageOut, row, ctx())).resolves.toMatchObject({ result: 'accepted' });
  expect(h.turnFiles).toHaveBeenCalledTimes(1);
});

it('a stop during file preparation refuses admission before sending any provider bytes', async () => {
  const adapter = await boundAdapter(), controller = new AbortController();
  h.inject.mockResolvedValue({ outcome: 'queued', turnId: 'cancelled-turn' });
  let finish!: (value: { images: []; files: [] }) => void;
  h.turnFiles.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = { ...(row as object), message: { id: 'cancel-file', text: 'caption', delivery: { queue: true, files: [{ itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }] } } } as never;
  const sending = adapter.dispatch({} as StageOut, pending, { gen, signal: controller.signal });
  controller.abort(); finish({ images: [], files: [] });
  await expect(sending).resolves.toMatchObject({ result: 'rejected-before-admission', cause: { name: 'AdmissionCancelled' } });
  expect(h.inject).not.toHaveBeenCalled();
});
