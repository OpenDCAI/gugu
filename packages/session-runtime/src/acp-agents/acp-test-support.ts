/**
 * Reusable test helpers for ACP unit tests.
 *
 * Not a test file itself (no `.test.` suffix) — Vitest will not collect it.
 * Import from `./acp-test-support` in test files that need it.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Client } from '@agentclientprotocol/sdk';
import type { ProviderPermissionModeMap, QueuedPrompt, SessionSummary } from '@gugu/session-core/acp';
import type {
  AcpFs,
  AcpProcessHandle,
  AcpProcessHost,
  AcpTerminalExit,
  AcpTerminalProcess,
} from '@gugu/session-core/acp/node';
import {
  AgentPluginHost,
  createPluginRegistry,
  type AcpAgentApi,
  type CLIAgentPluginProvider,
  type IAcpBehavior,
  type LiveSettingsCapability,
  type ResolvedAuthProvider,
  type SessionBundleDescriptor,
} from '@gugu/session-core/agents/plugins';
import type { IExecutionContext } from '@gugu/session-core/exec';
import type { PtyExitInfo, PtyProcess, PtySpawnSpec, PtySpawner } from '@gugu/session-core/pty';
import { noopLogger } from '@gugu/session-shared/logger';
import { createScope } from '@gugu/session-wire/util';
import { type Mock, vi } from 'vitest';
import { awaitPending } from '../../../../tests/support/awaitFact';
import type { AgentTerminalHooks } from './agent-ports/terminal-manager';
import type { AcpRuntime } from './runtime/runtime';
import type { AcpRuntimeDeps, AcpStartInput } from './runtime/types';

/**
 * Creates recording terminal hooks.
 * `emitted(field)` returns all objects emitted via that method.
 */
export function createRecordingListener() {
  const terminalCreated: {
    sessionId: string;
    terminalId: string;
    command: string;
    args: string[];
    cwd: string;
  }[] = [];
  const terminalOutput: {
    sessionId: string;
    terminalId: string;
    chunk: string;
    truncated: boolean;
  }[] = [];
  const terminalExit: {
    sessionId: string;
    terminalId: string;
    exitStatus: AcpTerminalExit;
  }[] = [];
  const terminalReleased: { sessionId: string; terminalId: string }[] = [];

  const listener: AgentTerminalHooks = {
    onTerminalCreated: (e) => terminalCreated.push(e),
    onTerminalOutput: (e) => terminalOutput.push(e),
    onTerminalExit: (e) => terminalExit.push(e),
    onTerminalReleased: (e) => terminalReleased.push(e),
  };

  return {
    listener,
    terminalCreated,
    terminalOutput,
    terminalExit,
    terminalReleased,
    clear() {
      terminalCreated.length = 0;
      terminalOutput.length = 0;
      terminalExit.length = 0;
      terminalReleased.length = 0;
    },
  };
}

/** The agent-side methods the runtime calls through the connection. */
export type FakeAcpAgentMethod =
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'unstable_forkSession'
  | 'closeSession'
  | 'cancel'
  | 'prompt'
  | 'setSessionConfigOption'
  | 'setSessionMode'
  | 'extMethod';

const FAKE_ACP_AGENT_METHODS: ReadonlySet<string> = new Set<FakeAcpAgentMethod>([
  'initialize',
  'newSession',
  'loadSession',
  'unstable_forkSession',
  'closeSession',
  'cancel',
  'prompt',
  'setSessionConfigOption',
  'setSessionMode',
  'extMethod',
]);

/**
 * An injectable fake that implements AcpAgentApi.
 * After the plugin's `connect(io, toClient)` is called, `capturedClient`
 * holds the runtime's inbound Client handler.
 */
