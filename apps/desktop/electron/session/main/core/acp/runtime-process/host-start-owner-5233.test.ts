import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context';

// The host's start owner is exercised against a fake worker that keeps the real SessionManager
// semantics this contract depends on (session-manager.ts `start` / `queuePrompt` / `adapterProvenance`):
// - an in-flight start is shared per conversation; a `lost` record is replaced by a reconnect;
// - `queuePrompt` uses `startInput` only when the worker has **no** record, and refuses a `lost` one;
// - `adapterProvenance` is non-null only while the record is `ready`.

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('@gugu/session-wire/worker', () => ({ lazyWorker: () => ({ get: vi.fn(), peek: vi.fn(), dispose: vi.fn() }) }));
vi.mock('@main/lib/host-ipc', () => ({ getHostIpc: vi.fn() }));
vi.mock('@main/app/app-scope', () => ({ appScope: { child: () => ({}) } }));
vi.mock('@main/worker-manifest', () => ({ desktopWorkerPath: () => '/tmp/acp.js', appRuntimeEntryPath: (file: string) => `/tmp/runtime/${file}` }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/lib/stage-ledger', () => ({
  createStageLedger: () => ({ mark: vi.fn(), settle: vi.fn(), elapsedMs: () => 0 }),
}));
vi.mock('@main/core/agents/agent-run-context', () => ({
  resolveLocalAgentRunContext: vi.fn(async () => ({ cli: { kind: 'resolved', command: '/usr/local/bin/claude' } })),
}));
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn(async () => {}) }));
vi.mock('@main/core/sessions/session-turn-store', () => ({
  persistCommittedTurn: vi.fn(),
  storedRevertBoundary: vi.fn(),
  truncateStoredHistory: vi.fn(),
}));
vi.mock('@main/core/sessions/mark-provider-session-missing', () => ({ markProviderSessionMissing: vi.fn() }));
vi.mock('@main/core/sessions/set-session-mcp-servers', () => ({ setSessionMcpServers: vi.fn(async () => {}) }));
vi.mock('@main/core/mcp/services/McpService', () => ({ mcpService: { listForAgent: vi.fn(async () => []) } }));
vi.mock('@main/core/sessions/getSessions', () => ({ getSessions: vi.fn(async () => []) }));
vi.mock('@main/core/sessions/agent-display-name', () => ({ sessionAgentDisplayName: vi.fn(async () => null) }));
vi.mock('@main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: vi.fn(async () => ({ modelId: 'glm-5.3' })),
}));
vi.mock('@main/core/sessions/runtime-fork-ownership', () => ({
  closeRuntimeForkOwnershipForRuntimeSession: vi.fn(async () => {}),
  recordRuntimeForkOwnership: vi.fn(async () => {}),
}));
vi.mock('@main/core/acp/emdash-mcp-injector', () => ({ getEmdashMcpInjector: () => null }));
const platform = vi.hoisted(() => ({ issued: 0, released: [] as Array<string | null> }));
vi.mock('@main/core/acp/emdash-platform-injector', () => ({
  getEmdashPlatformInjector: () => async () => {
    platform.issued += 1;
    return {
      kind: 'session-meta',
      platformAccessSessionId: `pa-${platform.issued}`,
      sessionMeta: { claudeCode: { options: { settings: `/tmp/settings-${platform.issued}.json` } } },
    };
  },
  releaseEmdashPlatformSession: vi.fn(async (sessionId: string | null) => {
    platform.released.push(sessionId);
  }),
}));
const statusWriter = vi.hoisted(() => ({ interrupt: vi.fn(async () => {}) }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: statusWriter }));
vi.mock('./session-persistence-policy', () => ({ persistAcpStartResult: vi.fn(async () => {}) }));
const browserClose = vi.hoisted(() => vi.fn(async (_sessionId: string) => {}));
vi.mock('../../../../../browser-agent-mcp', () => ({ closeSessionBrowserTools: browserClose }));

const { createStartOwningClient } = await import('./host');

