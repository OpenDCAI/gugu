import { randomUUID } from 'node:crypto'
import type { GuguPermissionMode } from '@gugu/session-core/acp'
import type { SessionTuiHostAdapter } from '@gugu/session-core/agents/plugins'
import { resolveSessionTuiHostAdapter, resolveSessionTuiStartupPolicy } from '@gugu/session-plugins/agents'
import { createLogger } from '../lib/logger'
import type { AcpEngineRuntimeContext, BuildSocialBridgeDeps, DesktopGuguMcpHost } from '../acp-engine-utils'
import { buildAgentIdentityBootstrap } from '../acp-engine-utils'
import {
  buildSessionBundle,
  buildSessionTuiSessionBundle,
  loadClaudeTuiCapabilities,
  loadCodexAppServerCapabilities,
  loadSessionTuiCapabilities,
} from '../capability-bundle'
import { writeCapabilityLoadReport } from '../capability-report-store'
import { GUGU_PLATFORM_BLOCK, buildSessionpageProjectContextBlock } from '../product-platform-prompt'
import { applySessionMaterialization } from '../session-materialization'
import {
  claudeRendezvousEnv,
  claudeRendezvousSock,
  claudeSessionDelivery,
  clearStaleRendezvousSock,
  toolsListedReadySource,
} from './claude-session-delivery'
import * as codexPtyProvisioning from './codex-pty-provisioning'
import type { CodexPtyOverride } from './codex-pty-provisioning'
import { droidDaemonSessionDelivery } from './droid-daemon-session-delivery'
import {
  assertSessionpageIdentityForReattach,
  emitSessionpageAgentProvisioned,
  isImplicitSessionHomeProjectId,
  provisionSessionpageAgentForSession,
  resolveSessionpageDeliveryOwnerKind,
  type SessionpageProvisionDeps,
} from './emdash-agent-provisioning'
import { guguMcpToolsListedGate } from './mcp-ready-gate'
import { opencodeServeAttachSessionDelivery } from './opencode-serve-attach-delivery'
import { buildOpencodeServeEnv } from './opencode-serve-attach-transport'
import { promoteSessionpageDeliveryOwner, restoreSessionpageOfflineDeliveryOwner } from './sessionpage-delivery-owner-registry'
import {
  claudeTuiSettingsArgs,
  sessionBundleModelFor,
  withPlatformDeclaration,
  type SessionpagePlatformModel,
} from './sessionpage-platform-model'
import type { SessionpagePlatformRecoveryCoordinator } from './sessionpage-platform-recovery'
import { edgeEndsTurn, type TurnLifecycleEdge } from './turn-lifecycle-relay'

// @@@sessionpage TASKPAGE-FUSION — the PTY-divert hook shapes (mirror emdash-pty-sessionpage-hook.ts across
// the module boundary; the host returns a command override to run `codex --remote … resume <tid>`).
// @@@2503 platformModel:composer 记在这个会话上的模型来源({modelId} = 平台;null = harness 自家模型;
// 字段缺失 = 本决定出现之前建的存量会话 → 回退 agent 级配置)。
export type SessionTuiStartInfo = { sessionId: string; start: 'fresh' | 'reattach'; providerId: string; cwd: string; projectId: string; workspaceId: string; sourceSessionId?: string; initialPrompt?: string; forkFromProviderSessionId?: string; resumeProviderSessionId?: string; isResuming?: boolean; onProviderSessionId?: (providerSessionId: string) => Promise<void>; onProviderSessionEndpoint?: (endpoint: string) => Promise<void>; onHarnessTitle?: (title: string) => void; baseCommand: string; baseArgs: string[]; model?: string; effort?: string; permissionMode?: GuguPermissionMode; platformModel?: { modelId: string } | null; agentDisplayName?: string; mcpDisabledServers?: readonly string[]; tmuxSessionName?: string }

export type SessionTuiHostOverride = CodexPtyOverride & { startupGate?: ReturnType<typeof guguMcpToolsListedGate> }