export class FakeAcpAgent implements AcpAgentApi {
  initialize: Mock = vi.fn().mockResolvedValue({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  newSession: Mock = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
  loadSession: Mock = vi.fn().mockResolvedValue({});
  unstable_forkSession: Mock = vi.fn().mockResolvedValue({ sessionId: 'forked-session' });
  closeSession: Mock = vi.fn().mockResolvedValue({});
  cancel: Mock = vi.fn().mockResolvedValue({});
  prompt: Mock = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
  setSessionConfigOption: Mock = vi.fn().mockResolvedValue({});
  setSessionMode: Mock = vi.fn().mockResolvedValue({});
  extMethod: Mock = vi.fn().mockResolvedValue({ stopped: true });

  /** The Client handler the runtime registered via toClient(). Available after connect(). */
  capturedClient: Client | null = null;

  private readonly callWaiters = new Set<{ holds: () => boolean; resolve: () => void }>();

  readonly behavior: Pick<IAcpBehavior, 'connect'> = {
    connect: (_io, toClient) => {
      this.capturedClient = toClient(this as never);
      return this.observed();
    },
  };

  /**
   * 这个 agent「被调用时会报一声」的样子:runtime 经它调任何 agent 方法,都叫醒 `called` / `whenCalled`
   * 的等待者。方法照旧从 `this` 上现取,用例随时替换 / mockImplementation 都作数。
   * 经 `connect` 拿到的就是它;直接把 agent 交给 SessionCell 的用例要自己传 `agent.observed()`。
   */
  observed(): AcpAgentApi {
    return new Proxy(this, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof property !== 'string' || !FAKE_ACP_AGENT_METHODS.has(property)) return value;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          try {
            return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
          } finally {
            target.wakeCallWaiters();
          }
        };
      },
    });
  }

  /**
   * runtime 把 `method` 累计调到 ≥ `times` 次时 resolve —— 等的是调用本身,❌ vi.waitFor 的期限。
   * 只等「至少」:确切次数由调用方在之后用 expect 断言(多调了是红,不是挂住)。
   */
  called(method: FakeAcpAgentMethod, times = 1): Promise<void> {
    return this.whenCalled(`agent.${method} called ${times}x`, () => this[method].mock.calls.length >= times);
  }

  /** 先判一次,之后 runtime 每调一次 agent 就重判,成立为止。`holds` 要读的是调用记录这类随调用单调增长的事实。 */
  whenCalled(step: string, holds: () => boolean): Promise<void> {
    if (holds()) return Promise.resolve();
    return awaitPending(step, new Promise<void>((resolve) => this.callWaiters.add({ holds, resolve })));
  }

  private wakeCallWaiters(): void {
    for (const waiter of [...this.callWaiters]) {
      if (!waiter.holds()) continue;
      this.callWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  reset() {
    this.initialize = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    this.newSession = vi.fn().mockResolvedValue({ sessionId: 'session-1' });
    this.loadSession = vi.fn().mockResolvedValue({});
    this.unstable_forkSession = vi.fn().mockResolvedValue({ sessionId: 'forked-session' });
    this.closeSession = vi.fn().mockResolvedValue({});
    this.cancel = vi.fn().mockResolvedValue({});
    this.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    this.setSessionConfigOption = vi.fn().mockResolvedValue({});
    this.setSessionMode = vi.fn().mockResolvedValue({});
    this.extMethod = vi.fn().mockResolvedValue({ stopped: true });
    this.capturedClient = null;
  }
}

// ---------------------------------------------------------------------------
// FakeAcpTerminalProcess
// ---------------------------------------------------------------------------

/**
 * A controllable fake AcpTerminalProcess for use in tests.
 * Push output via `pushOutput(chunk)` and trigger exit via `triggerExit(status)`.
 */
export class FakeAcpTerminalProcess extends EventEmitter implements AcpTerminalProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly killFn = vi.fn<(signal?: NodeJS.Signals) => void>();

  onExit(cb: (status: AcpTerminalExit) => void): void {
    this.on('exit', cb);
  }

  onError(cb: (err: Error) => void): void {
    this.on('error', cb);
  }

  kill(signal?: NodeJS.Signals): void {
    this.killFn(signal);
  }

  /** Push a chunk of text to stdout so ManagedTerminal buffers it. */
  pushOutput(chunk: string): void {
    this.stdout.push(chunk);
  }

  /** Simulate process exit. */
  triggerExit(status: AcpTerminalExit): void {
    this.exitCode = status.exitCode;
    this.emit('exit', status);
    this.stdout.push(null);
    this.stderr.push(null);
  }
}