type Phase = 'starting' | 'ready' | 'lost';
type Rec = { phase: Phase; input: Record<string, unknown>; queue: unknown[] };
const ok = <T>(data: T) => ({ success: true as const, data });
const err = (type: string, message: string) => ({ success: false as const, error: { type, message } });

function fakeWorker() {
  const records = new Map<string, Rec>();
  const starting = new Map<string, Promise<unknown>>();
  const startInputs: Array<Record<string, unknown>> = [];
  const startSession = ({ input }: { input: Record<string, unknown> }) => {
    const id = input.sessionId as string;
    const inFlight = starting.get(id);
    if (inFlight) return inFlight;
    const existing = records.get(id);
    if (existing && existing.phase !== 'lost') return Promise.resolve(ok({ providerSessionId: `s-${id}` }));
    records.delete(id); // a lost record is replaced by the reconnect, as SessionManager.start does
    startInputs.push(input);
    const rec: Rec = { phase: 'starting', input, queue: existing?.queue ?? [] };
    records.set(id, rec);
    const op = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      rec.phase = 'ready';
      return ok({ providerSessionId: `s-${id}` });
    })();
    starting.set(id, op);
    void op.finally(() => starting.delete(id));
    return op;
  };
  const client = {
    startSession,
    cancelTurn: vi.fn(async (_input: { sessionId: string }) => ok(undefined)),
    stopSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      records.delete(sessionId);
      return ok(undefined);
    }),
    queuePrompt: vi.fn(async (input: { sessionId: string; prompt: unknown; startInput?: Record<string, unknown> }) => {
      let rec = records.get(input.sessionId);
      if (!rec && input.startInput) {
        await startSession({ input: input.startInput });
        rec = records.get(input.sessionId);
      }
      if (rec?.phase === 'starting') await starting.get(input.sessionId);
      if (!rec) return err('conversation_not_found', input.sessionId);
      if (rec.phase === 'lost') return err('invalid_state', `Session '${input.sessionId}' lost its ACP adapter; reconnect before sending`);
      rec.queue.push(input.prompt);
      return ok({ queued: true });
    }),
    adapterProvenance: vi.fn(async ({ sessionId }: { sessionId: string }) =>
      records.get(sessionId)?.phase === 'ready' ? { connectionKey: `k-${sessionId}`, pid: 1 } : null),
    // SessionManager.announce:没有记录 / 已丢 ⇒ delivered:false。
    announceSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const phase = records.get(sessionId)?.phase;
      return { delivered: phase !== undefined && phase !== 'lost' };
    }),
  };
  return {
    client,
    startInputs,
    loseAdapter: (id: string) => { const rec = records.get(id); if (rec) rec.phase = 'lost'; },
    phase: (id: string) => records.get(id)?.phase ?? null,
    queue: (id: string) => records.get(id)?.queue ?? [],
  };
}

const startInput = {
  sessionId: 'conv-1', projectId: 'p', workspaceId: 'w', providerId: 'claude', cwd: '/tmp',
};

