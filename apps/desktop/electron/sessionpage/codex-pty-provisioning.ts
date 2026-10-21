// @@@sessionpage TASKPAGE-FUSION — TUI(pty)路 codex agent 的 provisioning + divert(spec ④ 原生 TUI +
// spec ⑧ 控制通道投递)。这是 ACP 路 setEmdashMcpInjector 闭包(main.ts)的 pty 孪生:会话页后端在 codex pty
// 会话启动处 await 本函数 —— 我们在 pty 拉起**之前**:
//   1. provision/resolve 该会话的 gugu agent 身份(复用 provisionSessionpageAgentForSession,不 fork),
//   2. 起一个 `codex app-server --listen <endpoint>`(Unix socket / Windows loopback WS),
//   3. 注册进 codexAppServerRegistry(delivery-bridge 优先路由 codex agent 到它),
//   4. 把 pty 命令 divert 成 `codex --remote <endpoint> …` —— 用户看到的原生 TUI 与投递用的是
//      同一个 app-server、同一个 thread(不同 WS 客户端),投递永不碰 pty。
//
// @@@6112 thread **一律由 TUI 载入**,咕咕从不在这台 app-server 上先载入它:
//   · 全新会话:TUI 新建(argv 不带 resume),咕咕从广播 `thread/started` 认领。
//   · 重新打开:TUI `resume <tid>` 载入,咕咕等官方广播 `thread/status/changed` 再订阅。
//   · fork:新 agent 的身份指令官方只认 start/fork 时给 ⇒ 咕咕在一台**临时** app-server 上带新指令
//     fork(当场落盘)、拆掉它,再按「重新打开」交给 TUI 载入。
//   为什么:TUI 在「一轮正在跑」时接进来,此后永久停在 `is_task_running = true`(实测 3/3;上游
//   openai/codex#43952,接入进行中会话官方不支持 #37967),rewind 的第一道闸正是它 ⇒ Esc-Esc 无反应。
//   咕咕若先载入,它的消息会立刻起轮,TUI 必然「中途加入」。
//   投递:空闲 → `thread/queue/add`(官方给外部程序往会话送消息的路,由服务端起轮);在跑 → `turn/steer`。
//   配置:改由 app-server **进程级 `-c`** 承载(codexThreadConfigProcessArgs)。
//   仍不覆盖:pty 崩溃重拉、而同一台 app-server 上恰有一轮在跑 —— 那是官方不支持的「接入进行中会话」。
//
// fail-loud:任一步失败即抛 → 会话启动失败,而非拉起一个投不进消息的 codex。
// 非 codex provider 立即返回 null(pty 行为原样不变)。
import type {
  Materialization,
  SessionAutonomyCapability,
  SessionModelCapability,
} from '../capability-bundle'
import type { GuguPermissionMode } from '@gugu/session-core/acp'
import { createLogger } from '../lib/logger'
import type { ProvisionedSessionpageAgent, SessionpageProvisionDeps } from './emdash-agent-provisioning'
import {
  emitSessionpageAgentProvisioned,
  provisionSessionpageAgentForSession,
} from './emdash-agent-provisioning'
import {
  demoteSessionpageDeliveryOwner,
  promoteSessionpageDeliveryOwner,
  restoreSessionpageOfflineDeliveryOwner,
} from './sessionpage-delivery-owner-registry'
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context'
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context'
import { closeRuntimeForkOwnership } from '@main/core/sessions/runtime-fork-ownership'
import { codexForkHandoffItems } from '../runtime/codex-fork-handoff.mjs'
import {
  CodexAppServerSession,
  CodexSessionClosedError,
  codexAppServerRegistry,
  type CodexTurnLifecycle,
} from './codex-app-server-delivery'
import { registerSessionpageSessionRuntime } from './sessionpage-session-runtime-registry'
import { backendSessionNameFor, findTmuxBackend, type TmuxBackend, type TmuxBackendDeps } from './tmux-backend'
import { parseCodexAppServerEndpoint, probeCodexAppServerEndpoint } from './codex-app-server-transport'

/** 测试缝:tmux 调用与进程探测。生产用默认那一份。 */
let tmuxBackendDepsForTest: TmuxBackendDeps | undefined

/**
 * #6264 上一个宿主留在 tmux 里的那台 app-server,还在原地址上应答 ⇒ 交给调用方接回;
 * 在、却不应答(卡死、半死)⇒ 收掉它,调用方照常新起一台。
 */