/** 宿主自己持有、各条腿都要的东西(主进程里的可变状态只经这里取,取的那一刻才读)。 */
export interface SessionTuiHostContext {
  readonly provisionDeps: SessionpageProvisionDeps & {
    onTurnLifecycle: (info: { sessionId: string; providerId: string; projectId?: string | null }, edge: TurnLifecycleEdge) => void
  }
  /** 没就绪就抛,`what` 是哪条腿在要。 */
  runtime(what: string): AcpEngineRuntimeContext
  mcpHost(what: string): DesktopGuguMcpHost
  /** 这条会话的 gugu 工具桥:grant key、宿主/会话动作,桥加载成功时还有 app_* 动作。 */
  socialBridge(info: SessionTuiStartInfo, host: DesktopGuguMcpHost): BuildSocialBridgeDeps
  platformRecovery(): SessionpagePlatformRecoveryCoordinator | null
  recordFailedSessionDirectMessage(
    params: { projectId: string; sessionId: string },
    message: { id: string; text: string },
    error: unknown,
  ): void
}

type HostSteps = { step(name: string): void; log(): void }

type HostStart = (
  ctx: SessionTuiHostContext,
  info: SessionTuiStartInfo,
  platformPromise: Promise<SessionpagePlatformModel>,
  steps: HostSteps,
) => Promise<SessionTuiHostOverride | null>

function lifecycleOf(info: SessionTuiStartInfo): 'resume' | 'fork' | 'fresh' {
  return info.resumeProviderSessionId ? 'resume' : info.forkFromProviderSessionId ? 'fork' : 'fresh'
}

function provisionTuiAgent(ctx: SessionTuiHostContext, info: SessionTuiStartInfo, deferProvisionedEvent: boolean) {
  return provisionSessionpageAgentForSession(
    {
      sessionId: info.sessionId,
      providerId: info.providerId,
      surface: 'tui',
      cwd: info.cwd,
      projectId: info.projectId,
      // spec agent-provisioning:显式命名过的会话用那个名字开户;缺席才落到「<引擎 label> <序号>」。
      displayName: info.agentDisplayName,
      ...(deferProvisionedEvent ? { deferProvisionedEvent: true } : {}),
    },
    ctx.provisionDeps,
  )
}

/** 物化能力包,并写下这次的加载报告。 */
async function materialize(
  info: SessionTuiStartInfo,
  guguHome: string | undefined,
  capabilities: Parameters<typeof applySessionMaterialization>[0]['materialization'] & {
    report: Parameters<typeof writeCapabilityLoadReport>[1]
  },
  step?: (name: string) => void,
): Promise<void> {
  await applySessionMaterialization({ cwd: info.cwd, guguHome: guguHome ?? '', materialization: capabilities })
  step?.('materialized')
  await writeCapabilityLoadReport({ kind: 'sessionpage', sessionId: info.sessionId }, capabilities.report, process.env)
  step?.('load-report-written')
}