export class FakeAcpProcessHandle extends EventEmitter implements AcpProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  /** 假 handle 背后没有真进程 ⇒ 明确 null,❌ 不编一个假 pid。 */
  readonly pid: number | null = null;
  readonly kill = vi.fn<(signal?: NodeJS.Signals) => void>();
  /**
   * @@@5405 假 handle 背后没有真树 ⇒ 默认报 0,但它是**可观察**的:退出边必须先收树再把
   * 「进程没了」报出去,而那条顺序只有在能看见这次调用发生在哪一步之前时才判得出来。
   */
  readonly reap = vi.fn<() => Promise<{ reaped: number; pids: number[] }>>(async () => ({
    reaped: 0,
    pids: [],
  }));

  onExit(cb: (exit: { code: number | null; signal: string | null }) => void): void {
    this.on('exit', (code: number | null, signal: string | null = null) =>
      cb({ code, signal })
    );
  }

  onError(cb: (err: Error) => void): void {
    this.on('error', cb);
  }

  emitExit(code: number | null = null, signal: string | null = null): void {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }

  emitError(err: Error): void {
    this.emit('error', err);
  }
}

// Alias for backward compat.
export { FakeAcpProcessHandle as FakeChildProcess };

export const fakeAcpFs: AcpFs = {
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
};

export class FakeAcpProcessHost implements AcpProcessHost {
  readonly fs: AcpFs = fakeAcpFs;
  private readonly handles: FakeAcpProcessHandle[] = [];
  private readonly terminalProcs: FakeAcpTerminalProcess[] = [];
  /** When set, the next spawnTerminal call returns this instance. */
  nextTerminal: FakeAcpTerminalProcess | null = null;
  readonly spawnTerminalFn =
    vi.fn<
      (spec: {
        command: string;
        args: string[];
        env: Record<string, string>;
        cwd: string;
      }) => Promise<AcpTerminalProcess>
    >();

  resolveSpawnContext: Mock = vi.fn().mockResolvedValue({
    cli: '/usr/local/bin/fake-agent',
    agentEnv: {},
  });