describe('#5233 host start owner after an abnormal adapter exit', () => {
  beforeEach(() => { platform.issued = 0; platform.released = []; });

  it('the existing Stop action closes only that session\'s browser tools even when the harness does not cancel MCP calls', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    browserClose.mockClear();
    const result = await host.cancelTurn({ sessionId: 'stopped-agent' }, undefined as never);
    expect(result.success).toBe(true);
    expect(browserClose).toHaveBeenCalledExactlyOnceWith('stopped-agent');
    expect(worker.client.cancelTurn).toHaveBeenCalledExactlyOnceWith({ sessionId: 'stopped-agent' }, undefined);
  });

  it('a queued sentence with startInput after the adapter was lost restarts the session with one new platform ticket', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    expect((await host.startSession({ input: startInput } as never, undefined as never)).success).toBe(true);
    expect(worker.phase('conv-1')).toBe('ready');
    expect(platform.issued).toBe(1);

    worker.loseAdapter('conv-1'); // adapter killed, not stopped: the host is never told

    const queued = await host.queuePrompt(
      { sessionId: 'conv-1', prompt: { text: 'next' }, startInput } as never,
      undefined as never,
    );
    expect(queued).toMatchObject({ success: true });
    expect(worker.phase('conv-1')).toBe('ready');
    expect(worker.queue('conv-1')).toEqual([{ text: 'next' }]);
    expect(platform.issued).toBe(2); // exactly one new ticket for the recovery
    // the worker was re-started with the host-prepared input, not the renderer's bare one
    expect(worker.startInputs.at(-1)).toMatchObject({ platformAccessSessionId: 'pa-2' });
  });

  it('the renderer reconnect and the queued sentence together still issue one ticket', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    await host.startSession({ input: startInput } as never, undefined as never);
    worker.loseAdapter('conv-1');
    const [reconnect, queued] = await Promise.all([
      host.startSession({ input: startInput } as never, undefined as never),
      host.queuePrompt({ sessionId: 'conv-1', prompt: { text: 'next' }, startInput } as never, undefined as never),
    ]);
    expect(reconnect.success).toBe(true);
    expect(queued).toMatchObject({ success: true });
    expect(platform.issued).toBe(2);
  });

  it('a queued sentence to a live session is only queued: no second start, no new ticket', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    await host.startSession({ input: startInput } as never, undefined as never);
    const queued = await host.queuePrompt(
      { sessionId: 'conv-1', prompt: { text: 'next' }, startInput } as never,
      undefined as never,
    );
    expect(queued).toMatchObject({ success: true });
    expect(platform.issued).toBe(1);
    expect(worker.startInputs).toHaveLength(1);
  });

  it.each(['claude', 'codex'] as const)('%s ACP restarts carry the session credential context to the worker', async (providerId) => {
    const context = { cli: { kind: 'resolved' as const, path: '/cli' }, connectionId: 'original', env: {},
      configRootEnv: { [providerId === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: '/accounts/original' },
      selfUpdateEnv: {}, extraArgs: [] };
    vi.mocked(resolveLocalAgentRunContext).mockResolvedValueOnce(context).mockResolvedValueOnce(context);
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    const input = { ...startInput, providerId, sessionId: `${providerId}-account-restart` };
    await host.startSession({ input } as never, undefined as never);
    await host.stopSession({ sessionId: input.sessionId } as never, undefined as never);
    await host.startSession({ input: { ...input, model: 'changed-model', providerSessionId: 'same-thread' } } as never, undefined as never);
    expect(worker.startInputs).toHaveLength(2);
    for (const started of worker.startInputs) expect(started.runContext).toEqual(context);
    expect(resolveLocalAgentRunContext).toHaveBeenLastCalledWith(providerId, expect.objectContaining({ sessionId: input.sessionId }));
  });

  it('resolves a runtime-only fork against its persistent source subscription', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    await host.startSession({ input: {
      ...startInput,
      sessionId: 'runtime-fork',
      sourceSessionId: 'persistent-source',
      forkFromProviderSessionId: 'provider-source',
    } } as never, undefined as never);
    expect(resolveLocalAgentRunContext).toHaveBeenLastCalledWith('claude', expect.objectContaining({
      sessionId: 'runtime-fork',
      sourceSessionId: 'persistent-source',
    }));
  });
});