// owner 定的产品预期:会话页里的每个会话都是一个 agent、都有身份可分享 —— GUI(ACP)和 TUI 都算。
// claude 的 TUI 没有 app-server 可接管(codex 才有),所以这里只落身份、不改 pty 命令:会话照原样跑,
// 但它在通讯录里是个真 agent、名片可分享。
//
// 投递能力与身份是两件事:身份一注册,session-page bridge 就认领这个 agent,投递走 injectMessage;
// TUI 会话不在 ACP 会话清单里 → 响亮失败。这正是要的 —— ❌ 绝不能让它落回 gugu 自己的引擎,那等于
// 另起一个进程假装是它在回话(错人)。
const startClaudeRendezvous: HostStart = async (ctx, info, platformPromise, { step, log }) => {
  const provisioned = await provisionTuiAgent(ctx, info, true)
  step('provisioned')
  // 身份到位就必须把工具一起给它(spec ⑨「有身份就能收消息」= 身份与可达性一体)。此前这里 return null,
  // 于是 claude TUI 有咕咕号却手无寸铁:owner 问它「能给这个 session 发消息吗」,它用 Claude Code 自带的
  // SendMessage 回「to 需要 agent name,不是 UUID」—— 它压根不知道自己有咕咕身份。现在按 claude 的方式
  // 加载本次 session 的版本化 plugin；不写 worktree `.mcp.json`、不启用 strict MCP,保留用户原生发现。
  if (!provisioned?.guguAgentUserId) return null
  let promoted = false
  try {
    const runtime = ctx.runtime('[sessionpage] claude TUI 注入')
    // 契约不匹配要说人话:dev 下 vite 会重建 main.js,但 sessionpage bridge 是整包产物 —— 只重启 dev
    // 不重建 bridge,这里就会拿到 undefined 的 baseArgs,然后在 spread 处炸成
    // 「baseArgs is not iterable」,报的是后果、指不到成因(实机踩到)。
    if (!info.baseCommand || !Array.isArray(info.baseArgs)) {
      throw new Error(
        '[sessionpage] claude TUI 注入:会话页 bridge 没传 baseCommand/baseArgs(产物太旧)—— 重建 sessionpage bridge:pnpm exec vite build',
      )
    }
    // grant 与就绪订阅必须落在**同一个** host、同一把 key 上:这里一次取定,下面两处都用它,❌ 各自再读一遍
    // (宿主的 MCP host 会在关闭/替换时变;await 之后重读就只是碰巧一致)。
    const mcpHost = ctx.mcpHost('[sessionpage] claude TUI 注入')
    const socialBridgeDeps = ctx.socialBridge(info, mcpHost)
    const bundle = await buildSessionBundle({
      runtime,
      agentUserId: provisioned.guguAgentUserId,
      sessionKey: info.sessionId,
      // pty / TUI 腿:这一维过去就恒为 null —— 这条腿的档不经会话包(各家走自己的
      // argv / settings)。显式写出来,好让「这条腿不带它」与「有人忘了接」不再同形。
      autonomy: null,
      promptBlocks: info.resumeProviderSessionId
        ? {}
        : {
            identity: await buildAgentIdentityBootstrap(
              runtime,
              provisioned.guguAgentUserId,
              // #5331 与 ACP 腿同一笔:刚铸出来的身份,persona 就在手里,
              // ❌ 别回头再读一趟 `identity.users`(实测 416 ms,挡在用户面前)。
              provisioned.agentIdentityFacts,
            ),
          },
      socialBridgeDeps,
    })
    step('session-bundle')
    // 写出版本化静态 plugin,并只在原 argv 尾部追加 adapter 参数;重建 argv 会丢掉初始任务文本
    // (钩子契约),TUI 就一轮都不跑、claude 不落盘会话,投递随后必然 `No conversation found`。
    const capabilities = loadClaudeTuiCapabilities(bundle, { cwd: info.cwd, lifecycle: lifecycleOf(info) })
    const ownerKind = resolveSessionpageDeliveryOwnerKind(info.providerId, 'tui')
    if (ownerKind !== 'native') {
      throw new Error(`[sessionpage] ${info.providerId} rendezvous adapter requires native delivery ownership`)
    }
    // 接回 tmux 里还在跑的 claude:它启动时装载的能力、写下的加载报告、守着的 rendezvous 通道都还是它的,
    // 这三件只在真的新起引擎时做(接回时重做 = 把新起的事实盖在一个没重启的进程上)。
    if (info.start === 'fresh') {
      await materialize(info, bundle.env.GUGU_HOME, capabilities, step)
      await clearStaleRendezvousSock(info.sessionId)
      step('rendezvous-sock-cleared')
    }
    const platform = await platformPromise
    const override = {
      command: info.baseCommand,
      args: [
        ...info.baseArgs,
        ...(capabilities.extraArgs ?? []),
        ...platform.clientArgs,
        ...await claudeTuiSettingsArgs(platform, [...info.baseArgs, ...(capabilities.extraArgs ?? [])]),
      ],
      env: {
        ...(capabilities.spawnEnv ?? {}),
        ...claudeRendezvousEnv(info.sessionId),
        ...platform.env,
        ...platform.spawnEnv,
      },
    }
    // 登记 ≠ 可投递:claude 进程还没 spawn,它连上 gugu MCP 还要约 2s(#5033)。就绪来源 = 宿主为这条
    // 会话的 grant 送出 tools/list;在那之前注入一律 not-live,那一刻由注册表踢 live 转换(#4896)。
    promoteSessionpageDeliveryOwner(
      provisioned.guguAgentUserId,
      () => claudeSessionDelivery.register({
        guguAgentUserId: provisioned.guguAgentUserId,
        sessionId: info.sessionId,
        cwd: info.cwd,
        chatId: provisioned.chatId ?? null,
        providerId: info.providerId,
      }, { readySource: toolsListedReadySource(mcpHost, socialBridgeDeps.grantKey, info.start) }),
    )
    step('argv+env-built')
    promoted = true
    emitSessionpageAgentProvisioned(provisioned.event)
    log()
    createLogger('sessionpage').info({
      sessionId: info.sessionId,
      agentUserId: provisioned.guguAgentUserId,
      cwd: info.cwd,
      rendezvous: claudeRendezvousSock(info.sessionId),
    }, 'SESSIONPAGE-FUSION: injected the gugu MCP into claude TUI via session plugin')
    return override
  } catch (error) {
    // Provisioning installs the native identity's offline blocker before this hook starts. If any
    // capability/materialization step fails before native promotion, restore that exact blocker and
    // remove compatibility claimants immediately; outer PTY lifecycle cleanup may not run on startup
    // errors, and allowing owner=null here would expose the gugu-native fallback.
    if (!promoted) {
      restoreSessionpageOfflineDeliveryOwner({
        guguAgentUserId: provisioned.guguAgentUserId,
        sessionId: info.sessionId,
      }, info.providerId)
    }
    throw error
  }
}