async function survivingCodexBackend(name: string): Promise<TmuxBackend | null> {
  const found = await findTmuxBackend(name, 'codex-app-server', tmuxBackendDepsForTest)
  if (!found) return null
  const endpoint = parseCodexAppServerEndpoint(found.endpoint)
  if (endpoint && await probeCodexAppServerEndpoint(endpoint)) return found
  createLogger('sessionpage/pty-start').warn({ name, pid: found.pid }, 'tmux 里的 codex app-server 不应答,收掉另起')
  await found.terminate()
  return null
}

/** `ProcessEnv` 允许 undefined 值,子进程 env 不允许 —— 丢掉没有值的那些。 */
function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 会话页后端交来的 pty 会话启动信息(取 gugu 需要的字段)。 */
export interface CodexPtyStartInfo {
  sessionId: string
  providerId: string
  cwd: string
  /** 该会话所属的会话页项目 / 任务(spec ⑨:项目 = 群)。provisioning 据此把 agent 放进对应项目群,
   *  并记在 roster 上供项目/任务级联删除时回收;无项目 → 该 agent 就是私聊身份,不进群。 */
  projectId?: string | null
  /** Product conversation owning this runtime-only fork; absent for ordinary PTY sessions. */
  sourceSessionId?: string
  /** Plugin-owned startup prompt for fresh delivery-bridge paths; injected through app-server before TUI attach. */
  initialPrompt?: string
  /** Provider-native Codex thread to fork. The sessionpage divert replaces `codex fork <id>`, so it must
   *  carry the source explicitly and perform the equivalent app-server RPC. */
  forkFromProviderSessionId?: string
  /** Existing Codex thread to resume after the app/session is reopened. */
  resumeProviderSessionId?: string
  /** Persist the actual app-server thread id before the create call returns to the renderer. */
  onProviderSessionId?: (providerSessionId: string) => Promise<void>
  /** codex 给 thread 起的名 → 会话标题(优先级由会话页后端那侧判)。 */
  onHarnessTitle?: (title: string) => void
  /** 会话页后端已解析好、正要 spawn 的 codex 可执行文件(通常是绝对路径,见 resolve-agent-executable.ts)。
   *  app-server 和 divert 后的 TUI 都必须用**它**:❌ 裸 `codex` 靠 PATH —— 打包后 GUI 进程的 PATH 只有
   *  `/usr/bin:/bin:/usr/sbin:/sbin`,装在 `~/.local/bin` 的 codex 必然 `spawn ENOENT`。claude 那条腿实机
   *  踩到过这个坑(投递无声重试到整轮执行失败)。 */
  baseCommand?: string
  /** 用户在 composer 上选的模型 / 推理强度。必须显式传进来:divert 整条换掉了 argv,会话页后端拼好的
   *  `-m` / `-c model_reasoning_effort=` 全丢了,只能经 bundle model 单元在 app-server loader 里重新下发。
   *  ❌ 别改成从 baseArgs 里反解:那是「重建 provider 命令」,会话页后端一改 flag 就漂(钩子契约自己写着)。 */
  model?: string | null
  effort?: string | null
  /** Composer permission tier, carried separately because the divert replaces provider argv. */
  permissionMode?: GuguPermissionMode
  /**
   * #6264 这条会话的 TUI 所在的 tmux 会话名(TUI 跑在 tmux 里时才有)。有它 ⇒ app-server 也住进 tmux、
   * 活过宿主进程重启,新宿主按名字接回(见 tmux-backend.ts);缺席 ⇒ 照旧做宿主的子进程。
   */
  tmuxSessionName?: string
}