describe('#6396 announceSession joins the in-flight start', () => {
  it('会话还在宿主这侧准备启动 ⇒ 等它交给 worker 就递,❌ 等它起完(首句在起完那一刻就发出去了)', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    const input = { ...startInput, sessionId: 'conv-announce' };
    const start = host.startSession({ input } as never, undefined as never);
    expect(worker.phase('conv-announce'), '此刻还在宿主这侧做注入').toBeNull();
    await expect(host.announceSession({ sessionId: 'conv-announce', notice: { code: 'agent-renamed', detail: 'd' } }))
      .resolves.toEqual({ delivered: true });
    expect(worker.phase('conv-announce'), '递到的时候 worker 那边还在起').toBe('starting');
    await start;
  });

  it('告知赶在 startSession 之前到了 worker(答「不在」)⇒ 等这次启动落定再递一次', async () => {
    const worker = fakeWorker();
    worker.client.announceSession.mockResolvedValueOnce({ delivered: false });
    const host = createStartOwningClient(worker.client as never);
    const start = host.startSession({ input: { ...startInput, sessionId: 'conv-race' } } as never, undefined as never);
    await expect(host.announceSession({ sessionId: 'conv-race', notice: { code: 'agent-renamed', detail: 'd' } }))
      .resolves.toEqual({ delivered: true });
    expect(worker.client.announceSession).toHaveBeenCalledTimes(2);
    expect(worker.phase('conv-race')).toBe('ready');
    await start;
  });

  it('没有在途启动、worker 也没有这条(终端会话)⇒ 原样答 delivered:false', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    await expect(host.announceSession({ sessionId: 'pty-conv', notice: { code: 'agent-renamed', detail: 'd' } }))
      .resolves.toEqual({ delivered: false });
  });
});

// #7364 会话建立途中能停(behavior session-page「打开速度」)。停止落在宿主还在准备(注入)的那一段时,worker 里还没有
// 这条会话,停止递过去扑空 —— 修之前准备一完照样交给 worker,用户按了停止、会话却起来了(真机 2026-10-17 实撞)。
describe('#7364 a start stopped while the host is still preparing it', () => {
  beforeEach(() => { platform.issued = 0; platform.released = []; statusWriter.interrupt.mockClear(); });

  it('never reaches the worker, fails, and settles the ticket minted during preparation', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    const input = { ...startInput, sessionId: 'conv-stop-early' };
    const start = host.startSession({ input } as never, undefined as never);
    expect(worker.phase('conv-stop-early'), '阳控:此刻还在宿主这侧准备').toBeNull();
    await host.stopSession({ sessionId: 'conv-stop-early' } as never, undefined as never);
    const result = await start;
    expect(result.success).toBe(false);
    expect(worker.startInputs, '❌ 准备一完照样交给 worker').toHaveLength(0);
    expect(worker.phase('conv-stop-early')).toBeNull();
    // 一次是停止那一刻,一次是准备做完之后 —— 停止那一刻票可能还没签出来。
    expect(platform.released.filter((id) => id === 'conv-stop-early')).toHaveLength(2);
    // worker 一份摘要都没出过,状态桥推不出复位 ⇒ 停止这里直接落下,❌ 停在创建时的「工作中」(侧栏一直转圈)。
    expect(statusWriter.interrupt).toHaveBeenCalledWith({ sessionId: 'conv-stop-early', projectId: 'p' });
  });

  it('a sentence that joined that start is refused instead of restarting the session', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    const input = { ...startInput, sessionId: 'conv-stop-joined' };
    const start = host.startSession({ input } as never, undefined as never);
    const queued = host.queuePrompt({ sessionId: 'conv-stop-joined', prompt: { text: 'next' }, startInput: input } as never, undefined as never);
    await host.stopSession({ sessionId: 'conv-stop-joined' } as never, undefined as never);
    expect(await queued).toMatchObject({ success: false, error: { type: 'invalid_state' } });
    expect((await start).success).toBe(false);
    expect(worker.client.queuePrompt).not.toHaveBeenCalled();
    expect(worker.startInputs).toHaveLength(0);
  });

  it('阴控:没被停的那次准备一完照常交给 worker;停一条已经起来的会话由状态桥照常复位,这里不另写', async () => {
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    const input = { ...startInput, sessionId: 'conv-not-stopped' };
    expect((await host.startSession({ input } as never, undefined as never)).success).toBe(true);
    expect(worker.startInputs).toHaveLength(1);
    await host.stopSession({ sessionId: 'conv-not-stopped' } as never, undefined as never);
    expect(statusWriter.interrupt).not.toHaveBeenCalled();
  });
});


