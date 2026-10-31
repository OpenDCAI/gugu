import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../../tests/support/awaitCondition';
import {
  CODEX_GUGU_CAPABILITY_PACKAGE,
  materializeCodexSessionBundle,
  pluginRegistry,
} from '@gugu/session-plugins/agents';
import { buildSessionTuiSessionBundle } from '../../../../../capability-bundle';
import { SessionPtySupervisor } from '@main/core/sessions/session-pty-supervisor';
import type { Pty, PtyExitInfo } from '@main/core/pty/pty';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import type { Session } from '@shared/core/sessions/sessions';
import { ptyExitChannel } from '@shared/core/pty/ptyEvents';
import { sessionDeliveryFailedChannel } from '@shared/core/sessions/sessionEvents';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import {
  setLocalSessionDeliveryBridge,
  unregisterLocalSessionDelivery,
} from '@main/core/sessionpage/local-session-delivery';
import {
  createLocalSessionDeliveryBridge,
  localSessionDeliveryTarget,
  registerOfflineLocalSessionDelivery,
} from '../../../../../sessionpage/local-session-delivery';
import {
  setEmdashPtySessionpageHook,
  setEmdashPtySessionpageTeardown,
  type EmdashPtySessionpageStartInfo,
} from './emdash-pty-sessionpage-hook';
import { LocalSessionProvider } from './local-session';
import { resolveHarnessConnection } from '@main/core/agents/harness-connections';

const spawnLocalPty = vi.hoisted(() => vi.fn());
const resolveLocalPtySpawnMock = vi.hoisted(() => vi.fn());
const buildCommandMock = vi.hoisted(() =>
  vi.fn((_ctx: Record<string, unknown>) => ({
    command: 'agent',
    args: [] as string[],
    env: {} as Record<string, string>,
  }))
);
const installPluginMock = vi.hoisted(() => vi.fn(async () => []));
const writeHooksMock = vi.hoisted(() => vi.fn(async () => []));
const recordProviderContinuationIntentMock = vi.hoisted(() => vi.fn(async () => undefined));
const injectSessionMessageWhenReadyMock = vi.hoisted(() => vi.fn());
const injectSystemBootstrapWhenReadyMock = vi.hoisted(() => vi.fn());
const localAgentForSessionMock = vi.hoisted(() => vi.fn());
const forkSessionInStorageMock = vi.hoisted(() => vi.fn(async () => ({ providerSessionId: 'storage-child-session' })));
const setProviderSessionIdMock = vi.hoisted(() => vi.fn(async () => ({ success: true as const })));
const recordRuntimeForkOwnershipMock = vi.hoisted(() => vi.fn(async () => undefined));
const setPtyStartupGateMock = vi.hoisted(() => vi.fn());
type AgentSessionUpdate = {
  sourceId: string;
  sessionId: string;
  projectId: string;
  providerId: string;
  providerSessionId: string;
};
const agentSessionListeners = vi.hoisted(
  () => new Set<(input: AgentSessionUpdate) => void>()
);
/** The hook source id handed to the most recent spawn (the mock mints `source-<ptyId>`). */
function currentHookSourceId(): string {
  const results = vi.mocked(agentHookService.createSource).mock.results;
  return (results.at(-1)?.value as { id: string }).id;
}

vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: setProviderSessionIdMock }));

vi.mock('../runtime-fork-ownership', () => ({
  recordRuntimeForkOwnership: recordRuntimeForkOwnershipMock,
  closeRuntimeForkOwnershipForRuntimeSession: vi.fn(async () => undefined),
}));

vi.mock('@main/core/sessions/provider-continuation-intent', () => ({
  recordProviderContinuationIntent: recordProviderContinuationIntentMock,
}));

vi.mock('@main/core/dependencies/host-dependency-store', () => ({
  hostDependencyStore: {
    getSelection: vi.fn().mockResolvedValue(null),
    setSelection: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: {
    on: vi.fn(() => () => {}),
    settleSessionExited: vi.fn(async () => undefined),
    reportProviderReviewGate: vi.fn(),
    reportProviderBlocker: vi.fn(),
  },
}));

vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  providerSupportsNativeStartHook: vi.fn(() => false),
  agentHookService: {
    emitAgentEvent: vi.fn(),
    getPort: vi.fn(() => 0),
    createSource: vi.fn((ptyId: string) => ({ id: `source-${ptyId}`, token: 'token', dispose: vi.fn(), keepAcrossRestart: vi.fn() })),
    takeRestoredSource: vi.fn(() => undefined),
    on: vi.fn((name: string, listener: (input: AgentSessionUpdate) => void) => {
      if (name !== 'agent:session') return () => {};
      agentSessionListeners.add(listener);
      return () => agentSessionListeners.delete(listener);
    }),
  },
}));

vi.mock('@main/core/agents/workspace-trust', () => ({
  workspaceTrustService: {
    maybeAutoTrust: vi.fn(),
  },
}));

// @@@2503 spawn 时会读这个会话的 composer 模型选择(真读库)。这个文件测的是 hook 与 respawn,
// 没有迁移过的库,所以只桩掉这一次读:它自己的语义有 platform-model-selection.db.test.ts 覆盖。
vi.mock('@main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: vi.fn(async () => undefined),
  // 非平台会话(上面恒 undefined)下,启动档位原样透传 —— 与真实实现在这一格等价。
}));

// This lifecycle fixture has no persisted sessions; connection binding is covered by the DB suite.
vi.mock('@main/core/agents/harness-connections', () => ({
  resolveHarnessConnection: vi.fn(async () => ({ connectionId: 'native' })),
}));

vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn((id: string) => ({
    metadata: { id },
    capabilities: {
      hostDependency: { binaryNames: [id] },
      sessionBundle: {
        surfaces: id === 'opencode'
          ? ['acp', 'tui']
          : id === 'codex'
            ? ['acp', 'app-server']
            : ['tui'],
        sessionpage: id === 'droid' || id === 'antigravity'
          ? { 'tui': { identity: 'addressable', messageTransport: 'local-session' } }
          : id === 'opencode'
            ? {
                'tui': {
                  identity: 'addressable',
                  messageTransport: 'router',
                  hostAdapter: 'opencode-serve-attach-v1',
                },
              }
            : { 'tui': { identity: 'addressable', messageTransport: 'router' } },
        units: {
          mcp: { kind: 'none', degraded: { code: 'unverified', reason: 'test fixture' } },
          env: { kind: 'none', degraded: { code: 'unverified', reason: 'test fixture' } },
          model: { kind: 'none', degraded: { code: 'unverified', reason: 'test fixture' } },
          autonomy: { kind: 'none', degraded: { code: 'unverified', reason: 'test fixture' } },
          promptBlocks: { kind: 'none', degraded: { code: 'unverified', reason: 'test fixture' } },
        },
        extension: id === 'opencode'
          ? {
              kind: 'event-module',
              format: 'opencode',
              scope: 'workspace',
              carries: { mcp: 'none', skills: 'none', systemPrompt: 'none', hooks: 'module' },
            }
          : { kind: 'none', degraded: { code: 'unverified', reason: 'test fixture' } },
      },
      hooks:
        id === 'opencode'
          ? { kind: 'plugin', scope: 'workspace', supportedEvents: [] }
          : id === 'codex'
            ? { kind: 'config', scope: 'session', channel: 'session-argv', evidence: 'https://example.test/codex', supportedEvents: [] }
            : id === 'claude'
              ? { kind: 'config', scope: 'workspace', supportedEvents: [] }
              : { kind: 'none' },
      prompt: {
        kind: id === 'zero' ? 'keystroke' : 'argv',
        ...(id === 'zero' ? {} : { flag: '' }),
        // 首句等宿主就绪之后经 local-session 注入的家(Antigravity 终端腿)。
        ...(id === 'antigravity' ? { startupDelivery: 'delivery-bridge' } : {}),
      },
      sessions: { kind: 'resumable', fork: 'supported', childId: id === 'claude' ? 'provider-minted' : undefined },
    },
    behavior: {
      prompt: { buildCommand: buildCommandMock },
      // 命令行上没有分叉参数、在自己存档上分叉的家(Antigravity 终端腿)。
      ...(id === 'antigravity' ? { sessions: { forkSessionInStorage: forkSessionInStorageMock } } : {}),
      hooks: {
        writeHooks: writeHooksMock,
        deleteHooks: vi.fn(),
        readHooks: vi.fn(),
        getHooksInstalled: vi.fn(),
      },
      plugins: {
        installPlugin: installPluginMock,
        uninstallPlugin: vi.fn(),
        isPluginInstalled: vi.fn(),
        getPluginVersion: vi.fn(),
        getPluginPath: vi.fn(),
      },
    },
  })),
}));