/** 交回会话页后端的 pty 命令覆盖(divert 成 `codex --remote <endpoint> resume <tid>`)。 */
export interface CodexPtyOverride {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** 身份供给那一半就是宿主那份 SessionpageProvisionDeps,原样递给供给链(与其余各条腿同一份)。 */
export interface CodexPtyProvisionDeps extends SessionpageProvisionDeps {
  /** Materialize the session bundle for this app-server. */
  loadCapabilities: (
    agentUserId: string,
    chatId: string | null,
    model: SessionModelCapability,
    autonomy: SessionAutonomyCapability | null,
    includePromptBlocks: boolean,
    projectContext?: ProvisionedSessionpageAgent['projectContext'],
    /**
     * #5331 刚铸出来的身份,它的 persona 这一步就已经全知道 —— 递过去,别再为一个自己刚写下的
     * 事实跑一趟网络。实测:库放到 3 秒之外时,codex 编程面就卡在这一发 `identity.users` 查询上。
     */
    identityFacts?: ProvisionedSessionpageAgent['agentIdentityFacts'],
  ) => Promise<Materialization>
  onTurnLifecycle?: (info: CodexPtyStartInfo, lifecycle: CodexTurnLifecycle) => void
}

/** conversationId → 该会话的 app-server 投递会话(reopen/respawn 复用,保 thread 历史;stop 时 teardown)。 */
const sessions = new Map<string, {
  session: CodexAppServerSession
  guguAgentUserId: string
  deliveryBlocker: { guguAgentUserId: string; sessionId: string }
  env?: NodeJS.ProcessEnv
  rolloutReady: Promise<void>
}>()
type StartingSession = {
  controller: AbortController
  promise: Promise<CodexPtyOverride | null>
}
const startingSessions = new Map<string, StartingSession>()

async function awaitStartupPhase<T>(phase: Promise<T>, signal: AbortSignal, mark?: (ms: number) => void): Promise<T> {
  const at = Date.now()
  try {
    const result = await phase
    signal.throwIfAborted()
    return result
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    mark?.(Date.now() - at)
  }
}

/**
 * codex pty 会话启动的 hook:返回 pty 命令覆盖(divert),或 null(非 codex → 会话页后端原样起 pty)。
 * fail-loud:provision / app-server 起不来 / gugu MCP 构造失败都 THROW,由会话页后端冒成会话启动失败。
 */
export function provisionAndOverride(
  info: CodexPtyStartInfo,
  deps: CodexPtyProvisionDeps,
): Promise<CodexPtyOverride | null> {
  if (info.providerId !== 'codex') return Promise.resolve(null)
  const starting = startingSessions.get(info.sessionId)
  if (starting) return starting.promise
  const controller = new AbortController()
  const entry = {} as StartingSession
  const tracked = provisionAndOverrideOnce(info, deps, controller.signal).then(
    (result) => {
      if (startingSessions.get(info.sessionId) === entry) startingSessions.delete(info.sessionId)
      return result
    },
    (error) => {
      if (startingSessions.get(info.sessionId) === entry) startingSessions.delete(info.sessionId)
      throw error
    },
  )
  entry.controller = controller
  entry.promise = tracked
  startingSessions.set(info.sessionId, entry)
  return tracked
}

async function provisionAndOverrideOnce(
  info: CodexPtyStartInfo,
  deps: CodexPtyProvisionDeps,
  signal: AbortSignal,
): Promise<CodexPtyOverride | null> {
  signal.throwIfAborted()
  // 用会话页后端解析好的那个可执行文件(见 CodexPtyStartInfo.baseCommand)。契约不匹配要说人话:dev 下 vite 会
  // 重建 main.js,但 sessionpage bridge 是整包产物 —— 只重启 dev 不重建 bridge,这里就拿不到 baseCommand。
  const codexBin = info.baseCommand?.trim()
  if (!codexBin) {
    throw new Error(
      '[sessionpage] codex pty divert:会话页 bridge 没传 baseCommand(产物太旧)—— 重建 sessionpage bridge:pnpm exec vite build',
    )
  }

  // reopen / crash-respawn:同 conversation 已有 live app-server 会话 → 复用它(同一 tid resume,保历史),
  // 不另起 app-server、不新建 thread。app-server 与 pty 是两个进程,pty 崩了 app-server 仍活。
  // 复用路径不重下发 model/effort:它们是起 app-server 时的进程级 `-c` 覆盖,thread 已经按那份配置建好了。
  // 这不是缺口 —— pty 会话的模型/档位在会话创建时定死,会话页后端不提供「对已存在的 pty 会话改模型」的入口。
  let existing = sessions.get(info.sessionId)
  // 手上那台已经死了(进程退出、tmux 里被收掉):❌ 把一个指向死套接字的 `--remote` 交出去 —— 拆掉它,往下按
  // 「重新打开」新起(同一 thread resume)。
  if (existing && !existing.session.isLive() && !existing.session.isAwaitingTuiThread()) {
    await teardown(info.sessionId)
    existing = undefined
  }
  // @@@6112 新会话的 TUI 还没建出 thread 就被重拉(崩溃 / 关掉再开会话页):复用这台 app-server,
  // 让新 TUI 在它上面建 thread。❌ 不等 rolloutReady —— 它等的正是 TUI 建 thread,而 TUI 此刻还没起来。
  if (existing?.session.isAwaitingTuiThread()) {
    return {
      command: codexBin,
      args: existing.session.remoteTuiArgs(),
      env: existing.env,
    }
  }
  if (existing?.session.threadId) {
    await awaitStartupPhase(existing.rolloutReady, signal)
    await awaitStartupPhase(
      info.onProviderSessionId?.(existing.session.threadId) ?? Promise.resolve(),
      signal,
    )
    return {
      command: codexBin,
      args: existing.session.remoteTuiArgs(),
      env: existing.env,
    }
  }

  const forkThreadId = info.forkFromProviderSessionId?.trim() || undefined
  const resumeThreadId = info.resumeProviderSessionId?.trim() || undefined
  if (forkThreadId && resumeThreadId) {
    throw new Error(
      '[sessionpage] codex pty divert received both fork and resume thread ids (choose one)',
    )
  }
  const isFresh = !forkThreadId && !resumeThreadId
  // #5331 台账:codex 这条腿 spawn 前的三大发 —— 身份供给 / 能力包物化 / app-server 起 thread。
  const codexSteps: Record<string, number> = {}

  const provisioned = await awaitStartupPhase(provisionSessionpageAgentForSession(
    {
      sessionId: info.sessionId,
      providerId: info.providerId,
      surface: 'tui',
      cwd: info.cwd,
      projectId: info.projectId,
      deferProvisionedEvent: true,
    },
    deps,
  ), signal, (ms) => { codexSteps.provisioned = ms })
  if (!provisioned) return null

  const tmuxBackendName = backendSessionNameFor(info.tmuxSessionName) ?? undefined
  // #6264 上一个宿主进程留下的那台(TUI 一直连着它)。fork 永远是新会话,不接。
  const survivor = tmuxBackendName && !forkThreadId
    ? await awaitStartupPhase(survivingCodexBackend(tmuxBackendName), signal, (ms) => { codexSteps['tmux-survivor'] = ms })
    : null
  const makeSession = () => new CodexAppServerSession(
    provisioned.guguAgentUserId,
    codexBin,
    (lifecycle) => deps.onTurnLifecycle?.(info, lifecycle),
    {
      sessionId: info.sessionId,
      onThreadIdChanged: info.onProviderSessionId,
      ...(tmuxBackendName ? { tmuxBackendName } : {}),
      ...(tmuxBackendDepsForTest ? { tmuxBackendDeps: tmuxBackendDepsForTest } : {}),
      onThreadName: info.onHarnessTitle,
    },
  )
  let session = makeSession()
  const deliveryBlocker = {
    guguAgentUserId: provisioned.guguAgentUserId,
    sessionId: provisioned.event.sessionId,
  }
  let registered = false
  try {
    const capabilities = await awaitStartupPhase(deps.loadCapabilities(
      provisioned.guguAgentUserId,
      provisioned.chatId,
      {
        dialect: 'codex-config-flags',
        model: info.model ?? undefined,
        reasoningEffort: info.effort ?? undefined,
      },
      {
        mode: info.permissionMode === 'full-access' ? 'full-access' : 'approval-required',
        ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
      },
      !resumeThreadId,
      provisioned.projectContext,
      provisioned.agentIdentityFacts,
    ), signal, (ms) => { codexSteps['capabilities-loaded'] = ms })
    // gugu MCP、模型/推理强度/权限模式、身份 prompt 与 agent 事件 hook 的 `notify` 回调
      // 都由同一个 app-server loader 物化。
    //
    // @@@5380 notify 在 `threadConfig` 里(见 codex/session-bundle.ts),**不在 argv**:
    // #5301 起初用 `-c notify=…`,而 #5363 已把 MCP 迁到原生 thread-open `config` map ——
    // 两条并存就是同一个进程两扇门。物化器是唯一产出这份配置的地方。
    // 引擎进程(app-server sidecar)与这一家其余各条腿**同一份环境**(#5702)。
    // ❌ 从前它在 `codex-app-server-delivery.ts` 里铺 `{ ...process.env, ... }`:既拿不到用户
    //    在 Agents 设置里为 codex 填的环境变量,自己又比别的腿多带了一整个 process.env ——
    //    同一家 agent、同一台机器,编程腿的引擎和它的 TUI 跑在两个不同的环境里,并且不报错。
    //    实测读数(2026-09-16):TUI 进程拿得到设置里的变量,这条 sidecar 拿不到。
    // 编程腿(tui)的引擎 —— 与这条腿的 TUI 同一个程序(#6335 起按腿取程序)。
    // The sidecar owns the thread store as well as authentication. Resolve the same bound account
    // as the TUI, including runtime-only forks; a later default selection must not move its CODEX_HOME.
    const runContext = await resolveLocalAgentRunContext(info.providerId, {
      role: 'tui',
      sessionId: info.sessionId,
      sourceSessionId: info.sourceSessionId,
    })
    const engineOptions = {
      // 同一格的另一半:用户填的额外参数,补在物化器那几个之后。
      extraArgs: [...(capabilities.extraArgs ?? []), ...runContext.extraArgs],
      threadConfig: capabilities.threadConfig,
      threadStart: capabilities.threadStart,
      skillRoots: capabilities.skillRoots,
      env: composeAgentSpawnEnv(runContext, { providerEnv: definedEnv(capabilities.spawnEnv) }),
      developerInstructions: capabilities.developerInstructions,
    }
    // @@@6112 fork:新会话是**新 agent**,它的 developerInstructions(身份)官方只认 start/fork 时给,
    // resume 时给会被忽略 —— 所以只能由咕咕带着新指令 fork。但咕咕若在**这台** app-server 上 fork,
    // thread 就是咕咕载入的,排队的消息会立刻起轮、TUI 又成了「中途加入」。于是在一台**临时**
    // app-server 上 fork(fork 出来的 thread 当场落盘,codex 的设计如此),拆掉它,再把这条已在盘上的
    // thread 当成 resume 交给 TUI 载入 —— 与「重新打开」走同一条路。代价:fork 时多起一次 app-server。
    const forkOnScratchAppServer = async (): Promise<string> => {
      const scratch = new CodexAppServerSession(`${provisioned!.guguAgentUserId}:fork-scratch`, codexBin!)
      try {
        const forked = await scratch.start(info.cwd, { ...engineOptions, forkFromThreadId: forkThreadId })
        if (!forked) throw new Error('codex scratch app-server fork returned no thread id')
        // @@@fork-identity 新 agent 的身份指令 codex 不认(openai/codex#19045)⇒ 趁还在临时 app-server 上,
        // 往历史末尾补一条只含身份差异与交接说明的开发者消息;它随 thread 落盘,TUI 载入后照样生效。
        await scratch.injectItems(codexForkHandoffItems(engineOptions.developerInstructions))
        return forked
      } finally {
        await scratch.dispose()
      }
    }
    const tuiResumeThreadId = forkThreadId
      ? await awaitStartupPhase(forkOnScratchAppServer(), signal, (ms) => { codexSteps['scratch-fork'] = ms })
      : resumeThreadId
    // #6264 接回:不起进程、不重下发配置(它仍是上一个宿主起它时那一份,MCP 授权、平台中转口都稳定不变)。
    // 接不上 → 收掉那台,换一个干净的会话对象照常新起(同一 thread resume),❌ 让这次打开失败。
    let adopted: { threadId: string | null } | null = null
    if (survivor) {
      try {
        adopted = {
          threadId: await awaitStartupPhase(session.adopt(info.cwd, survivor, {
            threadId: resumeThreadId ?? null,
            extraArgs: engineOptions.extraArgs,
            threadStart: engineOptions.threadStart,
            threadConfig: engineOptions.threadConfig,
          }), signal, (ms) => { codexSteps['app-server-adopted'] = ms }),
        }
      } catch (error) {
        signal.throwIfAborted()
        createLogger('sessionpage/pty-start').warn(
          { sessionId: info.sessionId, err: String(error) },
          '接回 tmux 里的 codex app-server 失败 —— 收掉它,新起一台',
        )
        await survivor.terminate().catch(() => undefined)
        session = makeSession()
      }
    }
    const threadId = adopted
      ? adopted.threadId
      : await awaitStartupPhase(session.start(info.cwd, {
        ...engineOptions,
        // @@@6112 thread 一律由 **TUI** 载入(新建 / resume),咕咕从不先载入 —— 理由见 tuiLoads。
        ...(tuiResumeThreadId
          ? {
            tuiLoads: 'resume' as const,
            resumeThreadId: tuiResumeThreadId,
            // 会话记录里指定的模型(换模型重开 / 咕咕模型)优先于 thread 里存的旧模型。
            resumeModel: { model: info.model, reasoningEffort: info.effort },
          }
          : { tuiLoads: 'create' as const }),
      }), signal, (ms) => { codexSteps['app-server-thread'] = ms })
    createLogger('sessionpage/pty-start').info(
      { sessionId: info.sessionId, providerId: info.providerId, steps: codexSteps },
      'codex pty startup steps',
    )
    // tuiLoads='create' 下 threadId 还不存在(TUI 还没被 spawn)—— 它在下面那条后台续跑里落库。
    if (threadId) {
      await awaitStartupPhase(info.onProviderSessionId?.(threadId) ?? Promise.resolve(), signal)
    }
    promoteSessionpageDeliveryOwner(
      provisioned.guguAgentUserId,
      () => codexAppServerRegistry.register(provisioned.guguAgentUserId, session, info.providerId),
    )
    registered = true
    // @@@6112 第一轮改成「TUI 先起来、把 thread 建出来,咕咕再投进去」——**这一段刻意不 await**。
    //
    // 老时序是反的:咕咕建 thread → 投第一轮 → 等它 **started**(不是 completed)→ 这时才返回
    // spawn 描述符。那条路当时是被逼的:`codex --remote … resume <tid>` 认的是磁盘上的 rollout,
    // 而 rollout 要等**第一条用户消息**才落盘(对零回合 thread 做 resume,codex 直接回
    // `no rollout found for thread id …`)。代价是 TUI **必然在第一轮飞行中加入**,而飞行中加入的
    // TUI 此后永久停在 `is_task_running = true` —— rewind 的第一道闸正是这个标志,于是空闲时
    // 按两下 Esc 被当成「打断」处理,而此刻并没有回合在跑,屏幕一个字都不变(#6112)。
    // 实测:飞行中加入 3/3 复现;加入一条**已有历史**的空闲 thread 3/3 正常;中招的 TUI 自己再跑完一整轮也清不掉。
    //
    // 现在的顺序:立刻返回描述符 → pty 起 TUI → TUI 自己建 thread → 广播回来咕咕认领并按序接入
    // (adoptTuiThread → attachToAdoptedThread;waitForTuiThread 等的是接入完成)→ 才投第一轮。
    // 每一步都以上一步的返回为闸,第一轮的开始/结束通知必然送达。「中途加入」整件事消失,
    // 终端也不再等第一轮开始才出现。
    const firstTurnDelivered = isFresh
      ? (async () => {
        const tuiThreadId = await session.waitForTuiThread()
        await info.onProviderSessionId?.(tuiThreadId)
        if (!info.initialPrompt?.trim()) return
        // Fresh session-page Codex turns are declared delivery-bridge inputs: the composer bytes go
        // to the registered app-server, never into the pty.
        const receipt = await codexAppServerRegistry.tryInjectMessage(tuiThreadId, info.initialPrompt)
        if (!receipt) {
          throw new Error(`codex app-server session ${tuiThreadId} rejected its startup delivery`)
        }
        // 投进去了就算首轮投递成功;这一轮自己失败(如要会员被拒,#7092)由 TUI 当场显示,会话照常在。
        // 结局只记一笔 —— 没人接它就成了主进程的「未处理的 Promise 拒绝」。
        receipt.completion.catch((error: unknown) => {
          createLogger('sessionpage/pty-start').info(
            { sessionId: info.sessionId, err: String(error) },
            'codex 首轮没跑成(结局已显示在终端里)',
          )
        })
      })()
      : Promise.resolve()
    // 首轮失败不再能由 provisionAndOverride 抛出来(它已经返回了),但**善后一格都不能少**:
    // 老路上首轮失败会 THROW → 下面那圈 catch 摘掉 registry 并把 delivery blocker 放回离线态。
    // 少了它,这条会话会以「已注册、却永远收不到第一句」的样子挂在那儿 —— 投给它的消息静默
    // 排队,用户看到的是一个什么都没发生的终端。所以把同一套善后接到这条后台 promise 上。
    firstTurnDelivered.catch(async (error: unknown) => {
      // 会话是被关掉的(停止 / 归档 / 退出):善后由关它的那一方(teardown)负责,❌ 这里不再注销一遍、
      // 也不记成「首轮投递失败」。
      if (error instanceof CodexSessionClosedError) return
      createLogger('sessionpage/pty-start').error(
        { sessionId: info.sessionId, err: String(error) },
        'codex 首轮投递失败(TUI 建出 thread 之后)—— 拆掉这条 app-server 会话',
      )
      if (sessions.get(info.sessionId)?.session === session) {
        sessions.delete(info.sessionId)
      }
      try {
        await demoteSessionpageDeliveryOwner(
          deliveryBlocker,
          'codex',
          (replaceAfterRelease) => codexAppServerRegistry.unregister(
            provisioned.guguAgentUserId,
            replaceAfterRelease,
          ),
        )
      } catch (demoteError) {
        createLogger('sessionpage/pty-start').error(
          { sessionId: info.sessionId, err: String(demoteError) },
          'codex 首轮失败后的 delivery owner 善后也失败了',
        )
      }
    })
    sessions.set(info.sessionId, {
      session,
      guguAgentUserId: provisioned.guguAgentUserId,
      deliveryBlocker,
      env: capabilities.spawnEnv,
      rolloutReady: firstTurnDelivered,
    })
    emitSessionpageAgentProvisioned(provisioned.event)
    return {
      command: codexBin,
      args: session.remoteTuiArgs(),
      env: capabilities.spawnEnv,
    }
  } catch (err) {
    if (sessions.get(info.sessionId)?.session === session) sessions.delete(info.sessionId)
    if (registered) {
      await demoteSessionpageDeliveryOwner(
        deliveryBlocker,
        'codex',
        (replaceAfterRelease) => codexAppServerRegistry.unregister(
          provisioned.guguAgentUserId,
          replaceAfterRelease,
        ),
      )
    } else {
      try {
        await session.dispose()
      } finally {
        // Provisioning installs a compatibility row before the native app-server is live. If startup
        // fails before `promoteSessionpageDeliveryOwner`, preserve the identity as an offline session-TUI owner
        // instead of leaving it available to the native ACP fallback.
        restoreSessionpageOfflineDeliveryOwner(deliveryBlocker, 'codex')
      }
    }
    throw err
  }
}

/** 该 conversation 是否已有 live app-server(reopen 会复用它 —— 平台 token 亦须随之复用,不得轮换)。 */
export function hasLiveSession(sessionId: string): boolean {
  const session = sessions.get(sessionId)?.session
  // TUI 还没建出 thread 的新会话也是活的:它的 app-server 手里拿着平台 token,重拉时复用,不许轮换。
  return Boolean(session && (session.threadId || session.isAwaitingTuiThread()))
}

/** 会话真结束(stopSession / destroyAll)时 dispose app-server + 取消注册。detach(可重开)不调,留着复用。 */
export async function teardown(sessionId: string): Promise<void> {
  const starting = startingSessions.get(sessionId)
  const stopReason = new Error(`[sessionpage] codex session ${sessionId} stopped during startup`)
  starting?.controller.abort(stopReason)
  const tracked = sessions.get(sessionId)
  let cleanupError: unknown
  if (tracked) {
    const providerSessionId = tracked.session.threadId
    // unregister 内部会 dispose 该 session(kill app-server 进程 + 清 sock)。
    try {
      await demoteSessionpageDeliveryOwner(
        tracked.deliveryBlocker,
        'codex',
        (replaceAfterRelease) => codexAppServerRegistry.unregister(
          tracked.guguAgentUserId,
          replaceAfterRelease,
        ),
      )
    } catch (error) {
      cleanupError = error
    } finally {
      if (sessions.get(sessionId) === tracked) sessions.delete(sessionId)
      if (providerSessionId) await closeRuntimeForkOwnership(providerSessionId)
    }
  }
  if (starting) {
    try {
      await starting.promise
    } catch (error) {
      if (error !== stopReason && cleanupError === undefined) cleanupError = error
    }
  }
  if (cleanupError !== undefined) throw cleanupError
}

registerSessionpageSessionRuntime({
  name: 'codex-pty-provisioning',
  teardown,
})