const startDroidDaemon: HostStart = async (ctx, info, platformPromise) => {
  const provisioned = await provisionSessionpageAgentForSession(
    {
      sessionId: info.sessionId,
      providerId: info.providerId,
      surface: 'tui',
      cwd: info.cwd,
      projectId: info.projectId,
      displayName: info.agentDisplayName,
    },
    ctx.provisionDeps,
  )
  if (!provisioned?.guguAgentUserId) {
    throw new Error(`[sessionpage] droid daemon provisioning did not create an agent for ${info.sessionId}`)
  }
  const providerSessionId = info.resumeProviderSessionId ?? info.sessionId
  const daemonEnv = await droidDaemonSessionDelivery.startSession({
    agentUserId: provisioned.guguAgentUserId,
    sessionId: info.sessionId,
    providerId: info.providerId,
    providerSessionId,
    cwd: info.cwd,
    ...(info.tmuxSessionName ? { tmuxSessionName: info.tmuxSessionName } : {}),
  })
  promoteSessionpageDeliveryOwner(
    provisioned.guguAgentUserId,
    () => droidDaemonSessionDelivery.register({
      agentUserId: provisioned.guguAgentUserId,
      sessionId: info.sessionId,
      providerId: info.providerId,
      providerSessionId,
      cwd: info.cwd,
      ...(info.tmuxSessionName ? { tmuxSessionName: info.tmuxSessionName } : {}),
    }),
  )
  emitSessionpageAgentProvisioned(provisioned.event)
  return {
    command: info.baseCommand,
    args: info.baseArgs,
    env: { ...daemonEnv, ...(await platformPromise).env, ...(await platformPromise).spawnEnv },
  }
}

