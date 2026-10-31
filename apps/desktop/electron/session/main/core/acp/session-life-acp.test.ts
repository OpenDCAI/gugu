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
  forks: [] as Array<{ runtimeSessionId: string; sourceSessionId: string; status: 'active' | 'closed' }>,
  identity: null as unknown,
}));

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
vi.mock('@main/core/sessions/runtime-fork-ownership', () => ({ recordRuntimeForkOwnership: vi.fn(), readRuntimeForkOwnership: async () => h.forks }));
vi.mock('@main/core/projects/utils', () => ({ resolveWorkspace: () => ({ path: '/repo' }) }));
vi.mock('@main/core/sessions/getSessions', () => ({ getSessions: async () => [{ id: 's', runtime: 'acp', providerId: 'claude', projectId: 'p', workspaceId: 'w', providerSessionId: null }] }));
vi.mock('@main/core/sessions/session-service', () => ({ sessionService: {} }));
vi.mock('./runtime-process/resume-history', () => ({ resumeHistoryFacts: vi.fn() }));
vi.mock('./runtime-process/session-persistence-policy', () => ({ persistAcpStartResult: vi.fn() }));

import { acpWorkerLease } from './runtime-process/host';
import { createAcpLegAdapter } from './session-life-acp';

const gen = { auth: 1, attempt: 1 } as unknown as Gen;
const ctx = () => ({ gen, signal: new AbortController().signal });
const row = { seq: 1, sessionId: 's', kind: 'ordinary', state: 'dispatching', message: { id: 'm', text: 'hi' }, sources: [] } as never;
const processLease = async () => (await acpWorkerLease()) as unknown as ProcessLease;

describe('session-life ACP leg', () => {
  beforeEach(() => { h.watchers.clear(); h.gone = null; h.forks = []; h.identity = null; vi.clearAllMocks(); });

  it('one exit per attempt, from whichever fact ends the session first', async () => {
    const process = await processLease();
    for (const end of [
      () => h.watchers.get('s')!({ lifecycle: 'lost' }),
      () => h.watchers.get('s')!({ lifecycle: 'closed' }),
      () => h.watchers.get('s')!(undefined),
      () => h.gone!('ACP runtime restarted'),
    ]) {
      const exits: ExitFact[] = [];
      const off = createAcpLegAdapter('s').onExit({ process }, exit => exits.push(exit));
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
    createAcpLegAdapter('s').onExit({ process: await processLease() }, exit => exits.push(exit));
    h.watchers.get('s')!({ lifecycle: 'lost' });
    h.watchers.get('s')!(undefined);
    h.watchers.get('s')!({ lifecycle: 'closed' });
    expect(exits).toEqual([]);
  });

  it("the exit carries the runtime's own failure, so the cause survives a race with the channel failure", async () => {
    const exits: ExitFact[] = [];
    createAcpLegAdapter('s').onExit({ process: await processLease() }, exit => exits.push(exit));
    h.watchers.get('s')!({ lifecycle: 'starting' });
    h.watchers.get('s')!({ lifecycle: 'lost', failure: { kind: 'adapter-exit', message: 'claude exited: login required', exitCode: 1, signal: null } });
    expect(exits).toEqual([{ cause: { name: 'adapter-exit', message: 'claude exited: login required' }, code: 1, signal: null }]);
  });

  it('maps the worker admission: started/queued is accepted with its turn, declined/missing is rejected before admission', async () => {
    const adapter = createAcpLegAdapter('s');
    h.inject.mockResolvedValueOnce({ outcome: 'queued', completion: Promise.resolve(), turnId: 't1' });
    expect(await adapter.dispatch({} as StageOut, row, ctx())).toEqual({ result: 'accepted', nativeReceiptId: 't1' });
    h.inject.mockResolvedValueOnce({ outcome: 'declined', completion: Promise.resolve() });
    expect(await adapter.dispatch({} as StageOut, row, ctx())).toMatchObject({ result: 'rejected-before-admission' });
  });

  it('teardown uses the one ACP stop; without a process it only settles the ticket; a failed stop fails loudly', async () => {
    const process = await processLease();
    await createAcpLegAdapter('s').teardown({ process, platform: {} as never }, { gen });
    expect(h.stopAndSettle).toHaveBeenCalledWith(h.client, 's');
    expect(h.release).not.toHaveBeenCalled();
    await createAcpLegAdapter('s').teardown({ platform: {} as never }, { gen });
    expect(h.release).toHaveBeenCalledWith('s');
    h.stopAndSettle.mockRejectedValueOnce(new Error('ACP session s did not stop: busy'));
    await expect(createAcpLegAdapter('s').teardown({ process }, { gen })).rejects.toThrow(/did not stop/);
  });

  it('ending dependents stops every active fork of this session, tries all, then throws the aggregate', async () => {
    h.forks = [
      { runtimeSessionId: 'view-1', sourceSessionId: 's', status: 'active' },
      { runtimeSessionId: 'view-2', sourceSessionId: 's', status: 'active' },
      { runtimeSessionId: 'view-old', sourceSessionId: 's', status: 'closed' },
      { runtimeSessionId: 'view-other', sourceSessionId: 'other', status: 'active' },
    ];
    h.stopAndSettle.mockImplementation(async (_client, id) => { if (id === 'view-1') throw new Error('view-1 stuck'); });
    await expect(createAcpLegAdapter('s').endDependents()).rejects.toThrow(/1 runtime fork\(s\) of session s did not stop/);
    expect(h.stopAndSettle.mock.calls.map(([, id]) => id)).toEqual(['view-1', 'view-2']);
  });

  it('identity: a persisted session without a provisionable identity fails the identity stage', async () => {
    await expect(createAcpLegAdapter('s').run('identity', {}, ctx())).rejects.toThrow(/has no gugu identity/);
    h.identity = { guguAgentUserId: 'agent-1', chatId: 'dm' };
    await expect(createAcpLegAdapter('s').run('identity', {}, ctx())).resolves.toEqual({ kind: 'bound', agentUserId: 'agent-1' });
  });
});
