import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@gugu/core/cloud/agentIdentityReconcile', () => ({
  listOwnedCloudAgentsViaSupabase: vi.fn(async () => []),
}))
import {
  guguSessionSurfaceBlock,
  loadCodexAppServerCapabilities,
  PRODUCT_CAPABILITY_PACKAGES,
  type SessionCapabilityBundle,
  type SessionAutonomyCapability,
  type SessionModelCapability,
} from '../../../../apps/desktop/electron/capability-bundle'
import { codexNotifyConfigValue } from '@gugu/session-plugins/agents'
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context'
function codexAppServerCapabilities(bundle: SessionCapabilityBundle) {
  return loadCodexAppServerCapabilities(
    {
      ...bundle,
      env: { GUGU_HOME: '/tmp/gugu-codex-test', ...bundle.env },
      packages: PRODUCT_CAPABILITY_PACKAGES,
      extensionSkills: [],
      extensionApps: [],
      extensionServerOrigins: [],
    },
    { cwd: '/tmp/worktree', lifecycle: 'fresh' },
  )
}
const started: {
  cwd: string
  extraArgs: string[]
  threadConfig?: Record<string, unknown>
  threadStart?: Record<string, unknown>
  env?: Record<string, string>
  skillRoots?: string[]
  developerInstructions?: string
  forkFromThreadId?: string
  resumeThreadId?: string
  tuiLoads?: 'create' | 'resume'
  agentUserId?: string
}[] = []
const initialPrompts: string[] = []
const waitedFirstDeliveryThreads: string[] = []
const registeredAgents: string[] = []
const unregisteredAgents: string[] = []
const restoredBlockers: string[] = []
const disposedAgents: string[] = []
/** 顺序日志:分叉交接必须注入在临时 app-server **拆掉之前**。 */
const scratchEvents: string[] = []
const injectedItems: unknown[][] = []
const emittedProvisionEvents: unknown[] = []
let waitForFirstDelivery: Promise<void> | null = null
let provisionCalls = 0
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-registry', () => ({
  registerEmdashAgent: vi.fn(),
  unregisterEmdashAgent: vi.fn(),
  emdashAgentRegistry: {
    deliveryTargetName: 'gugu-acp',
    liveSessionIdByAgent: () => null,
    releaseAgentClaim: () => {},
    unregisterAgent: (_id: string, onReleased?: () => void) => { onReleased?.() },
  },
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/local-session-delivery', () => ({
  registerOfflineLocalSessionDelivery: vi.fn((agentUserId: string) => {
    restoredBlockers.push(agentUserId)
  }),
  unregisterLocalSessionDeliveryForAgent: vi.fn(),
  localSessionDeliveryTarget: {
    deliveryTargetName: 'local-session-pty',
    liveSessionIdByAgent: () => null,
  },
}))
// 宿主替这一家算的运行上下文(#5702)。这里把它按住:真货会去解析「跑哪一份」并读设置栈,
// 在单测环境里那条链起不来,整个文件会挂住不返回 —— 这条用例问的是 argv,不是主进程怎么算环境。
vi.mock('@main/core/agents/agent-run-context', () => ({
  resolveLocalAgentRunContext: vi.fn(async () => ({
    cli: { kind: 'resolved' as const, path: '/usr/local/bin/codex' },
    env: {},
    configRootEnv: {},
    selfUpdateEnv: {},
    extraArgs: [],
  })),
}));