// opencode 跑推理的不是用户看的 pty,而是 gugu 持有的 `opencode serve`;pty 里只跑
// `opencode attach <url> --session <id>` 渲染。所以和 codex app-server 同一个道理:平台中转、
// 指定模型、能力包必须落到 **serve** 那个进程的 env(OPENCODE_CONFIG_CONTENT),而不是 attach 客户端。
//
// 形状对标 droid(瘦):provision → 起 sidecar → 认领投递 owner → 宣告。比 droid 多出的、
// 都说得出出处的重量:①serve 读 OPENCODE_CONFIG_CONTENT 才拿到模型/中转/提示,所以要物化能力包
// (droid 的 daemon 自带配置通道);②serve 自己铸 `ses_…` id,起完才知道,要 learn-then-persist
// (droid 拿 conversationId 当 session id,无需回填);③投递收据经 SSE 结算(见 delivery 抬头);
// ④杀的是进程组(serve mid-turn 会拉起 bash/task 子进程)。
const startOpencodeServeAttach: HostStart = async (ctx, info, platformPromise, { step, log }) => {
  // serve 必须起好、投递 owner 必须认领,agent 才可宣告为「可投递」——否则首条消息会撞上
  // 一个 serve 还没起的 owner。与 claude-rendezvous 同一条纪律:把宣告压到最后。
  const provisioned = await provisionTuiAgent(ctx, info, true)
  if (!provisioned?.guguAgentUserId) {
    throw new Error(`[sessionpage] opencode serve provisioning did not create an agent for ${info.sessionId}`)
  }
  step('provisioned')
  const runtime = ctx.runtime('[sessionpage] opencode serve 能力注入')
  const mcpHost = ctx.mcpHost('[sessionpage] opencode serve 能力注入')
  const lifecycle = lifecycleOf(info)
  const platform = await platformPromise
  const bundle = await buildSessionTuiSessionBundle({
    bootstrap: {
      runtime,
      // `permissionMode` crosses this boundary unchanged; the coarse mode is projected from it.
      // OpenCode's provider materializer is the only place that interprets the exact tier into
      // its permission rules.
      autonomy: {
        mode: info.permissionMode === 'full-access' ? 'full-access' : 'approval-required',
        ...(info.permissionMode !== undefined ? { permissionMode: info.permissionMode } : {}),
      },
      additionalEnv: { ...platform.env, ...platform.spawnEnv },
      promptBlocks: {
        platform: `${GUGU_PLATFORM_BLOCK}${buildSessionpageProjectContextBlock(provisioned.projectContext)}`,
      },
    },
    identity: {
      agentUserId: provisioned.guguAgentUserId,
      promptBlocks: lifecycle === 'resume'
        ? {}
        : { identity: await buildAgentIdentityBootstrap(runtime, provisioned.guguAgentUserId, provisioned.agentIdentityFacts) },
      socialBridgeDeps: ctx.socialBridge(info, mcpHost),
    },
  })
  const capabilities = loadSessionTuiCapabilities(
    info.providerId,
    bundle,
    { cwd: info.cwd, lifecycle, isResuming: info.isResuming === true },
  )
  await materialize(info, bundle.env.GUGU_HOME, capabilities)
  // @@@4618-③ 回合边界要有一个消费者 —— 这条腿的「Working」徽标此前没有任何生产者。
  // serve 的 SSE 已经在解析 `session.status{busy}` / `session.idle` / `session.error`,终结事实
  // 早就在宿主手里;这里只是把它接到 codex 已经在用的那条 adapter 无关的 `onTurnLifecycle` 上。
  // ❌ 不给 serve 递 `GUGU_HOOK_*` 走工作区事件模块那条路:那是同一个事实的第二条通道,而且那个
  // 工件从不产出 `stop`；idle_prompt 也只回到 idle，不把正常结束的回合标成需要你。
  // 回合末恢复只跟结束回合的边走,等人不算。
  const relayServeTurnLifecycle = (turnLifecycle: TurnLifecycleEdge) => {
    ctx.provisionDeps.onTurnLifecycle(
      { sessionId: info.sessionId, providerId: info.providerId, projectId: info.projectId },
      turnLifecycle,
    )
    if (edgeEndsTurn(turnLifecycle)) {
      void ctx.platformRecovery()?.ensureReady(info.sessionId, 'turn-end').catch((error: unknown) => {
        createLogger('sessionpage/platform').warn({
          sessionId: info.sessionId,
          providerId: info.providerId,
          error: error instanceof Error ? error.message : String(error),
        }, '平台凭据回合结束后的延迟恢复失败')
      })
    }
  }
  // serve 的 env = 物化产出叠在 process.env 上(providerEnv 是白名单过滤,spawnEnv 不含 PATH 等基座)。
  // 与 droid 同形的 process.env 合并;OPENCODE_CONFIG_CONTENT 等物化键胜出。
  //
  // @@@task-home-config-isolation — cwd 是 gugu 自己的共享 task-home(隐式项目、无 repo)时,让 serve
  // 不扫 workspace `.opencode`(`OPENCODE_DISABLE_PROJECT_CONFIG`)。那个目录两条腿共用:acp 合法地
  // 往它写 event module(它需要且能容忍冷装),残留也堆在那;serve 的 `POST /session` 会为 workspace 里
  // 任何 `.opencode/plugins/*.js` 同步跑一次 `@opencode-ai/plugin` 冷装,慢过就绪预算就是那条间歇
  // `request timed out: POST /session`。serve 是 gugu 的推理进程,它的配置本就该只来自
  // `OPENCODE_CONFIG_CONTENT` + 用户全局配置,不该被这个共享 cwd 的内容拖住会话创建。
  // ⚠️ 只在 task-home 设:开在用户真 repo 里的 agent(projectId 非 sentinel)照旧读它自己的 repo
  // `.opencode` —— 那是承诺给用户的、且不走 task-home,不吃这条。判据抽成纯函数便于单测判红。
  const serveEnv = buildOpencodeServeEnv({
    processEnv: process.env,
    spawnEnv: capabilities.spawnEnv,
    isSessionHome: isImplicitSessionHomeProjectId(info.projectId),
  })
  step('bundle+materialized')
  const handle = await opencodeServeAttachSessionDelivery.startSession(
    {
      agentUserId: provisioned.guguAgentUserId,
      sessionId: info.sessionId,
      providerId: info.providerId,
      cwd: info.cwd,
      command: info.baseCommand,
      env: serveEnv,
      sessionCreatePatch: capabilities.sessionCreatePatch,
      onTurnLifecycle: relayServeTurnLifecycle,
      ...(info.tmuxSessionName ? { tmuxSessionName: info.tmuxSessionName } : {}),
      onSessionTitle: info.onHarnessTitle,
    },
    info.resumeProviderSessionId ?? null,
    info.forkFromProviderSessionId,
  )
  // serve 铸的原生 `ses_…` id 回填,续跑时 resumeProviderSessionId 才带得回同一会话。
  step('serve-ready')
  log()
  await info.onProviderSessionId?.(handle.providerSessionId)
  await info.onProviderSessionEndpoint?.(handle.url)
  promoteSessionpageDeliveryOwner(
    provisioned.guguAgentUserId,
    () => opencodeServeAttachSessionDelivery.register({
      agentUserId: provisioned.guguAgentUserId,
      sessionId: info.sessionId,
      providerId: info.providerId,
      cwd: info.cwd,
      command: info.baseCommand,
      env: serveEnv,
      nativeSessionId: handle.providerSessionId,
      sessionCreatePatch: capabilities.sessionCreatePatch,
      // 同一条 relay。⚠️ 它**不是**「serve 崩了会重启」的保护 —— `ensureServe` 命中缓存时直接返回旧
      // 那台,不会改它的回调。真正会用到这里的是:这个会话先被 unregister(binding 与 serve 一起没了),
      // 之后所有权重新 promote ⇒ 只剩 binding、没有 serve ⇒ 下一次 `ensureServe` **新建**一台,
      // 那台的回合边界就靠这一行。漏了它,重建出来的 serve 从此静默不发,而这种缺失没有任何报错。
      onTurnLifecycle: relayServeTurnLifecycle,
      ...(info.tmuxSessionName ? { tmuxSessionName: info.tmuxSessionName } : {}),
      onSessionTitle: info.onHarnessTitle,
    }),
  )
  emitSessionpageAgentProvisioned(provisioned.event)
  createLogger('sessionpage').info(
    {
      sessionId: info.sessionId,
      serveUrl: handle.url,
      providerSessionId: handle.providerSessionId,
    },
    'opencode serve/attach: serve ready, delivery owner promoted, attaching pty',
  )
  // A fresh delivery-bridge first turn has no argv slot: the attach pty only renders the
  // serve-owned session. Return its argv immediately; the model turn-start receipt is a
  // separate, fail-loud delivery result and must not hold the terminal hostage.
  const initialPrompt = info.initialPrompt
  if (!info.resumeProviderSessionId && initialPrompt?.trim()) {
    const startupMessageId = randomUUID()
    const reportStartupFailure = (error: unknown) => ctx.recordFailedSessionDirectMessage(
      { projectId: info.projectId, sessionId: info.sessionId },
      { id: startupMessageId, text: initialPrompt },
      error,
    )
    void opencodeServeAttachSessionDelivery.injectMessage(info.sessionId, initialPrompt).then(
      (receipt) => {
        void receipt.completion.catch(reportStartupFailure)
      },
      reportStartupFailure,
    )
  }
  // attach 只渲染:连本地 serve、不做推理、无登录门 ⇒ 只带平台中转层,❌ 不把 OPENCODE_CONFIG_CONTENT
  // 递给它(那是 serve 的配置)。argv 忽略 baseArgs —— 续跑/首条消息都改走 router(见 session-orchestration)。
  return {
    command: info.baseCommand,
    args: ['attach', handle.url, '--session', handle.providerSessionId],
    env: { ...platform.env, ...platform.spawnEnv },
  }
}