describe('idle teardown owns the whole host start boundary', () => {
  it('holds a wake and its new credential until idle teardown has finished', async () => {
    platform.issued = 0; platform.released = [];
    const worker = fakeWorker();
    const host = createStartOwningClient(worker.client as never);
    await host.startSession({ input: startInput } as never, undefined as never);
    const closing = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    worker.client.stopSession.mockImplementationOnce(async () => {
      worker.loseAdapter('conv-1');
      entered.resolve();
      await closing.promise;
      return ok(undefined);
    });
    const stop = host.stopSession({ sessionId: 'conv-1', onlyIfIdle: true } as never, undefined as never);
    await entered.promise;
    const wake = host.startSession({ input: startInput } as never, undefined as never);
    await new Promise(resolve => setTimeout(resolve, 10));
    const issuedDuringClose = platform.issued;
    closing.resolve();
    await expect(stop).resolves.toMatchObject({ success: true });
    await expect(wake).resolves.toMatchObject({ success: true });
    expect(issuedDuringClose, 'the wake must not mint a ticket that the old stop will revoke').toBe(1);
    expect(platform.issued).toBe(2);
    expect(worker.phase('conv-1')).toBe('ready');
  });
});


it('does not revoke a live ticket when process stop has not completed', async () => {
  platform.released = [];
  const worker = fakeWorker();
  const host = createStartOwningClient(worker.client as never);
  await host.startSession({ input: startInput } as never, undefined as never);
  worker.client.stopSession.mockResolvedValueOnce(err('stop_pending', 'still stopping') as never);
  expect(await host.stopSession({ sessionId: 'conv-1' } as never, undefined as never))
    .toMatchObject({ success: false, error: { type: 'stop_pending' } });
  expect(platform.released).toEqual([]);
});


it('finishes a previously failed close before preparing a replacement credential', async () => {
  platform.issued = 0; platform.released = [];
  const worker = fakeWorker();
  worker.client.adapterProvenance.mockResolvedValueOnce({ connectionKey: 'old', pid: 1, closing: true } as never);
  const closing = Promise.withResolvers<void>();
  worker.client.stopSession.mockImplementationOnce(async () => { await closing.promise; return ok(undefined); });
  const host = createStartOwningClient(worker.client as never);
  const wake = host.startSession({ input: startInput } as never, undefined as never);
  await new Promise(resolve => setTimeout(resolve, 10));
  const issuedBeforeExit = platform.issued;
  closing.resolve();
  await wake;
  expect(worker.client.stopSession).toHaveBeenCalledTimes(1);
  expect(issuedBeforeExit).toBe(0);
  expect(platform.issued).toBe(1);
  expect(platform.released).toEqual(['conv-1']);
});

it('runs an explicit stop after a conditional reclaim declines instead of sharing its refusal', async () => {
  const worker = fakeWorker();
  const host = createStartOwningClient(worker.client as never);
  await host.startSession({ input: startInput } as never, undefined as never);
  const conditional = Promise.withResolvers<ReturnType<typeof err>>();
  worker.client.stopSession.mockImplementationOnce(() => conditional.promise as never);
  const reclaim = host.stopSession({ sessionId: 'conv-1', onlyIfIdle: true }, undefined as never);
  await vi.waitFor(() => expect(worker.client.stopSession).toHaveBeenCalledTimes(1));
  const explicit = host.stopSession({ sessionId: 'conv-1' }, undefined as never);
  conditional.resolve(err('stop_failed', 'Session is no longer idle'));
  expect((await reclaim).success).toBe(false);
  expect(await explicit).toMatchObject({ success: true });
  expect(worker.phase('conv-1')).toBeNull();
  expect(worker.client.stopSession).toHaveBeenCalledTimes(2);
});