vi.mock('../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery', () => {
  class FakeCodexAppServerSession {
    threadId: string | null = null
    constructor(
      public agentUserId: string,
      public bin: string,
    ) {}
    async start(
      cwd: string,
      opts?: {
        extraArgs?: string[]
        threadConfig?: Record<string, unknown>
        threadStart?: Record<string, unknown>
        env?: Record<string, string>
        skillRoots?: string[]
        developerInstructions?: string
        forkFromThreadId?: string
        resumeThreadId?: string
        tuiLoads?: 'create' | 'resume'
      },
    ): Promise<string | null> {
      started.push({
        cwd,
        extraArgs: opts?.extraArgs ?? [],
        threadConfig: opts?.threadConfig,
        threadStart: opts?.threadStart,
        env: opts?.env,
        skillRoots: opts?.skillRoots,
        developerInstructions: opts?.developerInstructions,
        forkFromThreadId: opts?.forkFromThreadId,
        resumeThreadId: opts?.resumeThreadId,
        tuiLoads: opts?.tuiLoads,
        agentUserId: this.agentUserId,
      })
      // @@@6112 新会话的 thread 由 TUI 建 —— start() 这一刻还没有 id(见 waitForTuiThread)。
      if (opts?.tuiLoads === 'create') return null
      // fork 在临时 app-server 上做,返回 fork 出来的新 thread。
      if (opts?.forkFromThreadId) return 'forked-thread-1'
      this.threadId = opts?.resumeThreadId ?? 'thread-1'
      return this.threadId
    }
    /** @@@6112 TUI 把 thread 建出来那一刻。`waitForFirstDelivery` 让用例自己掌控时机/失败。 */
    async waitForTuiThread(): Promise<string> {
      waitedFirstDeliveryThreads.push('thread-1')
      await waitForFirstDelivery
      this.threadId = 'thread-1'
      return this.threadId
    }
    isAwaitingTuiThread(): boolean {
      return false
    }
    isLive(): boolean {
      return true
    }
    remoteTuiArgs(): string[] {
      // 认领模式下还没有 tid:不带 resume,让 TUI 自己建。
      return this.threadId
        ? ['--remote', 'unix:///tmp/x.sock', 'resume', this.threadId]
        : ['-C', '/tmp/w', '--remote', 'unix:///tmp/x.sock']
    }
    async injectItems(items: unknown[]): Promise<void> {
      injectedItems.push(items)
      scratchEvents.push(`inject:${this.agentUserId}`)
    }
    dispose(): void {
      disposedAgents.push(this.agentUserId)
      scratchEvents.push(`dispose:${this.agentUserId}`)
    }
  }
  class CodexSessionClosedError extends Error {}
  return {
    CodexAppServerSession: FakeCodexAppServerSession,
    CodexSessionClosedError,
    codexAppServerRegistry: {
      register: vi.fn((agentUserId: string) => {
        registeredAgents.push(agentUserId)
      }),
      unregister: vi.fn(async (
        agentUserId: string,
        replaceAfterRelease?: () => void,
      ) => {
        unregisteredAgents.push(agentUserId)
        replaceAfterRelease?.()
      }),
      waitForNextInjectedTurnLive: vi.fn(async (threadId: string) => {
        waitedFirstDeliveryThreads.push(threadId)
        await waitForFirstDelivery
      }),
      tryInjectMessage: vi.fn(async (_threadId: string, text: string) => {
        initialPrompts.push(text)
        return { turnId: 'turn-1', completion: Promise.resolve() }
      }),
    },
  }
})
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  provisionSessionpageAgentForSession: vi.fn(async () => {
    provisionCalls += 1
    return {
      guguAgentUserId: 'agent-1',
      chatId: 'chat-1',
      event: {
        sessionId: 'conv-1',
        agentUserId: 'agent-1',
        displayName: 'Codex 1',
        chatId: 'chat-1',
      },
    }
  }),
  emitSessionpageAgentProvisioned: vi.fn((event: unknown) => {
    emittedProvisionEvents.push(event)
  }),
}))
const { provisionAndOverride, teardown } = await import(
  '../../../../apps/desktop/electron/sessionpage/codex-pty-provisioning'
)
const IDENTITY = '<agent_identity>Codex 1</agent_identity>\n'
const PLATFORM = '<gugu_platform>P</gugu_platform>\n'
const deps = {
  getAuth: vi.fn(),
  resolveDeviceId: vi.fn(),
  loadCapabilities: vi.fn(async (
    _agentUserId: string,
    _chatId: string | null,
    model: SessionModelCapability,
    autonomy: SessionAutonomyCapability | null,
    includePromptBlocks: boolean,
  ) => codexAppServerCapabilities({
    mcpServers: [],
    mcpDisabled: undefined,
    env: {},
    model,
    autonomy,
    promptBlocks: includePromptBlocks ? { platform: PLATFORM, identity: IDENTITY } : {},
    packages: [],
    extensionSkills: [],
    extensionApps: [],
    extensionServerOrigins: [],
  })),
} as unknown as Parameters<typeof provisionAndOverride>[1]
describe('codex-app-server loader 的 model 单元', () => {
  const base: Omit<SessionCapabilityBundle, 'model'> = {
    mcpServers: [],
    mcpDisabled: undefined,
    env: {},
    autonomy: null,
    promptBlocks: {},
    packages: [],
    extensionSkills: [],
    extensionApps: [],
    extensionServerOrigins: [],
  }
  it.each<readonly [string, SessionModelCapability, string[]]>([
    ['两项都选', { dialect: 'codex-config-flags', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' }, [
      '-c', 'projects={ "/tmp/worktree" = { trust_level = "trusted" } }',
      '-c', 'model="gpt-5.6-sol"', '-c', 'model_reasoning_effort="xhigh"',
    ]],
    ['只选模型', { dialect: 'codex-config-flags', model: 'gpt-5.5' }, [
      '-c', 'projects={ "/tmp/worktree" = { trust_level = "trusted" } }', '-c', 'model="gpt-5.5"',
    ]],
    ['没有模型', { dialect: 'codex-config-flags' }, [
      '-c', 'projects={ "/tmp/worktree" = { trust_level = "trusted" } }',
    ]],
  ])('%s → emits only the selected model fields', (_label, model, expected) => {
    expect(codexAppServerCapabilities({ ...base, model }).extraArgs ?? []).toEqual(expected)
  })
  it('空串 / null → 一条模型或强度都不下发', () => {
    const models: Array<SessionModelCapability | null> = [
      { dialect: 'codex-config-flags' as const, model: '  ', reasoningEffort: '' },
      null,
    ]
    for (const model of models) {
      expect(codexAppServerCapabilities({ ...base, model }).extraArgs ?? [])
        .toEqual(['-c', 'projects={ "/tmp/worktree" = { trust_level = "trusted" } }'])
    }
  })
})
describe('divert 真的把选择接进了 app-server 的启动 argv', () => {
  beforeEach(() => {
    started.length = 0
    initialPrompts.length = 0
    waitedFirstDeliveryThreads.length = 0
    registeredAgents.length = 0
    unregisteredAgents.length = 0
    restoredBlockers.length = 0
    disposedAgents.length = 0
    scratchEvents.length = 0
    injectedItems.length = 0
    emittedProvisionEvents.length = 0
    waitForFirstDelivery = null
    provisionCalls = 0
  })
  it('起 app-server 时带上模型与推理强度', async () => {
    const out = await provisionAndOverride(
      {
        sessionId: 'conv-model-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        initialPrompt: 'model test',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      deps,
    )
    expect(out).not.toBeNull()
    expect(started).toHaveLength(1)
    expect(started[0]?.extraArgs).toEqual(
      expect.arrayContaining(['model="gpt-5.6-sol"', 'model_reasoning_effort="high"']),
    )
    expect(started[0]?.developerInstructions).toBe(
      PLATFORM + guguSessionSurfaceBlock('app-server', 'codex', false) + IDENTITY,
    )
    expect(registeredAgents).toEqual(['agent-1'])
    expect(emittedProvisionEvents).toHaveLength(1)
    expect(started[0]?.tuiLoads).toBe('create')
    // @@@6112 第一轮在描述符返回**之后**才投:先让 TUI 把 thread 建出来,咕咕才有地方投。
    await vi.waitFor(() => expect(waitedFirstDeliveryThreads).toEqual(['thread-1']))
    await vi.waitFor(() => expect(initialPrompts).toEqual(['model test']))
  })
  it('gugu thread config 只承载 endpoint 与 bearer env 名称，凭据值只进 env', async () => {
    const capability = 'synthetic-session-capability'
    const depsWithMcp = {
      ...deps,
      loadCapabilities: vi.fn(async (
        _agentUserId: string,
        _chatId: string | null,
        model: SessionModelCapability,
        autonomy: SessionAutonomyCapability | null,
        includePromptBlocks: boolean,
      ) => codexAppServerCapabilities({
        mcpServers: [{
          name: 'gugu',
          url: 'http://127.0.0.1:44100/mcp',
          headers: [{ name: 'Authorization', value: `Bearer ${capability}` }],
        }],
        mcpDisabled: undefined,
        env: {},
        model,
        autonomy,
        promptBlocks: includePromptBlocks ? { platform: PLATFORM, identity: IDENTITY } : {},
        packages: [],
        extensionSkills: [],
        extensionApps: [],
        extensionServerOrigins: [],
      })),
    } as unknown as Parameters<typeof provisionAndOverride>[1]
    const out = await provisionAndOverride(
      {
        sessionId: 'conv-mcp-env-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        initialPrompt: 'mcp env test',
      },
      depsWithMcp,
    )
    expect(started).toHaveLength(1)
    expect(started[0]?.threadConfig).toEqual({
      'mcp_servers.gugu.default_tools_approval_mode': 'approve',
      'mcp_servers.gugu.url': 'http://127.0.0.1:44100/mcp',
      'mcp_servers.gugu.bearer_token_env_var': 'GUGU_SESSION_MCP_BEARER_GUGU',
      notify: codexNotifyConfigValue(),
    })
    expect(started[0]?.extraArgs.join(' ')).not.toContain('notify=')
    expect(JSON.stringify(started[0]?.threadConfig)).not.toContain(capability)
    expect(started[0]?.extraArgs.join(' ')).not.toContain('mcp_servers.')
    expect(started[0]?.env).toEqual(expect.objectContaining({
      GUGU_SESSION_MCP_URL_GUGU: 'http://127.0.0.1:44100/mcp',
      GUGU_SESSION_MCP_BEARER_GUGU: capability,
    }))
    expect(started[0]?.env?.CODEX_HOME).toBeUndefined()
    expect(out?.env?.CODEX_HOME).toBeUndefined()
    await vi.waitFor(() => expect(initialPrompts).toEqual(['mcp env test']))
  })
  it('重开 remote TUI 继续使用原 app-server 的已声明 child env', async () => {
    const first = await provisionAndOverride(
      {
        sessionId: 'conv-reopen-home-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        initialPrompt: 'home test',
      },
      deps,
    )
    const reopened = await provisionAndOverride(
      {
        sessionId: 'conv-reopen-home-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        resumeProviderSessionId: 'thread-1',
      },
      deps,
    )
    expect(started).toHaveLength(1)
    expect(reopened?.env?.CODEX_HOME).toBe(first?.env?.CODEX_HOME)
    await vi.waitFor(() => expect(waitedFirstDeliveryThreads).toEqual(['thread-1']))
  })
  it('并发重开必须等待 fresh thread 的第一轮 rollout ready', async () => {
    const rollout = deferred()
    waitForFirstDelivery = rollout.promise
    const first = provisionAndOverride(
      {
        sessionId: 'conv-concurrent-reopen-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
      },
      deps,
    )
    while (!emittedProvisionEvents.length) await Promise.resolve()
    const reopened = provisionAndOverride(
      {
        sessionId: 'conv-concurrent-reopen-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
      },
      deps,
    )
    let reopenedSettled = false
    void reopened.finally(() => { reopenedSettled = true })
    await Promise.resolve()
    expect(reopenedSettled).toBe(false)
    expect(started).toHaveLength(1)
    rollout.resolve()
    await expect(Promise.all([first, reopened])).resolves.toEqual([
      expect.objectContaining({ args: expect.arrayContaining(['--remote', 'unix:///tmp/x.sock']) }),
      expect.objectContaining({ args: expect.arrayContaining(['--remote', 'unix:///tmp/x.sock']) }),
    ])
  })
  it('publication 之前的并发 fresh start 共享同一个 provision 与 app-server owner', async () => {
    const rollout = deferred()
    waitForFirstDelivery = rollout.promise
    const first = provisionAndOverride(
      {
        sessionId: 'conv-concurrent-before-publication',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
      },
      deps,
    )
    const second = provisionAndOverride(
      {
        sessionId: 'conv-concurrent-before-publication',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
      },
      deps,
    )
    await vi.waitFor(() => expect(started).toHaveLength(1))
    expect(provisionCalls).toBe(1)
    rollout.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ args: expect.arrayContaining(['--remote', 'unix:///tmp/x.sock']) }),
      expect.objectContaining({ args: expect.arrayContaining(['--remote', 'unix:///tmp/x.sock']) }),
    ])
    expect(started).toHaveLength(1)
  })
  it('teardown 取消并等待 publication 之前的 starting owner，且不遗留 registry/session', async () => {
    const enteredCapabilities = deferred()
    const releaseCapabilities = deferred()
    const blockedDeps = {
      ...deps,
      loadCapabilities: vi.fn(async (...args: Parameters<typeof deps.loadCapabilities>) => {
        enteredCapabilities.resolve()
        await releaseCapabilities.promise
        return deps.loadCapabilities(...args)
      }),
    } as unknown as Parameters<typeof provisionAndOverride>[1]
    const info = {
      sessionId: 'conv-stop-before-publication',
      providerId: 'codex',
      cwd: '/tmp/w',
      baseCommand: '/x/codex',
    }
    const starting = provisionAndOverride(info, blockedDeps)
    const rejected = expect(starting).rejects.toThrow(/stopped during startup/i)
    await enteredCapabilities.promise
    const stopping = teardown(info.sessionId)
    expect(registeredAgents).toEqual([])
    expect(started).toEqual([])
    releaseCapabilities.resolve()
    await rejected
    await expect(stopping).resolves.toBeUndefined()
    expect(registeredAgents).toEqual([])
    expect(disposedAgents).toEqual(['agent-1'])
    await expect(provisionAndOverride(info, deps)).resolves.toEqual(
      expect.objectContaining({ args: expect.arrayContaining(['--remote', 'unix:///tmp/x.sock']) }),
    )
    expect(started).toHaveLength(1)
    expect(registeredAgents).toEqual(['agent-1'])
  })
  it('promotion 后首轮失败会经 release callback 恢复 blocker', async () => {
    const rollout = deferred()
    waitForFirstDelivery = rollout.promise
    const starting = provisionAndOverride(
      {
        sessionId: 'conv-first-turn-fails',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
      },
      deps,
    )
    await vi.waitFor(() => expect(registeredAgents).toEqual(['agent-1']))
    // @@@6112 首轮改在描述符返回**之后**才投,所以它的失败不再由 provisionAndOverride 抛出。
    // 但善后一格都不能少:registry 要摘掉、delivery blocker 要放回离线态 —— 否则这条会话会以
    // 「已注册、却永远收不到第一句」的样子挂着,投给它的消息静默排队,用户只看到一个什么都
    // 没发生的终端。
    await expect(starting).resolves.not.toBeNull()
    rollout.reject(new Error('first turn failed'))
    await vi.waitFor(() => expect(unregisteredAgents).toEqual(['agent-1']))
    await vi.waitFor(() => expect(restoredBlockers).toEqual(['agent-1']))
  })
  it('完全访问经 bundle 进入 thread/start,且 model / effort 仍同时在 argv', async () => {
    await provisionAndOverride(
      {
        sessionId: 'conv-full-access-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        initialPrompt: 'full access test',
        permissionMode: 'full-access',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      deps,
    )
    expect(started).toHaveLength(1)
    expect(started[0]?.threadStart).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    expect(started[0]?.extraArgs).toEqual(expect.arrayContaining([
      'model="gpt-5.6-sol"',
      'model_reasoning_effort="high"',
    ]))
    expect(started[0]?.extraArgs).not.toContain('--dangerously-bypass-hook-trust')
    expect(started[0]?.extraArgs.some((arg) => arg.startsWith('notify='))).toBe(false)
    expect(started[0]?.threadConfig?.notify).toEqual(codexNotifyConfigValue())
  })
  it('非完全访问显式要求批准,不继承用户的 full-access 全局配置', async () => {
    await provisionAndOverride(
      {
        sessionId: 'conv-approval-required-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        initialPrompt: 'approval required test',
        permissionMode: 'edit',
      },
      deps,
    )
    expect(started).toHaveLength(1)
    expect(started[0]?.threadStart).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  })
  it('没选 model / effort 就不下发这两项,但默认询问权限仍经 thread/start 下发', async () => {
    await provisionAndOverride(
      {
        sessionId: 'conv-model-2',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        initialPrompt: 'default model test',
      },
      deps,
    )
    expect(started).toHaveLength(1)
    const args = started[0]?.extraArgs ?? []
    expect(args.some((a) => a.startsWith('model='))).toBe(false)
    expect(args.some((a) => a.startsWith('model_reasoning_effort='))).toBe(false)
    expect(started[0]?.threadStart).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  })
  it('fork 显式交给 app-server 且不发送 fresh-session 待命 prompt', async () => {
    const onProviderSessionId = vi.fn(async () => {})
    await provisionAndOverride(
      {
        sessionId: 'conv-fork-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        forkFromProviderSessionId: 'parent-thread-1',
        onProviderSessionId,
        permissionMode: 'read-only',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      deps,
    )
    // @@@6112 fork 分两步:① 临时 app-server 上由咕咕带**新身份**指令 fork(官方只认 start/fork 时给)
    // 并当场拆掉;② 正式 app-server 把 fork 出来的 thread 交给 TUI resume 载入(咕咕从不先载入)。
    expect(started).toEqual([
      expect.objectContaining({
        agentUserId: 'agent-1:fork-scratch',
        developerInstructions: PLATFORM + guguSessionSurfaceBlock('app-server', 'codex', false) + IDENTITY,
        forkFromThreadId: 'parent-thread-1',
        threadStart: { approvalPolicy: 'never', sandbox: 'read-only' },
        extraArgs: expect.arrayContaining(['model="gpt-5.6-sol"', 'model_reasoning_effort="high"']),
        tuiLoads: undefined,
      }),
      expect.objectContaining({
        agentUserId: 'agent-1',
        forkFromThreadId: undefined,
        tuiLoads: 'resume',
        resumeThreadId: 'forked-thread-1',
      }),
    ])
    expect(disposedAgents).toContain('agent-1:fork-scratch')
    expect(disposedAgents).not.toContain('agent-1')
    // @@@fork-identity codex 不认 fork 带的新指令(openai/codex#19045)⇒ 在临时 app-server 上、拆掉**之前**
    // 注入一条只含身份差异 + 交接说明的开发者消息(随 thread 落盘)。
    expect(scratchEvents).toEqual(['inject:agent-1:fork-scratch', 'dispose:agent-1:fork-scratch'])
    const handoff = JSON.stringify(injectedItems[0])
    expect(handoff).toContain('<agent_identity>Codex 1</agent_identity>')
    expect(handoff).toContain('Do not resume or continue the source conversation')
    expect(handoff).not.toContain(PLATFORM.trim().slice(0, 40))
    expect(initialPrompts).toEqual([])
    expect(waitedFirstDeliveryThreads).toEqual([])
    expect(onProviderSessionId).toHaveBeenCalledWith('forked-thread-1')
  })
  it('重开会话使用 thread/resume 且不发送 fresh-session 待命 prompt', async () => {
    await provisionAndOverride(
      {
        sessionId: 'conv-resume-1',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
        resumeProviderSessionId: 'existing-thread-1',
        permissionMode: 'full-access',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      deps,
    )
    expect(started).toEqual([
      expect.objectContaining({
        developerInstructions: undefined,
        resumeThreadId: 'existing-thread-1',
        threadStart: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
        extraArgs: expect.arrayContaining(['model="gpt-5.6-sol"', 'model_reasoning_effort="high"']),
        // @@@6112 载入交给 TUI(`resume <tid>`),咕咕等它的载入广播再订阅。
        tuiLoads: 'resume',
      }),
    ])
    expect(initialPrompts).toEqual([])
    expect(waitedFirstDeliveryThreads).toEqual([])
  })
  it.each(['fresh', 'resume', 'fork'] as const)('%s keeps the engine on the session account after the default account changes', async (lifecycle) => {
    const sessionId = `conv-account-${lifecycle}`
    const sourceSessionId = lifecycle === 'fork' ? 'source-free-account' : undefined
    vi.mocked(resolveLocalAgentRunContext).mockImplementationOnce(async (_provider, options) => ({
      cli: { kind: 'resolved', path: '/x/codex' },
      env: { OPENAI_API_KEY: 'inherited-wrong-key' },
      configRootEnv: { CODEX_HOME: options.sessionId === sessionId ? '/accounts/free/.codex' : '/accounts/current-pro/.codex' },
      unsetEnv: ['OPENAI_API_KEY'],
      selfUpdateEnv: {},
      extraArgs: [],
    }))
    await provisionAndOverride({
      sessionId, sourceSessionId, providerId: 'codex', cwd: '/tmp/w', baseCommand: '/x/codex',
      ...(lifecycle === 'resume' ? { resumeProviderSessionId: 'free-thread', model: 'gpt-6.1-sol' } : {}),
      ...(lifecycle === 'fork' ? { forkFromProviderSessionId: 'free-thread' } : {}),
    }, deps)
    expect(started).toHaveLength(lifecycle === 'fork' ? 2 : 1)
    for (const engine of started) {
      expect(engine.env?.CODEX_HOME).toBe('/accounts/free/.codex')
      expect(engine.env).not.toHaveProperty('OPENAI_API_KEY')
    }
    expect(resolveLocalAgentRunContext).toHaveBeenLastCalledWith('codex', { role: 'tui', sessionId, sourceSessionId })
  })
  it('全新会话不消费 initialPrompt，而是等待第一条真实投递', async () => {
    const out = await provisionAndOverride(
      {
        sessionId: 'conv-missing-prompt',
        providerId: 'codex',
        cwd: '/tmp/w',
        baseCommand: '/x/codex',
      },
      deps,
    )
    // @@@6112 新会话**不带 resume**:thread 由 TUI 自己建,咕咕再从广播里认领它。
    expect(out?.args).toEqual(['-C', '/tmp/w', '--remote', 'unix:///tmp/x.sock'])
    expect(started).toHaveLength(1)
    expect(started[0]?.tuiLoads).toBe('create')
    expect(registeredAgents).toEqual(['agent-1'])
    expect(emittedProvisionEvents).toHaveLength(1)
    await vi.waitFor(() => expect(waitedFirstDeliveryThreads).toEqual(['thread-1']))
    expect(initialPrompts).toEqual([])
  })
})
