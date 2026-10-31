import { beforeEach, describe, expect, it, vi } from 'vitest';

// #7223 宿主这一侧只做一件事:有原生会话可续、而它是一句没聊过的常驻 agent ⇒ 启动入参带上 `freshIfProviderSessionMissing`,
// 引擎说没有这条时由 runtime 在**同一次**启动里新开;聊过的、记着首轮的不带。起来之后去掉陈旧的 missing 标记。
// 入参以会话记录为准:渲染端递来的这一格一律不作数。

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
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn(async () => ({ success: true, data: undefined })) }));
vi.mock('@main/core/sessions/session-turn-store', () => ({
  persistCommittedTurn: vi.fn(),
  storedRevertBoundary: vi.fn(),
  truncateStoredHistory: vi.fn(),
}));
const cleared = vi.hoisted(() => ({ fn: vi.fn(async () => true) }));
vi.mock('@main/core/sessions/mark-provider-session-missing', () => ({
  markProviderSessionMissing: vi.fn(),
  clearProviderSessionMissing: cleared.fn,
}));
vi.mock('@main/core/sessions/set-session-mcp-servers', () => ({ setSessionMcpServers: vi.fn(async () => {}) }));
vi.mock('@main/core/mcp/services/McpService', () => ({ mcpService: { listForAgent: vi.fn(async () => []) } }));
// 要续的原生会话 id 由启动准备从库里现读(#5869):这里的「库」就是这一格,重置把它清空。
const stored = vi.hoisted(() => ({ providerSessionId: 'gone' as string | null }));
vi.mock('@main/core/sessions/getSessions', () => ({
  getSessions: vi.fn(async () => [{ id: 'assistant', providerSessionId: stored.providerSessionId }]),
}));
vi.mock('@main/core/sessions/agent-display-name', () => ({ sessionAgentDisplayName: vi.fn(async () => null) }));
vi.mock('@main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: vi.fn(async () => ({ modelId: 'glm-5.3' })),
}));
vi.mock('@main/core/sessions/runtime-fork-ownership', () => ({
  closeRuntimeForkOwnershipForRuntimeSession: vi.fn(async () => {}),
  recordRuntimeForkOwnership: vi.fn(async () => {}),
}));
vi.mock('@main/core/acp/emdash-mcp-injector', () => ({ getEmdashMcpInjector: () => null, getEmdashIdentityProvisioner: () => async () => null }));
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
const neverRun = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@main/core/sessions/never-run-session', () => ({ isResidentNeverRun: neverRun.fn }));

const { createStartOwningClient } = await import('./host');

function worker() {
  const startInputs: Array<Record<string, unknown>> = [];
  const client = {
    startSession: vi.fn(async ({ input }: { input: Record<string, unknown> }) => {
      startInputs.push(input);
      return { success: true as const, data: { providerSessionId: 'fresh-native' } };
    }),
    adapterProvenance: vi.fn(async () => null),
  };
  return { client, startInputs };
}

// 渲染端 / 唤醒那份入参里的值不作数(准备时以库为准),这里故意递别的值。
const resumeInput = {
  sessionId: 'assistant', projectId: 'p', workspaceId: 'w', providerId: 'claude', cwd: '/tmp', providerSessionId: 'renderer-snapshot',
};

async function start(input: Record<string, unknown> = resumeInput) {
  const w = worker();
  const host = createStartOwningClient(w.client as never);
  const result = await host.startSession({ input } as never, undefined as never);
  return { w, result };
}

describe('#7223 宿主给 runtime 的那一格:一轮都没跑完过 ⇒ 引擎没有这条时同一次启动里新开', () => {
  beforeEach(() => {
    platform.issued = 0;
    platform.released = [];
    neverRun.fn.mockReset();
    cleared.fn.mockClear();
    stored.providerSessionId = 'gone';
  });

  it('没聊过(建来常驻):带上这一格,续的仍是库里那个 id,worker 只被叫一次', async () => {
    neverRun.fn.mockResolvedValue(true);
    const { w } = await start();
    expect(neverRun.fn).toHaveBeenCalledWith('assistant');
    expect(w.startInputs).toHaveLength(1);
    expect(w.startInputs[0]).toMatchObject({ providerSessionId: 'gone', providerId: 'claude', freshIfProviderSessionMissing: true });
  });

  it('阴控 —— 聊过 / 记着首轮:不带这一格,渲染端递来的也一律去掉', async () => {
    neverRun.fn.mockResolvedValue(false);
    const { w } = await start({ ...resumeInput, freshIfProviderSessionMissing: true });
    expect(w.startInputs[0]?.freshIfProviderSessionMissing).toBeUndefined();
  });

  it('首次启动(库里本来就没有 id)与运行时分叉:不读、不带', async () => {
    stored.providerSessionId = null;
    const first = await start();
    expect(first.w.startInputs[0]?.freshIfProviderSessionMissing).toBeUndefined();
    stored.providerSessionId = 'gone';
    const fork = await start({ ...resumeInput, sessionId: 'side-chat', forkFromProviderSessionId: 'gone', sourceSessionId: 'assistant' });
    expect(fork.w.startInputs[0]?.freshIfProviderSessionMissing).toBeUndefined();
    expect(neverRun.fn).not.toHaveBeenCalled();
  });

  it('起来了 ⇒ 去掉陈旧的 missing 标记(只认刚写下的那个 id)', async () => {
    neverRun.fn.mockResolvedValue(true);
    const { result } = await start();
    expect(result).toMatchObject({ success: true });
    expect(cleared.fn).toHaveBeenCalledWith('assistant', 'fresh-native');
  });
});