it('releases the old ticket and permits recovery after teardown RPC rejects after process exit', async () => {
  platform.issued = 0; platform.released = [];
  const worker = fakeWorker();
  const host = createStartOwningClient(worker.client as never);
  await host.startSession({ input: startInput } as never, undefined as never);
  const closing = Promise.withResolvers<never>();
  worker.client.stopSession.mockImplementationOnce(() => closing.promise);
  const stopped = host.stopSession({ sessionId: 'conv-1' }, undefined as never);
  void stopped.catch(() => {});
  await vi.waitFor(() => expect(worker.client.stopSession).toHaveBeenCalledTimes(1));
  const wake = host.startSession({ input: startInput } as never, undefined as never);
  worker.loseAdapter('conv-1');
  closing.reject(new Error('worker reply lost'));
  await stopped.catch(() => {});
  await expect(wake).resolves.toMatchObject({ success: true });
  expect(platform.released).toContain('conv-1');
  expect(platform.issued).toBe(2);
});

it('bounds a silent worker stop and does not mint over a process still closing', async () => {
  platform.issued = 0; platform.released = [];
  const worker = fakeWorker();
  const host = createStartOwningClient(worker.client as never);
  await host.startSession({ input: startInput } as never, undefined as never);
  worker.client.stopSession.mockImplementationOnce(() => new Promise(() => {}));
  worker.client.adapterProvenance.mockResolvedValue({ connectionKey: 'k-conv-1', pid: 1, closing: true } as never);
  vi.useFakeTimers();
  try {
    const stopped = host.stopSession({ sessionId: 'conv-1' }, undefined as never);
    const wake = host.startSession({ input: startInput } as never, undefined as never);
    const failedWake = expect(wake).rejects.toThrow('teardown did not complete');
    await vi.advanceTimersByTimeAsync(12_001);
    await expect(stopped).resolves.toMatchObject({ success: false, error: { type: 'stop_failed' } });
    await failedWake;
    expect(platform.issued).toBe(1);
    expect(platform.released).toEqual([]);
    // A later request is no longer held by a stale host barrier.
    const retry = host.stopSession({ sessionId: 'conv-1' }, undefined as never);
    await expect(retry).resolves.toMatchObject({ success: true });
    expect(platform.released).toEqual(['conv-1']);
  } finally { vi.useRealTimers(); }
});

it.each(['reject', 'hang'])('browser cleanup can %s without retaining the old ticket or blocking a wake', async mode => {
  platform.issued = 0; platform.released = [];
  const worker = fakeWorker();
  const host = createStartOwningClient(worker.client as never);
  await host.startSession({ input: startInput } as never, undefined as never);
  const browser = Promise.withResolvers<void>();
  browserClose.mockImplementationOnce(() => mode === 'reject' ? Promise.reject(new Error('browser close failed')) : browser.promise);
  vi.useFakeTimers();
  try {
    const stopped = host.stopSession({ sessionId: 'conv-1' }, undefined as never);
    void stopped.catch(() => {});
    const wake = host.startSession({ input: startInput } as never, undefined as never);
    void wake.catch(() => {});
    let stopResult: unknown;
    void stopped.then(value => { stopResult = value; }, error => { stopResult = error; });
    await vi.advanceTimersByTimeAsync(1_010);
    expect(stopResult).toMatchObject({ success: true });
    await expect(wake).resolves.toMatchObject({ success: true });
    expect(platform.released).toEqual(['conv-1']);
    expect(platform.issued).toBe(2);
  } finally { browser.resolve(); vi.useRealTimers(); }
});

it('reuses a live session when opening it while idle reclamation declines', async () => {
  const worker = fakeWorker();
  const host = createStartOwningClient(worker.client as never);
  await host.startSession({ input: startInput } as never, undefined as never);
  const conditional = Promise.withResolvers<ReturnType<typeof err>>();
  worker.client.stopSession.mockImplementationOnce(() => conditional.promise as never);
  const reclaim = host.stopSession({ sessionId: 'conv-1', onlyIfIdle: true }, undefined as never);
  await vi.waitFor(() => expect(worker.client.stopSession).toHaveBeenCalledOnce());
  const opening = host.startSession({ input: startInput } as never, undefined as never);
  void opening.catch(() => {});
  conditional.resolve(err('stop_failed', 'Session is no longer idle; reclamation declined'));
  expect((await reclaim).success).toBe(false);
  await expect(opening).resolves.toMatchObject({ success: true });
  expect(worker.phase('conv-1')).toBe('ready');
});