const startProviderSessionBundle: HostStart = async (ctx, info, platformPromise) => {
  const provisioned = await provisionTuiAgent(ctx, info, false)
  const runtime = ctx.runtime('[sessionpage] session TUI 能力注入')
  const lifecycle = lifecycleOf(info)
  const startupPolicy = resolveSessionTuiStartupPolicy(info.providerId)
  // 这条腿要把令牌写进 spawn env,还要按它推模型声明 ⇒ 在这里一次落地。
  const platformForBundle = await platformPromise
  const bootstrap = {
    runtime,
    // session-TUI 腿:档不经会话包(同上)。
    autonomy: null,
    additionalEnv: { ...platformForBundle.env, ...platformForBundle.spawnEnv },
    // 这条腿上模型走这一家自己的配置文件时,`platform.spawnEnv` 里一个模型键都没有
    // (宿主刻意不发),模型声明整份从这里下去 —— 判据与理由见 `sessionBundleModelFor`。
    model: sessionBundleModelFor(info.providerId, 'tui', platformForBundle),
    promptBlocks: {
      platform: `${GUGU_PLATFORM_BLOCK}${buildSessionpageProjectContextBlock(provisioned?.projectContext)}`,
    },
  }
  let identity: Parameters<typeof buildSessionTuiSessionBundle>[0]['identity'] = null
  let mcpHost: DesktopGuguMcpHost | null = null
  if (provisioned?.guguAgentUserId) {
    mcpHost = ctx.mcpHost('[sessionpage] session TUI 能力注入')
    identity = {
      agentUserId: provisioned.guguAgentUserId,
      // 续跑不重递身份:别家的提示块随引擎自己的会话记录走。提示块每次调用现插、不进历史的家
      // (`replayPromptBlocksOnResume`)续跑也得递,否则续跑起来就没了身份。
      promptBlocks: lifecycle === 'resume' && !startupPolicy.replayPromptBlocksOnResume
        ? {}
        : { identity: await buildAgentIdentityBootstrap(runtime, provisioned.guguAgentUserId, provisioned.agentIdentityFacts) },
      socialBridgeDeps: ctx.socialBridge(info, mcpHost),
    }
  }
  const bundle = await buildSessionTuiSessionBundle({ bootstrap, identity })
  const capabilities = loadSessionTuiCapabilities(
    info.providerId,
    bundle,
    // ⚠️ `isResuming` 与 `lifecycle` 分开传:后者由 resumeProviderSessionId 推,
    //    前者是 argv 里到底有没有续跑 flag。见 SessionMaterializationContext 抬头。
    { cwd: info.cwd, lifecycle, isResuming: info.isResuming === true },
  )
  await materialize(info, bundle.env.GUGU_HOME, capabilities)
  createLogger('sessionpage').info(
    {
      sessionId: info.sessionId,
      adapterId: capabilities.report.adapterId,
    },
    'materialized session TUI session capabilities through provider adapter',
  )
  // 首句走 local-session 的家:启动门 = 宿主为这条会话的 grant 送出 `tools/list`(与 claude TUI 的
  // 就绪来源同一个事实,#4896)。在 spawn 之前订阅 ⇒ 不会错过。没有 gugu MCP(没开户)就没有门,
  // 照旧按 PTY 输出活动判启动期。
  const startupGate = startupPolicy.startupTurnViaLocalSession && identity && mcpHost
    ? guguMcpToolsListedGate(mcpHost, identity.socialBridgeDeps.grantKey, info.sessionId)
    : undefined
  return {
    command: info.baseCommand,
    args: [...info.baseArgs, ...(capabilities.extraArgs ?? [])],
    env: capabilities.spawnEnv,
    ...(startupGate ? { startupGate } : {}),
  }
}