vi.mock('@main/core/agents/plugin-fs', () => ({
  createPluginFs: vi.fn(() => ({
    read: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    list: vi.fn(async () => []),
  })),
}));

vi.mock('@main/core/pty/local-pty', () => ({
  spawnLocalPty,
}));

vi.mock('@main/core/pty/terminal-color-scheme', () => ({
  getTerminalColorEnv: vi.fn(async () => ({ COLORFGBG: '0;15' })),
}));

vi.mock('@main/core/pty/pty-spawn-platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/core/pty/pty-spawn-platform')>();
  return {
    ...actual,
    resolveLocalPtySpawn: (...args: Parameters<typeof actual.resolveLocalPtySpawn>) => {
      resolveLocalPtySpawnMock(...args);
      return actual.resolveLocalPtySpawn(...args);
    },
  };
});

vi.mock('./keystroke-injection', () => ({
  injectSessionMessageWhenReady: injectSessionMessageWhenReadyMock,
  injectSystemBootstrapWhenReady: injectSystemBootstrapWhenReadyMock,
  setPtyStartupGate: setPtyStartupGateMock,
  planSystemBootstrap: (
    text: string | undefined,
    transport: 'argv' | 'stdin-pipe' | 'keystroke' | 'none',
  ) => {
    if (!text?.trim()) return {};
    if (transport === 'none') throw new Error('system bootstrap requires a declared prompt transport');
    return transport === 'keystroke' ? { readyText: text } : { commandText: text };
  },
}));

vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({
  localAgentForSession: localAgentForSessionMock,
}));

vi.mock('@main/lib/events', () => ({
  events: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}));

vi.mock('@main/core/settings/provider-settings-service', () => ({
  providerOverrideSettings: {
    getItem: vi.fn(async () => undefined),
  },
}));

vi.mock('@main/core/dependencies/dependency-managers', () => ({
  localDependencyManager: {
    get: vi.fn(() => undefined),
    getHostDependency: vi.fn(() => undefined),
  },
  getDependencyManager: vi.fn(async () => ({
    get: vi.fn(() => undefined),
    getHostDependency: vi.fn(() => undefined),
  })),
}));

vi.mock('./resolve-agent-executable', () => ({
  resolveAgentExecutable: vi.fn(async ({ binaryName }: { binaryName: string }) => binaryName),
  clearResolvedPathCache: vi.fn(),
}));

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: {
    get: vi.fn(async (key: string) =>
      key === 'terminal'
        ? {
            autoCopyOnSelection: false,
            macOptionIsMeta: false,
            defaultShell: 'system',
            fontSize: 13,
          }
        : {
            defaultProjectsDirectory: '',
            defaultWorktreeDirectory: '',
            writeAgentConfigToGitIgnore: true,
          }
    ),
  },
}));

const { events } = await import('@main/lib/events');
const { agentHookService } = await import('@main/core/agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('@main/core/agent-status/agent-status-writer');
const { appSettingsService } = await import('@main/core/settings/settings-service');
const { providerOverrideSettings } = await import('@main/core/settings/provider-settings-service');
const { workspaceTrustService } = await import('@main/core/agents/workspace-trust');

type RespawnState = {
  knownPtySessionIds: Set<string>;
  ptysBySession: Map<string, Pty>;
};

const activeProviders = new Set<LocalSessionProvider>();

function testExecutionContext(supportsLocalSpawn: boolean) {
  return {
    supportsLocalSpawn,
    exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as never;
}

function localProvider({
  tmux = false,
  shellProfile = {
    id: 'sh',
    resolvedShellId: 'sh',
    resolvedFromSystem: true,
    executable: 'sh',
    available: true,
    family: 'posix',
    interactiveArgs: ['-i'],
    commandArgs: ['-c'],
  },
  ctx = testExecutionContext(true),
}: {
  tmux?: boolean;
  shellProfile?: ConstructorParameters<typeof LocalSessionProvider>[0]['shellProfile'];
  ctx?: ConstructorParameters<typeof LocalSessionProvider>[0]['ctx'];
} = {}) {
  const provider = new LocalSessionProvider({
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    sessionPath: '/tmp/ws-1',
    tmux,
    shellProfile,
    ctx,
  });
  activeProviders.add(provider);
  return provider;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'conversation-1',
    projectId: 'project-1',
    providerId: 'codex',
    title: 'Conversation 1',
    lastInteractedAt: null,
    providerSessionId: 'provider-session-1',
    ...overrides,
  };
}

function fakePty(exitHandlers: Array<(info: PtyExitInfo) => void>): Pty {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((handler) => exitHandlers.push(handler)),
  };
}

function mockSettings(): void {
  vi.mocked(appSettingsService.get).mockImplementation(async (key) => {
    if (key === 'localProject') {
      return {
        defaultProjectsDirectory: '',
        defaultWorktreeDirectory: '',
        writeAgentConfigToGitIgnore: true,
      } as never;
    }
    throw new Error(`Unexpected settings key: ${key}`);
  });
}