  async spawn(_spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpProcessHandle> {
    const handle = new FakeAcpProcessHandle();
    this.handles.push(handle);
    return handle;
  }

  async spawnTerminal(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpTerminalProcess> {
    const proc = this.nextTerminal ?? new FakeAcpTerminalProcess();
    this.nextTerminal = null;
    this.terminalProcs.push(proc);
    this.spawnTerminalFn(spec);
    return proc;
  }

  get lastHandle(): FakeAcpProcessHandle {
    const h = this.handles.at(-1);
    if (!h) throw new Error('FakeAcpProcessHost: no handle spawned yet');
    return h;
  }

  get allHandles(): FakeAcpProcessHandle[] {
    return this.handles;
  }

  get lastTerminalProc(): FakeAcpTerminalProcess {
    const p = this.terminalProcs.at(-1);
    if (!p) throw new Error('FakeAcpProcessHost: no terminal spawned yet');
    return p;
  }

  get allTerminalProcs(): FakeAcpTerminalProcess[] {
    return this.terminalProcs;
  }
}

export class FakePtyProcess implements PtyProcess {
  readonly write = vi.fn<(data: string) => void>();
  readonly resize = vi.fn<(cols: number, rows: number) => void>();
  readonly kill = vi.fn<() => void>();
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly exitHandlers: Array<(info: PtyExitInfo) => void> = [];

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (info: PtyExitInfo) => void): void {
    this.exitHandlers.push(handler);
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(info: PtyExitInfo): void {
    for (const handler of this.exitHandlers) handler(info);
  }
}

export class FakePtySpawner implements PtySpawner {
  readonly specs: PtySpawnSpec[] = [];
  readonly processes: FakePtyProcess[] = [];

  spawn(spec: PtySpawnSpec): PtyProcess {
    this.specs.push(spec);
    const proc = new FakePtyProcess();
    this.processes.push(proc);
    return proc;
  }
}

type AcpHarnessOptions = Partial<AcpRuntimeDeps> & {
  acpBehavior?: IAcpBehavior;
  authProvider?: ResolvedAuthProvider;
  autoApprove?: 'supported' | 'none';
  /** 该家自己声明的原生档 ↔ 咕咕四档对应表。不给 = 没声明表,整条路退回按 id 猜。 */
  autoApproveModes?: ProviderPermissionModeMap;
  bundleAutonomy?: 'native' | 'per-surface-acp' | 'none';
  /** agent 自己报状态:它讲 ACP v2(initialize 答 `protocolVersion: 2`)。 */
  reportsState?: boolean;
};

// Tests that exercise the legacy ACP setter path still declare the capability explicitly.
// Production cells intentionally do not infer this contract when a provider omits it.
const TEST_LIVE_SETTINGS: LiveSettingsCapability = {
  model: {
    channel: 'acp-config-option',
    ack: 'ack',
    busy: 'queue-next-turn',
    reloadRequired: false,
    recovery: 'none',
  },
  permission: {
    channel: 'acp-config-option',
    ack: 'ack',
    busy: 'queue-next-turn',
    reloadRequired: false,
    recovery: 'none',
  },
  effort: {
    channel: 'acp-config-option',
    ack: 'ack',
    busy: 'queue-next-turn',
    reloadRequired: false,
    recovery: 'none',
  },
};

export function testPluginHost(
  options: {
    providerId?: string;
    acpBehavior?: IAcpBehavior;
    authProvider?: ResolvedAuthProvider;
    autoApprove?: 'supported' | 'none';
    autoApproveModes?: ProviderPermissionModeMap;
    /** 该家的 `sessionBundle.units.autonomy` 是否由会话包自己兑现（spawn 时物化）。
     *  `per-surface-acp` = grok 的真实形状：per-surface，只有 acp 那条 native。 */
    bundleAutonomy?: 'native' | 'per-surface-acp' | 'none';
  } = {}
): AgentPluginHost {
  const providerId = options.providerId ?? 'claude';
  const registry = createPluginRegistry<CLIAgentPluginProvider>();

  registry.register({
    metadata: {
      id: providerId,
      name: options.authProvider?.name ?? 'Claude Code',
      description: 'Test provider',
      websiteUrl: 'https://example.com',
    },
    capabilities: {
      acp: options.acpBehavior
        ? {
            kind: 'supported',
            liveSettings: TEST_LIVE_SETTINGS,
          }
        : { kind: 'none', liveSettings: TEST_LIVE_SETTINGS },
      autoApprove: {
        // 缺省不声明权限阶梯:运行时对每个输入都解析出显式档(#7366),假 agent 又不报档位 ——
        // 不声明就没有档要下发。给了档位表(`autoApproveModes`)或显式 `autoApprove: 'supported'` 才算声明。
        kind: options.autoApprove ?? (options.autoApproveModes ? 'supported' : 'none'),
        ...(options.autoApproveModes ? { modes: options.autoApproveModes } : {}),
      },
      auth: options.authProvider?.auth ?? { kind: 'none' },
      hostDependency: {
        binaryNames: [providerId],
        installCommands: {},
        updates: { kind: 'none' },
      },
      sessionBundle: testSessionBundleDescriptor('acp', options.bundleAutonomy),
    },
    behavior: {
      acp: options.acpBehavior,
      auth: options.authProvider?.behavior,
    },
  } as unknown as CLIAgentPluginProvider);

  return new AgentPluginHost({
    scope: createScope({ label: 'test-acp' }),
    registry,
    exec: fakeExec(),
    fs: fakePluginFs(),
    homeDir: '/home/test',
  });
}

function testSessionBundleDescriptor(
  surface: 'acp' | 'tui',
  bundleAutonomy: 'native' | 'per-surface-acp' | 'none' = 'none'
): SessionBundleDescriptor {
  const unverified = {
    kind: 'none',
    degraded: { code: 'unverified', reason: 'Test provider capability is not measured' },
  } as const;
  // grok 的真实形状：per-surface，acp native / tui 未量。扁平读 `.kind` 会把它
  // 误判成不 native（`'per-surface' !== 'native'`）——正是 session-manager 放行闸要经
  // `resolveUnitDelivery` 按腿解析、❌ 别扁平读的原因。
  const perSurfaceAcpNative = {
    kind: 'per-surface',
    surfaces: {
      'acp': { kind: 'native', channel: 'process-config' },
      'tui': unverified,
    },
  } as const;
  const autonomy =
    bundleAutonomy === 'native'
      ? ({ kind: 'native', channel: 'process-config' } as const)
      : bundleAutonomy === 'per-surface-acp'
        ? perSurfaceAcpNative
        : unverified;
  return {
    injectionMode: 'runtime' as const,
    platform: { kind: 'unsupported' as const, reason: 'test provider' },
    surfaces: [surface],
    sessionpage: {
      [surface]: {
        identity: 'none',
        messageTransport: surface === 'acp' ? 'router' : 'local-session',
      },
    },
    units: {
      mcp: unverified,
      env: unverified,
      model: unverified,
      autonomy,
      promptBlocks: unverified,
    },
    extension: unverified,
  };
}

export function makeAcpHarness(options: AcpHarnessOptions = {}) {
  const {
    acpBehavior,
    authProvider,
    autoApprove,
    autoApproveModes,
    bundleAutonomy,
    reportsState,
    ...depOverrides
  } = options;
  const agent = new FakeAcpAgent();
  if (reportsState) {
    agent.initialize.mockResolvedValue({
      protocolVersion: 2,
      agentCapabilities: { loadSession: true },
    });
  }
  const fakeHost = new FakeAcpProcessHost();
  const ptySpawner = new FakePtySpawner();
  const promptQueueSnapshots = new Map<string, readonly QueuedPrompt[]>();

  const deps: AcpRuntimeDeps = {
    agentHost:
      depOverrides.agentHost ??
      testPluginHost({
        acpBehavior: acpBehavior ?? {
          buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
          connect: agent.behavior.connect,
        },
        autoApprove,
        autoApproveModes,
        bundleAutonomy,
        authProvider: authProvider ?? {
          name: 'Claude Code',
          auth: { kind: 'none' },
        },
      }),
    host: fakeHost,
    resolveAttachment: vi.fn().mockResolvedValue({ data: '', mimeType: 'image/png' }),
    logger: noopLogger,
    promptQueueStore: {
      load: (sessionId) => promptQueueSnapshots.get(sessionId) ?? [],
      save: (sessionId, prompts) => promptQueueSnapshots.set(sessionId, structuredClone(prompts)),
      clear: (sessionId) => promptQueueSnapshots.delete(sessionId),
    },
    ...depOverrides,
  };

  return {
    deps,
    fakeHost,
    get lastChild(): FakeAcpProcessHandle {
      return fakeHost.lastHandle;
    },
    get children(): FakeAcpProcessHandle[] {
      return fakeHost.allHandles;
    },
    agent,
    ptySpawner,
    client(): Client {
      if (!agent.capturedClient) {
        throw new Error('capturedClient is null — has startSession() been called?');
      }
      return agent.capturedClient;
    },
  };
}

function fakeExec(): IExecutionContext {
  return {
    supportsLocalSpawn: false,
    async exec() {
      throw new Error('missing');
    },
    async execStreaming() {},
    dispose() {},
  };
}

function fakePluginFs() {
  return {
    async read() {
      return null;
    },
    async write() {},
    async delete() {},
    async exists() {
      return false;
    },
    async list() {
      return [];
    },
  };
}

/**
 * 等一条会话的列表摘要满足条件:先判一次,之后运行时每往会话列表推一条更新就重判 —— 生命周期、排队数、
 * 待决权限数、上一轮结局、失败都随摘要一起发布(`publishSummary`)。等的是运行时自己推出的更新,
 * ❌ vi.waitFor 的期限。条件写「到了 / 至少」,确切值由调用方之后用 expect 断言。
 */
export async function untilSessionSummary(
  runtime: Pick<AcpRuntime, 'sessionsListLiveModel'>,
  sessionId: string,
  step: string,
  holds: (summary: SessionSummary | undefined) => boolean
): Promise<void> {
  const list = runtime.sessionsListLiveModel().states.list;
  const read = () => list.snapshot().data[sessionId] as SessionSummary | undefined;
  let notify = () => {};
  const unsubscribe = list.subscribe(() => notify());
  try {
    await awaitPending(
      `${sessionId}: ${step}`,
      (async () => {
        for (;;) {
          const changed = new Promise<void>((resolve) => (notify = resolve));
          if (holds(read())) return;
          await changed;
        }
      })()
    );
  } finally {
    unsubscribe();
  }
}

export function makeStartInput(
  overrides: Partial<AcpStartInput> & { sessionId?: string } = {}
): AcpStartInput {
  return {
    sessionId: overrides.sessionId ?? 'conv-1',
    projectId: 'proj-1',
    providerId: 'claude',
    workspaceId: 'ws-1',
    cwd: '/tmp/workspace',
    providerSessionId: null,
    model: null,
    runContext: {
      cli: { kind: 'resolved', path: '/usr/local/bin/claude' },
      env: { HOME: '/home/test', PATH: '/bin' },
      configRootEnv: {},
      selfUpdateEnv: {},
      extraArgs: [],
    },
    ...overrides,
  };
}