// Codex runs inference in a separate app-server, not in the pty the user watches, so the
// platform relay and the designated model have to reach THAT process. Handing them to the
// TUI client instead would leave the app-server on the composer's model and on whatever
// OPENAI_API_KEY happens to be in the environment — a session billed as platform quota
// while actually spending the user's own key.
const startCodexAppServer: HostStart = async (ctx, info, platformPromise, { step }) => {
  // codex 这条腿把令牌烤进 app-server 的 argv 与环境,整段都要它 ⇒ 在这里一次落地。
  const platformForCodex = await platformPromise
  step('platform-landed')
  return codexPtyProvisioning.provisionAndOverride(
    platformForCodex.model ? { ...info, model: platformForCodex.model } : info,
    {
      ...ctx.provisionDeps,
      loadCapabilities: async (agentUserId, chatId, model, autonomy, includePromptBlocks, projectContext, identityFacts) => {
        const runtime = ctx.runtime('[sessionpage] PTY divert')
        const mcpHost = ctx.mcpHost('[sessionpage] PTY divert')
        const bundle = await buildSessionBundle({
          runtime,
          agentUserId,
          sessionKey: info.sessionId,
          // spec `mcp-session-toggle`:这条腿(codex 的 app-server divert)**也要带** ——
          // 它才是产品上 codex 任务会话真正走的那条。只接 ACP 那条时,
          // codex 那格的开关静默失效:界面说关了、工具表纹丝不动。
          mcpDisabled: info.mcpDisabledServers,
          // Codex ignores OPENAI_BASE_URL, so the relay reaches it as a declared provider
          // built into the app-server's own argv — the environment alone would leave it
          // talking to api.openai.com with a Gugu session key. The window travels the same way
          // and for the same reason, which is why one function grafts the whole declaration.
          model: withPlatformDeclaration(model, platformForCodex),
          autonomy,
          additionalEnv: platformForCodex.env,
          promptBlocks: includePromptBlocks
            ? {
                platform: `${GUGU_PLATFORM_BLOCK}${buildSessionpageProjectContextBlock(projectContext)}`,
                identity: await buildAgentIdentityBootstrap(runtime, agentUserId, identityFacts),
              }
            : {},
          socialBridgeDeps: ctx.socialBridge(info, mcpHost),
        })
        const capabilities = loadCodexAppServerCapabilities(bundle, { cwd: info.cwd, lifecycle: lifecycleOf(info) })
        await materialize(info, bundle.env.GUGU_HOME, capabilities)
        return capabilities
      },
    },
  )
}