describe('conversation provider respawn state', () => {
  beforeEach(() => {
    // The real Electron host installs this callback before PTY startup. Wire the same host-owned registry
    // explicitly in this unit because session/main and electron/sessionpage are separate bundles.
    setLocalSessionDeliveryBridge(createLocalSessionDeliveryBridge());
    vi.useRealTimers();
    spawnLocalPty.mockReset();
    resolveLocalPtySpawnMock.mockReset();
    buildCommandMock.mockReset();
    buildCommandMock.mockReturnValue({ command: 'agent', args: [], env: {} });
    forkSessionInStorageMock.mockClear();
    setPtyStartupGateMock.mockClear();
    setProviderSessionIdMock.mockClear();
    recordRuntimeForkOwnershipMock.mockClear();
    installPluginMock.mockReset();
    installPluginMock.mockResolvedValue([]);
    writeHooksMock.mockReset();
    writeHooksMock.mockResolvedValue([]);
    recordProviderContinuationIntentMock.mockReset();
    recordProviderContinuationIntentMock.mockResolvedValue(undefined);
    injectSessionMessageWhenReadyMock.mockReset();
    injectSystemBootstrapWhenReadyMock.mockReset();
    localAgentForSessionMock.mockReset();
    localAgentForSessionMock.mockResolvedValue(null);
    vi.mocked(workspaceTrustService.maybeAutoTrust).mockReset();
    vi.mocked(workspaceTrustService.maybeAutoTrust).mockResolvedValue({ env: {}, args: [] });
    agentSessionListeners.clear();
    mockSettings();
    vi.mocked(providerOverrideSettings.getItem).mockReset();
    vi.mocked(providerOverrideSettings.getItem).mockResolvedValue(undefined as never);
    vi.mocked(events.emit).mockClear();
    vi.mocked(agentHookService.emitAgentEvent).mockClear();
    vi.mocked(agentStatusWriter.settleSessionExited).mockClear();
    vi.mocked(agentHookService.getPort).mockReturnValue(0);
    setEmdashPtySessionpageHook(null);
    setEmdashPtySessionpageTeardown(null);
    ptySessionRegistry.unregister('project-1:conversation-1:conversation-1');
    ptySessionRegistry.unregister('project-1:claude-conversation:claude-conversation');
    unregisterLocalSessionDelivery('droid-conversation');
  });

  afterEach(async () => {
    await Promise.all(Array.from(activeProviders, (provider) => provider.destroyAll()));
    activeProviders.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(['claude', 'codex'] as const)('%s model restarts keep the bound account in the real PTY spawn environment', async (providerId) => {
    const item = session({ id: `${providerId}-bound-account`, providerId });
    const key = providerId === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const binding = async (_provider: string, input: { sessionId?: string } = {}) => ({
      connectionId: 'original', configRootEnv: { [key]: input.sessionId === item.id ? '/accounts/original' : '/accounts/current' },
      unsetEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    });
    vi.mocked(resolveHarnessConnection).mockImplementationOnce(binding).mockImplementationOnce(binding);
    spawnLocalPty.mockReturnValue(fakePty([]));
    const provider = localProvider();
    await provider.startSession(item, undefined, true);
    await provider.stopSession(item.id);
    await provider.startSession({ ...item, model: 'changed-model' }, undefined, true);
    expect(spawnLocalPty).toHaveBeenCalledTimes(2);
    for (const [request] of spawnLocalPty.mock.calls) expect(request.env[key]).toBe('/accounts/original');
  });

  it('registers a task-TUI local-session owner and preserves the offline blocker through stop/detach', async () => {
    localAgentForSessionMock.mockResolvedValue({ gugu_user_id: 'agent-droid', cache: {} });
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const pty = fakePty(exitHandlers);
    spawnLocalPty.mockReturnValue(pty);
    const provider = localProvider();
    const item = session({ id: 'droid-conversation', providerId: 'droid' });

    await provider.startSession(item);
    // 绑定 roster 身份是启动就绪的一部分(startSession 等它完成才返回)⇒ 一返回就该在,不用轮询。
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
    exitHandlers[0]?.({ exitCode: 0 });
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
    await expect(localSessionDeliveryTarget.tryInjectSessionMessage?.(item.id, {
      id: 'between-generations',
      text: 'must remain pending',
    })).resolves.toBe(false);
    await provider.stopSession(item.id);
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);

    await provider.startSession(item);
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
    await provider.detachSession(item.id);
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
    await expect(localSessionDeliveryTarget.tryInjectSessionMessage?.(item.id, {
      id: 'while-detached',
      text: 'must remain pending while detached',
    })).resolves.toBe(false);

    await provider.startSession(item);
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
    await provider.stopSession(item.id);
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
  });

  it('fails task-TUI readiness when the local-session roster binding cannot be resolved', async () => {
    registerOfflineLocalSessionDelivery('agent-droid', {
      sessionId: 'droid-conversation',
      providerId: 'droid',
    });
    localAgentForSessionMock.mockRejectedValue(new Error('roster unavailable'));
    const pty = fakePty([]);
    spawnLocalPty.mockReturnValue(pty);
    const provider = localProvider();
    const item = session({ id: 'droid-conversation', providerId: 'droid' });

    await expect(provider.startSession(item)).rejects.toThrow('roster unavailable');
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
  });

  // #6183: 新建任务时会话页那次 hydrate 是后到者 —— 它必须拿到在飞那次启动的结局,❌ 一个假的「起来了」。
  it('a caller that arrives while a start is in flight gets that start\'s outcome', async () => {
    const trustCheck = Promise.withResolvers<never>();
    const trustAsked = Promise.withResolvers<void>();
    vi.mocked(workspaceTrustService.maybeAutoTrust).mockImplementationOnce(() => {
      trustAsked.resolve();
      return trustCheck.promise;
    });
    const provider = localProvider();
    const item = session();

    const first = provider.startSession(item);
    const second = provider.startSession(item);
    await trustAsked.promise;
    trustCheck.reject(new Error('engine check failed'));

    await expect(first).rejects.toThrow('engine check failed');
    await expect(second).rejects.toThrow('engine check failed');
    expect(spawnLocalPty).not.toHaveBeenCalled();
  });

  // 只加入仍然当前的那次:stop() 之后的启动(换模型重开)要真的起,❌ 加入那次被取消的。
  it('a start issued after stop() is a new start, not a join of the cancelled one', async () => {
    const trustCheck = Promise.withResolvers<{ env: Record<string, string>; args: string[] }>();
    const trustAsked = Promise.withResolvers<void>();
    vi.mocked(workspaceTrustService.maybeAutoTrust).mockImplementationOnce(() => {
      trustAsked.resolve();
      return trustCheck.promise as never;
    });
    spawnLocalPty.mockReturnValue(fakePty([]));
    const provider = localProvider();
    const item = session();

    const first = provider.startSession(item);
    await trustAsked.promise;
    await provider.stopSession(item.id);
    await provider.startSession(item);

    expect(spawnLocalPty).toHaveBeenCalledTimes(1);
    trustCheck.resolve({ env: {}, args: [] });
    await first.catch(() => undefined);
  });

  it('does not stop a replacement generation when the prior PTY exits during roster readiness', async () => {
    let releaseRoster!: (value: unknown) => void;
    const rosterPending = new Promise((resolve) => { releaseRoster = resolve; });
    const rosterAsked = Promise.withResolvers<void>();
    localAgentForSessionMock
      .mockImplementationOnce(() => {
        rosterAsked.resolve();
        return rosterPending;
      })
      .mockResolvedValue({ gugu_user_id: 'agent-droid', cache: {} });
    const firstExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const secondExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const firstPty = fakePty(firstExitHandlers);
    const secondPty = fakePty(secondExitHandlers);
    spawnLocalPty.mockReturnValueOnce(firstPty).mockReturnValueOnce(secondPty);
    const provider = localProvider();
    const item = session({ id: 'droid-conversation', providerId: 'droid' });

    const starting = provider.startSession(item);
    // 第一代已经 spawn、正在等 roster 身份:这时让它的 PTY 退出。
    await rosterAsked.promise;
    firstExitHandlers[0]?.({ exitCode: 0 });
    releaseRoster(null);
    await expect(starting).rejects.toThrow('became stale');
    // 替身在 respawn 延时之后才起,起来的就绪包含把身份绑回 roster;没有事件可等,轮询这个事实。
    await until(
      'replacement generation binds its roster identity',
      () => localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid'),
      (ptySessionId) => ptySessionId === item.id,
    );
  });

  it.each([
    ['local', () => localProvider()],
  ] as const)('%s provider forwards the stable message id and exact adapter receipt', async (_name, makeProvider) => {
    const pty = fakePty([]);
    spawnLocalPty.mockReturnValue(pty);
    injectSessionMessageWhenReadyMock.mockResolvedValue({
      status: 'accepted',
      messageId: 'message-stable-1',
    });
    const provider = makeProvider();
    const item = session();
    await provider.startSession(item);

    await expect(provider.sendMessage(item, {
      id: 'message-stable-1',
      text: 'ordinary message',
    })).resolves.toEqual({ status: 'accepted', messageId: 'message-stable-1' });
    expect(injectSessionMessageWhenReadyMock).toHaveBeenCalledWith({
      pty,
      session: item,
      message: { id: 'message-stable-1', text: 'ordinary message' },
    });
  });

  it('keystroke bootstrap bypasses command bytes and injects exactly once after ready', async () => {
    const pty = fakePty([]);
    spawnLocalPty.mockReturnValue(pty);
    const provider = localProvider();
    const item = session({ providerId: 'zero' });

    await provider.startSession(item, undefined, false, 'system bootstrap');

    expect(buildCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialPrompt: undefined }),
    );
    expect(injectSystemBootstrapWhenReadyMock).toHaveBeenCalledWith({
      pty,
      session: item,
      text: 'system bootstrap',
      projectPath: '/tmp/ws-1',
    });
  });

  // @@@2503 spec 红线:平台会话不得回落到用户自己的 Key。宿主注入的 env 是平台中转凭据,
  // 用户在 provider 设置 / 任务级 env 里存的老 BYOK 变量绝不能盖过它 —— 盖过去就是「界面写着
  // 咕咕的模型、实际花用户自己的 Key」,而且账单上看不出来。
  it('lets the host injection win over the user\'s own env vars', async () => {
    vi.mocked(providerOverrideSettings.getItem).mockResolvedValue({
      env: { ANTHROPIC_API_KEY: 'user-own-key', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    } as never);
    spawnLocalPty.mockReturnValue(fakePty([]));
    setEmdashPtySessionpageHook(async (info) => ({
      command: info.baseCommand,
      args: info.baseArgs,
      env: {
        ANTHROPIC_BASE_URL: 'https://relay.example',
        ANTHROPIC_AUTH_TOKEN: 'sk-session',
        ANTHROPIC_API_KEY: '',
      },
    }));

    await localProvider().startSession(session());

    const request = spawnLocalPty.mock.calls[0][0] as { env: Record<string, string> };
    expect(request.env.ANTHROPIC_BASE_URL).toBe('https://relay.example');
    expect(request.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-session');
    // 空串是刻意的:用户的 Key 必须被压掉,而不是「没被设置」。
    expect(request.env.ANTHROPIC_API_KEY).toBe('');
  });

  it('still lets user env through when the host injects nothing for that key', async () => {
    // 反面对照:没有这条,一个「把 customEnv 整个丢掉」的实现也能让上面那条变绿 —— 而它会把
    // 用户配的代理、镜像源等设置一并抹掉。
    vi.mocked(providerOverrideSettings.getItem).mockResolvedValue({
      env: { HTTPS_PROXY: 'http://proxy.local:8080' },
    } as never);
    spawnLocalPty.mockReturnValue(fakePty([]));
    setEmdashPtySessionpageHook(async (info) => ({
      command: info.baseCommand,
      args: info.baseArgs,
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-session' },
    }));

    await localProvider().startSession(session());

    const request = spawnLocalPty.mock.calls[0][0] as { env: Record<string, string> };
    expect(request.env.HTTPS_PROXY).toBe('http://proxy.local:8080');
    expect(request.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-session');
  });

  it('delivers the exact taskpage hook argv and env to the PTY launch boundary', async () => {
    const prompt = '<gugu_platform>P</gugu_platform>\n<agent_identity>A</agent_identity>\n';
    expect(prompt).toHaveLength(68);
    buildCommandMock.mockReturnValue({
      command: 'claude',
      args: ['--session-id', 'provider-session-1'],
      env: {},
    });
    spawnLocalPty.mockReturnValue(fakePty([]));
    setEmdashPtySessionpageHook(async (info) => ({
      command: info.baseCommand,
      args: [...info.baseArgs, '--append-system-prompt', prompt],
      env: { GUGU_TUI_LAUNCH_PROMPT_PROBE: prompt },
    }));

    await localProvider().startSession(session({ providerId: 'claude' }));

    expect(resolveLocalPtySpawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          command: {
            kind: 'argv',
            command: 'claude',
            args: ['--session-id', 'provider-session-1', '--append-system-prompt', prompt],
          },
        }),
      }),
    );
    const request = spawnLocalPty.mock.calls[0][0] as { env: Record<string, string> };
    expect(request.env.GUGU_TUI_LAUNCH_PROMPT_PROBE).toBe(prompt);
  });

  it('carries the selected permission mode to Codex thread-start materialization', async () => {
    let hookInfo: EmdashPtySessionpageStartInfo | undefined;
    let threadStart: Readonly<Record<string, unknown>> | undefined;
    setEmdashPtySessionpageHook(async (info) => {
      hookInfo = info;
      const materialized = materializeCodexSessionBundle(
        { surface: 'app-server', lifecycle: 'fresh', cwd: info.cwd },
        {
          mcpServers: [],
          env: { GUGU_HOME: '/tmp/codex-permission-mode-transport-home' },
          model: null,
          autonomy: {
            mode: info.permissionMode === 'full-access' ? 'full-access' : 'approval-required',
            ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
          },
          promptBlocks: {},
          packages: [CODEX_GUGU_CAPABILITY_PACKAGE],
        },
      );
      threadStart = materialized.threadStart;
      return { command: info.baseCommand, args: materialized.argsAppend as string[] };
    });
    spawnLocalPty.mockReturnValue(fakePty([]));

    await localProvider().startSession(
      session({ permissionMode: 'read-only' }),
    );

    expect(hookInfo).toEqual(expect.objectContaining({
      permissionMode: 'read-only',
    }));
    const spawnArgs = spawnLocalPty.mock.calls[0]?.[0]?.args as string[];
    expect(threadStart).toEqual({ approvalPolicy: 'never', sandbox: 'read-only' });
    expect(spawnArgs.join(' ')).not.toMatch(/default_permissions|approval_policy|sandbox_mode/);
  });

  it('carries read-only from the conversation hook through the OpenCode serve bundle into config', async () => {
    let hookInfo: EmdashPtySessionpageStartInfo | undefined;
    let bundlePermissionMode: string | undefined;
    setEmdashPtySessionpageHook(async (info) => {
      hookInfo = info;
      const bundle = await buildSessionTuiSessionBundle({
        bootstrap: {
          runtime: { authProvider: {} as never, env: {} },
          sessionKey: info.sessionId,
          model: null,
          autonomy: {
            mode: info.permissionMode === 'full-access' ? 'full-access' : 'approval-required',
            ...(info.permissionMode !== undefined ? { permissionMode: info.permissionMode } : {}),
          },
          promptBlocks: {},
        },
        identity: null,
      });
      bundlePermissionMode = bundle.autonomy?.permissionMode;
      const materializer = pluginRegistry.get('opencode')?.behavior.sessionBundle?.materialize;
      if (!materializer) throw new Error('OpenCode session bundle materializer is unavailable');
      const materialized = materializer(
        { surface: 'tui', lifecycle: 'fresh', cwd: info.cwd },
        bundle,
      );
      return {
        command: info.baseCommand,
        args: info.baseArgs,
        env: materialized.env,
      };
    });
    spawnLocalPty.mockReturnValue(fakePty([]));

    await localProvider().startSession(
      session({ providerId: 'opencode', permissionMode: 'read-only' }),
    );

    expect(hookInfo).toEqual(expect.objectContaining({
      permissionMode: 'read-only',
    }));
    // Continuous chain: Conversation selection -> sessionpage hook -> session bundle -> provider
    // materializer. Removing the hook's conditional spread or the materializer's permission map
    // makes the assertions below fail; neither an unrelated DB field nor renderer state can mask it.
    expect(bundlePermissionMode).toBe('read-only');
    const env = spawnLocalPty.mock.calls[0]?.[0]?.env as Record<string, string>;
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      permission?: Record<string, string>;
    };
    expect(config.permission).toMatchObject({ edit: 'deny', bash: 'ask' });
  });

  // #6183 合同变更:显式停止取消了在飞的启动 ⇒ 等这次启动的人拿到「取消」与位置(等了多久、最后走完哪一步),
  // ❌ 拿到一个「起来了」(界面会停在「正在启动会话…」永远转)。它仍然**不是**一次 agent 启动失败:不发 error 事件。
  it('a start cancelled by an explicit stop rejects with where it was cancelled, without reporting a spawn failure', async () => {
    let rejectHook!: (error: Error) => void;
    let markHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      markHookStarted = resolve;
    });
    const hookPaused = new Promise<never>((_resolve, reject) => {
      rejectHook = reject;
    });
    const teardown = vi.fn(async () => undefined);
    setEmdashPtySessionpageTeardown(teardown);
    setEmdashPtySessionpageHook(async () => {
      markHookStarted();
      return hookPaused;
    });
    const provider = localProvider();
    const item = session();

    const starting = provider.startSession(item);
    await hookStarted;
    await provider.stopSession(item.id);
    rejectHook(new Error(`[sessionpage] codex session ${item.id} stopped during startup`));

    await expect(starting).rejects.toThrow(
      /^Start cancelled after [\d.]+s \(last completed step: [\w+-]+\): \[sessionpage\] codex session conversation-1 stopped during startup$/
    );
    expect(agentHookService.emitAgentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('stops after a resumed process exits normally without creating a fresh thread', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
      const provider = localProvider();
      const item = session();

      await provider.startSession(item, undefined, true);
      for (const handler of exitHandlers) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(spawnLocalPty).toHaveBeenCalledTimes(1);
      expect(agentStatusWriter.settleSessionExited).toHaveBeenCalledWith({ sessionId: item.id });
      expect(agentHookService.emitAgentEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows an explicit retry of the same thread after resume fails', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
      const provider = localProvider();
      const item = session();

      await provider.startSession(item, undefined, true);
      for (const handler of [...exitHandlers]) handler({ exitCode: 1 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(spawnLocalPty).toHaveBeenCalledTimes(1);

      await provider.startSession(item, undefined, true);
      expect(buildCommandMock.mock.calls.map(([args]) => [args.isResuming, args.providerSessionId]))
        .toEqual([[true, item.providerSessionId], [true, item.providerSessionId]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits PTY exit when a local conversation unregisters before the registry exit handler runs', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const exitInfo = { exitCode: 0 };
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const provider = localProvider();
    const item = session();
    const ptySessionId = makePtySessionId(item.projectId, item.id, item.id);

    await provider.startSession(item);
    vi.mocked(events.emit).mockClear();
    for (const handler of exitHandlers) handler(exitInfo);

    expect(events.emit).toHaveBeenCalledWith(ptyExitChannel, exitInfo, ptySessionId);
  });

  it('resumes a native-id local fork with the provider session id reported by its hook', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      const item = session({ providerId: 'codex', providerSessionId: undefined });
      const forkSessionId = 'provider-session-child';

      await provider.startSession(item, undefined, false, undefined, 'source-codex-session');
      for (const listener of agentSessionListeners) {
        listener({
          sourceId: currentHookSourceId(),
          sessionId: item.id,
          projectId: item.projectId,
          providerId: item.providerId,
          providerSessionId: forkSessionId,
        });
      }
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(buildCommandMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          forkFromProviderSessionId: 'source-codex-session',
          initialPrompt: undefined,
          isResuming: false,
        })
      );
      expect(buildCommandMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          forkFromProviderSessionId: undefined,
          isResuming: true,
          providerSessionId: forkSessionId,
          cliSessionId: forkSessionId,
        })
      );
      // The exited spawn's listener is gone; the one left belongs to the replacement.
      expect(agentSessionListeners.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a plain local spawn with the native session id its hook reported after spawn', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      // copilot / qwen shape: no id at spawn, the provider reports its own through the session hook.
      const item = session({ providerId: 'copilot', providerSessionId: undefined });

      await provider.startSession(item);
      const firstSource = currentHookSourceId();
      const report = (sourceId: string, providerSessionId: string) => {
        for (const listener of agentSessionListeners) {
          listener({
            sourceId,
            sessionId: item.id,
            projectId: item.projectId,
            providerId: item.providerId,
            providerSessionId,
          });
        }
      };
      report(firstSource, 'provider-session-native');
      // Arrives last on purpose: without the source filter it would overwrite the real id.
      report('source-retired', 'provider-session-stale');
      for (const handler of exitHandlers[0] ?? []) handler({ exitCode: 1 });
      await vi.advanceTimersByTimeAsync(500);

      expect(buildCommandMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ isResuming: true, providerSessionId: 'provider-session-native' })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a local-session startup turn out of argv, gates the PTY on the host readiness fact, and injects it the same way as later messages', async () => {
    localAgentForSessionMock.mockResolvedValue({ gugu_user_id: 'agent-agy', cache: {} });
    injectSessionMessageWhenReadyMock.mockResolvedValue({ status: 'accepted', messageId: 'x' });
    const pty = fakePty([]);
    spawnLocalPty.mockReturnValue(pty);
    const startupGate = new Promise<void>(() => {});
    setEmdashPtySessionpageHook(async (info) => ({ command: info.baseCommand, args: info.baseArgs, startupGate }));
    const item = session({ id: 'agy-conversation', providerId: 'antigravity', providerSessionId: undefined });

    await localProvider().startSession(item, undefined, false, 'first turn text');

    expect(buildCommandMock).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: undefined, isResuming: false }));
    expect(setPtyStartupGateMock).toHaveBeenCalledWith(pty, startupGate);
    // 首句在 startSession 返回之前就交给了注入(注入自己等启动门),不用轮询。
    expect(injectSessionMessageWhenReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({ pty, message: expect.objectContaining({ text: 'first turn text' }) })
    );
  });

  it('gates a fresh tmux-backed launch too, and skips the gate only when reattaching to a running tmux session', async () => {
    localAgentForSessionMock.mockResolvedValue({ gugu_user_id: 'agent-agy', cache: {} });
    injectSessionMessageWhenReadyMock.mockResolvedValue({ status: 'accepted', messageId: 'x' });
    const startupGate = new Promise<void>(() => {});
    setEmdashPtySessionpageHook(async (info) => ({ command: info.baseCommand, args: info.baseArgs, startupGate }));
    const listCalls = (ctx: { exec: ReturnType<typeof vi.fn> }) =>
      ctx.exec.mock.calls.filter(([, args]) => (args as string[]).includes('list-sessions'));
    const tmuxName = (id: string) =>
      `gugu-${Buffer.from(makePtySessionId('project-1', id, id), 'utf8').toString('base64url')}`;
    const ctxListing = (names: string[]) => ({
      supportsLocalSpawn: true,
      exec: vi.fn(async (_command: string, args: string[]) =>
        ({ stdout: args.includes('list-sessions') ? names.join('\n') : '', stderr: '' })),
      execStreaming: vi.fn(),
      dispose: vi.fn(),
    });

    // 首次启动:tmux 里还没有这个会话 ⇒ 这一发新起引擎 ⇒ 挂门
    const freshCtx = ctxListing([tmuxName('someone-else')]);
    const freshPty = fakePty([]);
    spawnLocalPty.mockReturnValue(freshPty);
    await localProvider({ tmux: true, ctx: freshCtx as never })
      .startSession(session({ id: 'agy-tmux-fresh', providerId: 'antigravity', providerSessionId: undefined }), undefined, false, 'hi');
    expect(listCalls(freshCtx)).toHaveLength(1);
    expect(setPtyStartupGateMock).toHaveBeenCalledWith(freshPty, startupGate);

    // 重连:tmux 里这个会话还在 ⇒ 引擎早就绪了,等不到第二次 tools/list ⇒ 不挂门
    setPtyStartupGateMock.mockClear();
    const reattachCtx = ctxListing([tmuxName('agy-tmux-reattach')]);
    spawnLocalPty.mockReturnValue(fakePty([]));
    await localProvider({ tmux: true, ctx: reattachCtx as never })
      .startSession(session({ id: 'agy-tmux-reattach', providerId: 'antigravity', providerSessionId: 'agy-native' }), undefined, true);
    expect(listCalls(reattachCtx)).toHaveLength(1);
    expect(setPtyStartupGateMock).not.toHaveBeenCalled();
  });

  it('still hands the startup turn to argv for providers that consume it at startup', async () => {
    spawnLocalPty.mockReturnValue(fakePty([]));
    await localProvider().startSession(session({ providerId: 'copilot', providerSessionId: undefined }), undefined, false, 'hello');

    expect(buildCommandMock).toHaveBeenCalledWith(expect.objectContaining({ initialPrompt: 'hello' }));
    expect(setPtyStartupGateMock).not.toHaveBeenCalled();
  });

  it('forks in the provider store before spawn, then resumes the child id — the argv never carries the source', async () => {
    localAgentForSessionMock.mockResolvedValue({ gugu_user_id: 'agent-agy', cache: {} });
    spawnLocalPty.mockReturnValue(fakePty([]));
    const provider = localProvider();
    const item = session({
      providerId: 'antigravity',
      id: 'agy-fork',
      providerSessionId: undefined,
      forkedFrom: { sessionId: 'source-conversation', title: 'Source conversation' },
    });

    await provider.startSession(item, undefined, false, undefined, 'source-agy-session');

    expect(forkSessionInStorageMock).toHaveBeenCalledTimes(1);
    expect(forkSessionInStorageMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceProviderSessionId: 'source-agy-session', cwd: '/tmp/ws-1' })
    );
    expect(setProviderSessionIdMock).toHaveBeenCalledWith('agy-fork', 'storage-child-session');
    expect(recordRuntimeForkOwnershipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeSessionId: 'agy-fork',
        sourceSessionId: 'source-conversation',
        providerSessionId: 'storage-child-session',
      })
    );
    expect(buildCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        forkFromProviderSessionId: undefined,
        isResuming: true,
        providerSessionId: 'storage-child-session',
      })
    );
    expect(item.providerSessionId).toBe('storage-child-session');
  });

  it('does not fork the store a second time when a retried fork spawn already owns its child', async () => {
    localAgentForSessionMock.mockResolvedValue({ gugu_user_id: 'agent-agy', cache: {} });
    spawnLocalPty.mockReturnValue(fakePty([]));
    const provider = localProvider();
    const item = session({ providerId: 'antigravity', id: 'agy-fork', providerSessionId: 'storage-child-session' });

    await provider.startSession(item, undefined, false, undefined, 'source-agy-session');

    expect(forkSessionInStorageMock).not.toHaveBeenCalled();
    expect(buildCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ forkFromProviderSessionId: undefined, isResuming: true, providerSessionId: 'storage-child-session' })
    );
  });

  it('records a Claude product fork continuation before the provider mints its child id', async () => {
    spawnLocalPty.mockReturnValue(fakePty([]));
    const provider = localProvider();
    const item = session({
      providerId: 'claude',
      id: 'claude-fork',
      providerSessionId: 'claude-fork',
      forkedFrom: { sessionId: 'source-conversation', title: 'Source conversation' },
    });

    await provider.startSession(item, undefined, false, undefined, 'source-claude-session');

    expect(recordProviderContinuationIntentMock).toHaveBeenCalledWith({
      sessionPath: '/tmp/ws-1',
      sessionId: 'claude-fork',
      sourceProviderSessionId: 'source-claude-session',
    });
  });

  it('fails loudly when a native-id fork exits without reporting a resumable session id', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
      const provider = localProvider();
      const item = session({ providerId: 'codex', providerSessionId: undefined });

      await provider.startSession(item, undefined, false, undefined, 'source-codex-session');
      for (const handler of exitHandlers) handler({ exitCode: 0 });
      await vi.advanceTimersByTimeAsync(500);

      expect(agentSessionListeners.size).toBe(0);
      expect(agentHookService.emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          payload: {
            message: 'fork session exited without reporting a new resumable session id',
          },
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails loudly before a tmux Codex fork lineage can hydrate without its child id', async () => {
    const provider = localProvider({ tmux: true });
    const item = session({
      providerId: 'codex',
      providerSessionId: undefined,
      forkedFrom: { sessionId: 'source-conversation', title: 'Source conversation' },
    });

    await expect(provider.startSession(item, undefined, true)).rejects.toThrow(
      'fork session exited without reporting a new resumable session id',
    );

    expect(agentHookService.emitAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        payload: {
          message: 'fork session exited without reporting a new resumable session id',
        },
      }),
    );
  });

  it('retains the original thread when its one resume replacement exits', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const provider = localProvider();
      const item = session();

      await provider.startSession(item);

      for (let index = 0; index < 2; index += 1) {
        for (const handler of exitHandlers[index] ?? []) handler({ exitCode: 1 });
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(buildCommandMock.mock.calls.map(([args]) => args.isResuming)).toEqual([
        false,
        true,
      ]);
      expect(setProviderSessionIdMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the Codex 56 original thread and a next step when resume exits non-zero', async () => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<Array<(info: PtyExitInfo) => void>> = [];
      spawnLocalPty.mockImplementation(() => {
        const handlers: Array<(info: PtyExitInfo) => void> = [];
        exitHandlers.push(handlers);
        return fakePty(handlers);
      });
      const teardown = vi.fn(async () => undefined);
      setEmdashPtySessionpageTeardown(teardown);
      const provider = localProvider();
      const item = session({
        id: 'e4e6af3a-9314-430f-a290-a0d4abbd9c02',
        providerId: 'codex',
        providerSessionId: '01a15d37-1674-7061-b298-37b108e1e970',
      });
      vi.mocked(agentHookService.emitAgentEvent).mockClear();

      await provider.startSession(item);
      for (let index = 0; index < 2; index += 1) {
        for (const handler of exitHandlers[index] ?? []) handler({ exitCode: 1 });
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(spawnLocalPty).toHaveBeenCalledTimes(2);
      expect(item.providerSessionId).toBe('01a15d37-1674-7061-b298-37b108e1e970');
      expect(setProviderSessionIdMock).not.toHaveBeenCalled();
      expect(teardown).toHaveBeenCalledWith(item.id);
      expect(events.emit).toHaveBeenCalledWith(sessionDeliveryFailedChannel, {
        sessionId: item.id,
        projectId: item.projectId,
        message: `Agent session failed to resume thread ${item.providerSessionId} (exit code 1).`
          + ' Retry restoring this task; if the original thread was deleted, start a new task.',
      });
      expect(vi.mocked(events.emit).mock.calls.filter(([channel]) => channel === sessionDeliveryFailedChannel)).toHaveLength(1);
      expect(agentHookService.emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          sessionId: item.id,
          payload: { message: `Agent session failed to resume thread ${item.providerSessionId} (exit code 1).`
            + ' Retry restoring this task; if the original thread was deleted, start a new task.' },
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('does not fail or replace a tmux attachment while its engine lives (resume=%s)', async (isResuming) => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
      const item = session();
      const name = `gugu-${Buffer.from(makePtySessionId(item.projectId, item.id, item.id), 'utf8').toString('base64url')}`;
      // 起的时候还没有(新起),起来以后它在(引擎在 tmux 里跑)
      let engineRunning = false;
      const ctx = {
        supportsLocalSpawn: true,
        exec: vi.fn(async (_command: string, args: string[]) =>
          ({ stdout: args.includes('list-sessions') && engineRunning ? name : '', stderr: '' })),
        execStreaming: vi.fn(),
        dispose: vi.fn(),
      };
      const provider = localProvider({ tmux: true, ctx: ctx as never });

      await provider.startSession(item, undefined, isResuming);
      engineRunning = true;
      vi.mocked(events.emit).mockClear();
      for (const handler of exitHandlers) handler({ exitCode: 1 });
      await vi.advanceTimersByTimeAsync(500);

      // tmux 里的进程还活着(退出的只是 attach 的那个 client)⇒ 不落 idle(#6380)。
      expect(agentStatusWriter.settleSessionExited).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalledWith(sessionDeliveryFailedChannel, expect.anything());
      expect(agentHookService.emitAgentEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      );
      expect(spawnLocalPty).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('settles or reports failure after tmux confirms the engine is gone (resume=%s)', async (isResuming) => {
    vi.useFakeTimers();
    try {
      const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
      spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
      const ctx = testExecutionContext(true) as unknown as { exec: ReturnType<typeof vi.fn> };
      const provider = localProvider({ tmux: true, ctx: ctx as never });
      const item = session();

      await provider.startSession(item, undefined, isResuming);
      for (const handler of exitHandlers) handler({ exitCode: 1 });
      await vi.advanceTimersByTimeAsync(500);

      // 退出之后问了 tmux(起的时候一次、退出时一次;之后可能还有替身那一发),tmux 里已经没有它 ⇒ 与不在 tmux 里的退出同一段:落 idle
      expect(ctx.exec.mock.calls.filter(([, args]) => (args as string[]).includes('list-sessions')).length).toBeGreaterThanOrEqual(2);
      if (isResuming) {
        expect(agentHookService.emitAgentEvent).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', sessionId: item.id }),
        );
      } else {
        expect(agentStatusWriter.settleSessionExited).toHaveBeenCalledWith({ sessionId: item.id });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches local tmux conversations without killing the tmux session', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const pty = fakePty(exitHandlers);
    spawnLocalPty.mockReturnValue(pty);
    const ctx = {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    };
    const provider = localProvider({ tmux: true, ctx: ctx as never });
    const item = session();
    const ptySessionId = makePtySessionId(item.projectId, item.id, item.id);

    await provider.startSession(item);
    ctx.exec.mockClear();
    vi.mocked(events.emit).mockClear();
    await provider.detachSession(item.id);
    for (const handler of exitHandlers) handler({ exitCode: 0 });

    expect((provider as unknown as RespawnState).knownPtySessionIds.has(ptySessionId)).toBe(true);
  });

  it('kills tmux when explicitly stopping a detached local conversation', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const ctx = {
      exec: vi.fn(async () => ({ stdout: '', stderr: '' })),
    };
    const provider = localProvider({ tmux: true, ctx: ctx as never });
    const item = session();
    const ptySessionId = makePtySessionId(item.projectId, item.id, item.id);

    await provider.startSession(item);
    await provider.detachSession(item.id);
    await provider.stopSession(item.id);

    expect(ctx.exec).toHaveBeenCalledWith('tmux', [
      'kill-session',
      '-t',
      expect.stringContaining(Buffer.from(ptySessionId, 'utf8').toString('base64url')),
    ]);
    expect((provider as unknown as RespawnState).knownPtySessionIds.has(ptySessionId)).toBe(false);
  });

  it('revokes a non-tmux spawn’s hook source when its PTY exits', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const provider = localProvider();
    const item = session();
    const createSource = vi.mocked(agentHookService.createSource);
    createSource.mockClear();

    await provider.startSession(item);
    expect(createSource).toHaveBeenCalledTimes(1);
    const source = createSource.mock.results[0]!.value;
    expect(source.dispose).not.toHaveBeenCalled();
    for (const handler of exitHandlers) handler({ exitCode: 0 });

    expect(source.dispose).toHaveBeenCalledTimes(1);
  });

  it('hands a tmux re-attach the hook source its agent already holds', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const item = session();
    const name = `gugu-${Buffer.from(makePtySessionId(item.projectId, item.id, item.id), 'utf8').toString('base64url')}`;
    // 引擎起来以后一直在 tmux 里跑(tmux 列得出它)。
    let engineRunning = false;
    const ctx = {
      exec: vi.fn(async (_command: string, args: string[]) =>
        ({ stdout: args.includes('list-sessions') && engineRunning ? name : '', stderr: '' })),
    };
    const provider = localProvider({ tmux: true, ctx: ctx as never });
    const createSource = vi.mocked(agentHookService.createSource);
    createSource.mockClear();

    // The agent keeps running inside tmux, so the attaching PTY exiting is not its death: minting a
    // second source here would hand the new PTY credentials the live agent never reads, and revoking
    // the first would 403 every hook that agent still posts.
    await provider.startSession(item);
    engineRunning = true;
    for (const handler of exitHandlers) handler({ exitCode: 0 });
    await provider.detachSession(item.id);
    await provider.startSession(item);

    expect(createSource).toHaveBeenCalledTimes(1);
    const source = createSource.mock.results[0]!.value;
    expect(source.dispose).not.toHaveBeenCalled();

    await provider.stopSession(item.id);
    expect(source.dispose).toHaveBeenCalledTimes(1);
  });

  it('#6264 after a host-process restart, a tmux re-attach gets back the source the previous process gave its agent', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    spawnLocalPty.mockReturnValue(fakePty(exitHandlers));
    const ctx = { exec: vi.fn(async () => ({ stdout: '', stderr: '' })) };
    // A fresh provider = the new account process: its in-memory map is empty.
    const provider = localProvider({ tmux: true, ctx: ctx as never });
    const item = session();
    const restored = { id: 'source-from-before', token: 'token-from-before', dispose: vi.fn(), keepAcrossRestart: vi.fn() };
    const takeRestored = vi.mocked(agentHookService.takeRestoredSource);
    takeRestored.mockReturnValueOnce(restored as never);
    const createSource = vi.mocked(agentHookService.createSource);
    createSource.mockClear();

    await provider.startSession(item);

    expect(takeRestored).toHaveBeenCalledWith(makePtySessionId(item.projectId, item.id, item.id));
    expect(createSource).not.toHaveBeenCalled();
    expect(restored.keepAcrossRestart).toHaveBeenCalled();
    await provider.stopSession(item.id);
    expect(restored.dispose).toHaveBeenCalledTimes(1);
  });

  it('#6264 a tmux spawn keeps its hook source on disk; a plain one does not', async () => {
    spawnLocalPty.mockReturnValue(fakePty([]));
    const createSource = vi.mocked(agentHookService.createSource);
    createSource.mockClear();
    await localProvider({ tmux: true, ctx: { exec: vi.fn(async () => ({ stdout: '', stderr: '' })) } as never }).startSession(session());
    expect(createSource.mock.results[0]!.value.keepAcrossRestart).toHaveBeenCalled();
    createSource.mockClear();
    await localProvider({ tmux: false }).startSession(session());
    expect(createSource.mock.results[0]!.value.keepAcrossRestart).not.toHaveBeenCalled();
  });

  it('ignores stale local attach exits after a tmux conversation is rehydrated', async () => {
    const firstExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const secondExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const firstPty = fakePty(firstExitHandlers);
    const secondPty = fakePty(secondExitHandlers);
    spawnLocalPty.mockReturnValueOnce(firstPty).mockReturnValueOnce(secondPty);
    const provider = localProvider({ tmux: true });
    const item = session();
    const ptySessionId = makePtySessionId(item.projectId, item.id, item.id);

    await provider.startSession(item);
    await provider.detachSession(item.id);
    await provider.startSession(item);
    vi.mocked(events.emit).mockClear();
    for (const handler of firstExitHandlers) handler({ exitCode: 0 });

    expect((provider as unknown as RespawnState).ptysBySession.get(ptySessionId)).toBe(secondPty);
  });

  it('does not let a stale task-TUI PTY exit remove the replacement local-session binding', async () => {
    localAgentForSessionMock.mockResolvedValue({ gugu_user_id: 'agent-droid', cache: {} });
    const firstExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const secondExitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const firstPty = fakePty(firstExitHandlers);
    const secondPty = fakePty(secondExitHandlers);
    spawnLocalPty.mockReturnValueOnce(firstPty).mockReturnValueOnce(secondPty);
    const provider = localProvider({ tmux: true });
    const item = session({ id: 'droid-conversation', providerId: 'droid' });

    await provider.startSession(item);
    await provider.detachSession(item.id);
    await provider.startSession(item);
    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
    firstExitHandlers[0]?.({ exitCode: 0 });

    expect(localSessionDeliveryTarget.liveSessionIdByAgent('agent-droid')).toBe(item.id);
    expect((provider as unknown as RespawnState).ptysBySession.get(
      makePtySessionId(item.projectId, item.id, item.id),
    )).toBe(secondPty);
  });

  // #6095 —— 进程是 stopSession 自己杀的,harness 因此打不回 stop 边沿。
  // 代码里本来有一条兜底(pty 退出 → 写入者收成被打断),但显式 stop 走不到它:
  // stopSession 先把 supervisor 里的 active 摘掉,onExit 里 handleExit 判 stale/stopped,两支都在
  // emit 之前 return。⇒ 停这一端必须自己把「被打断」交给写入者。
  // #6546 —— 「还有没有运行时」不落成事实:进程在不在不是会话的事实。
  it('settles the interrupted turn when a pty session is explicitly stopped', async () => {
    const exitHandlers: Array<(info: PtyExitInfo) => void> = [];
    const pty = fakePty(exitHandlers);
    spawnLocalPty.mockReturnValue(pty);
    const provider = localProvider();
    const item = session({ id: 'stopped-conversation', providerId: 'claude' });

    await provider.startSession(item);
    expect(agentStatusWriter.settleSessionExited).not.toHaveBeenCalled();

    await provider.stopSession(item.id);

    expect(agentStatusWriter.settleSessionExited).toHaveBeenCalledWith({
      sessionId: item.id,
      projectId: 'project-1',
    });

    // 阴控:被杀的进程随后打回的那次 onExit 走的是 stale/stopped 分支 —— 它不再补一次,
    // 两次落定会让「谁写的最后一笔」变成一场竞争。
    vi.mocked(agentStatusWriter.settleSessionExited).mockClear();
    exitHandlers[0]?.({ exitCode: 0 });
    await Promise.resolve();
    expect(agentStatusWriter.settleSessionExited).not.toHaveBeenCalled();
  });

  // 阳控:detach 不是 stop —— tmux 会话还在,把它当成被打断会让一条活着的会话显示成空闲。
  it('does not settle a detached pty session', async () => {
    spawnLocalPty.mockReturnValue(fakePty([]));
    const provider = localProvider({ tmux: true });
    const item = session({ id: 'detached-conversation', providerId: 'claude' });

    await provider.startSession(item);

    await provider.detachSession(item.id);

    expect(agentStatusWriter.settleSessionExited).not.toHaveBeenCalled();
  });

});

// #6183(原在 conversation-session-supervisor.test.ts,那个文件被 #6177 按覆盖率删掉;这条守的是本 PR 的核心语义,
// 挪到这里而不是复活整份文件):显式取消在飞的启动才 abort,普通 stop 不是取消;已经起来的那次没有可取消的等待。
describe('SessionPtySupervisor.cancelStart (#6183)', () => {
  const fakePty = () =>
    ({ write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }) as never;

  it('cancelStart aborts the start in flight; a plain stop does not', () => {
    const supervisor = new SessionPtySupervisor();
    const detached = supervisor.beginStart('session-a');
    supervisor.stop('session-a');
    expect(detached!.signal.aborted, 'stop() 不是取消').toBe(false);

    const inFlight = supervisor.beginStart('session-b');
    expect(supervisor.cancelStart('session-b')).toBe(true);
    expect(inFlight!.signal.aborted).toBe(true);

    const accepted = supervisor.beginStart('session-c');
    supervisor.acceptSpawn('session-c', accepted!, fakePty());
    expect(supervisor.cancelStart('session-c'), '已经起来的那次没有在飞的等待可取消').toBe(false);
    expect(accepted!.signal.aborted).toBe(false);
  });
});