/** 不在表上的 adapter(例如 `kimi-web-rest-v1`)没有终端腿可起:响亮报错。 */
const HOST_STARTS: Partial<Record<SessionTuiHostAdapter, HostStart>> = {
  'claude-rendezvous-v1': startClaudeRendezvous,
  'droid-daemon-v1': startDroidDaemon,
  'opencode-serve-attach-v1': startOpencodeServeAttach,
  'provider-session-bundle': startProviderSessionBundle,
  'codex-app-server-v1': startCodexAppServer,
}

/**
 * 一条会话页终端腿起来之前,宿主按这一家的 host adapter 做的那一段(供给身份、能力包、sidecar、投递认领),
 * 交回要 spawn 的命令;`null` = 原样起。
 *
 * #5331 平台令牌 `platformPromise` 是一份**还在飞的承诺**,不是一个已经拿到的值:它(实测 1.4–2.2 s 的一次
 * 云签发)与这里做的事 —— 身份供给、能力包物化、sidecar 启动(实测 1.9–3.3 s)—— 互不依赖。每条腿只在
 * **真的要把它写进 spawn env / argv 的那一刻**才落地,于是两段并发。⚠️ 落地点必须留在各腿末尾,提到开头 = 又串回去了。
 */
export async function startSessionTuiHost(
  ctx: SessionTuiHostContext,
  info: SessionTuiStartInfo,
  platformPromise: Promise<SessionpagePlatformModel>,
): Promise<SessionTuiHostOverride | null> {
  // 第 19 条:接回的引擎手里还是发给旧身份的卡 —— 身份被撤过就不铸、不收,当场说清(每条终端腿都从这里过)。
  if (info.start === 'reattach') assertSessionpageIdentityForReattach(info.sessionId)
  // #5331 宿主段内部的台账 —— `pty sessionpage host steps` 只到「供给」这一层为止,
  // 而实测里供给只占其中一小半,剩下的从前没有名字。
  const startedAt = Date.now()
  const ledger: Array<[string, number]> = []
  let last = 0
  const steps: HostSteps = {
    step(name) {
      const at = Date.now() - startedAt
      ledger.push([name, at - last])
      last = at
    },
    log() {
      createLogger('sessionpage/pty-start').info({
        sessionId: info.sessionId,
        providerId: info.providerId,
        totalMs: Date.now() - startedAt,
        steps: Object.fromEntries(ledger),
      }, 'pty provider hook steps')
    },
  }
  const adapter = resolveSessionTuiHostAdapter(info.providerId)
  const start = HOST_STARTS[adapter]
  if (!start) throw new Error(`[sessionpage] unsupported session-TUI host adapter: ${adapter}`)
  return start(ctx, info, platformPromise, steps)
}
