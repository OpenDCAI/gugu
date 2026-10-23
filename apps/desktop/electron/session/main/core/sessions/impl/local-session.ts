import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { diskWindowsShimReader } from '@gugu/session-core/exec';
import { isAutoApproveIntent, resolveSessionPermissionMode } from '@gugu/session-core/acp';
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import type { HookSource } from '@main/core/agent-hooks/hook-server';
import { ensureHooksInstalled } from '@main/core/agent-hooks/hook-config-service';
import { startPresenceInterrupt } from '@main/core/agent-hooks/presence-interrupt';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { setSessionAutoApproved } from '@main/core/agent-hooks/turn-autonomy';
import { localAgentForSession } from '@main/core/sessionpage/sessionpage-session-agent';
import {
  applySessionRuntimeCommand,
  assertSessionSurfaceDeclared,
  harnessSelfUpdateLaunch,
  HarnessStartupError,
  providerConsumesStartupPrompt,
  providerStartupTurnViaLocalSession,
  resolveSessionRuntimeCompatible,
  SessionRuntimeCompatibilityError,
} from '@gugu/session-core/agents/plugins';
import { workspaceTrustService } from '@main/core/agents/workspace-trust';
import { SessionPtySupervisor } from '@main/core/sessions/session-pty-supervisor';
import {
  resolveAgentSessionCommandArgs,
  resolveForkResumeCommandArgs,
} from '@main/core/sessions/resolve-agent-session-command';
import { recordProviderContinuationIntent } from '@main/core/sessions/provider-continuation-intent';
import { applyHarnessTitle } from '@main/core/sessions/renameSession';
import { setProviderSessionId } from '@main/core/sessions/set-session-id';
import { setSessionEndpoint } from '@main/core/sessions/set-session-endpoint';
import { emitSessionSpawnFailure } from '@main/core/sessions/spawn-failure';
import {
  type SpillLargePromptResult,
  spillLargePrompt,
} from '@main/core/sessions/spill-large-prompt';
import type { SessionProvider } from '@main/core/sessions/types';
import type { IExecutionContext } from '@gugu/session-core/exec';
import { isUnexpectedPtyExit } from '@main/core/pty/exit-classification';
import { spawnLocalPty } from '@main/core/pty/local-pty';
import type { Pty, PtyExitInfo } from '@main/core/pty/pty';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context';
import { buildAgentHookEnv } from '@main/core/pty/pty-env';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { logLocalPtySpawnWarnings, resolveLocalPtySpawn } from '@main/core/pty/pty-spawn-platform';
import { makePtyId } from '@main/core/pty/ptyId';
import {
  getTerminalColorEnv,
} from '@main/core/pty/terminal-color-scheme';
import {
  assertTmuxAvailable,
  killTmuxSession,
  makeTmuxSessionName,
  listTmuxSessionNames,
} from '@main/core/pty/tmux-session-name';
import {
  forgetSessionProcess,
  recordSessionProcess,
  sessionProcess,
  sessionsAliveInTmux,
} from '@main/core/sessions/session-process';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { Session, SessionMessage } from '@shared/core/sessions/sessions';
import { sessionDeliveryFailedChannel, sessionStartStageChannel } from '@shared/core/sessions/sessionEvents';
import { makePtySessionId, parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { sessionPlatformModel } from '../platform-model-selection';
import {
  closeRuntimeForkOwnershipForRuntimeSession,
  recordRuntimeForkOwnership,
} from '../runtime-fork-ownership';
import {
  getEmdashPtyChatStartupEnvelope,
  getEmdashPtySessionpageHook,
  notifyGuguPtySessionpageEnded,
} from './emdash-pty-sessionpage-hook';
import {
  injectSessionMessageWhenReady,
  injectSystemBootstrapWhenReady,
  planSystemBootstrap,
  setPtyStartupGate,
} from './keystroke-injection';
import { drainSessionMessageOutbox } from '../sendMessage';
import { LocalSessionAdmission } from './local-session-admission';
import { registerGuguMcpStdioRelayEntry } from '@main/worker-manifest';
import {
  replaceLiveWithOfflineForSession,
  registerLocalSessionDelivery,
  unregisterLocalSessionDelivery,
} from '@main/core/sessionpage/local-session-delivery';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RESPAWN_DELAY_MS = 500;
const autonomyDebugLogger = log.child({ scope: 'autonomy-debug' });

class LocalSessionGenerationStaleError extends Error {
  readonly kind = 'stale-local-session-generation';
}

/**
 * 被显式停止取消的一次启动:原因写明**等了多久、最后走完的是哪一步**(#6183)。
 * 版本探针被取消时它自己已经说清了卡在哪、等了多久,原样交出;其它步骤由这里补上位置。
 */
function describeCancelledStart(
  error: unknown,
  startedAt: number,
  marks: ReadonlyArray<[string, number]>,
): Error {
  if (error instanceof SessionRuntimeCompatibilityError && error.code === 'runtime-version-probe-cancelled') {
    return error;
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const lastStep = marks.at(-1)?.[0] ?? 'none';
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `Start cancelled after ${elapsed}s (last completed step: ${lastStep}): ${reason}`,
    { cause: error },
  );
}

function describeStartupExit({ exitCode, signal }: PtyExitInfo, providerSessionId: string | undefined): Error {
  const reason =
    signal !== undefined
      ? `signal ${String(signal)}`
      : exitCode !== undefined
        ? `exit code ${exitCode}`
        : 'an unknown exit status';
  return new HarnessStartupError(
    `Agent session failed to resume${providerSessionId ? ` thread ${providerSessionId}` : ''} (${reason}).`
      + ' Retry restoring this task; if the original thread was deleted, start a new task.',
  );
}

function notifySessionpageEndedFromExit(sessionId: string): void {
  void notifyGuguPtySessionpageEnded(sessionId).catch((error) => {
    log.error('LocalSessionProvider: session-page teardown failed after PTY exit', {
      sessionId,
      error: String(error),
    });
  });
}

function preserveLocalSessionDeliveryForSession(ptySessionId: string): void {
  const parsed = parsePtySessionId(ptySessionId);
  if (parsed) replaceLiveWithOfflineForSession(parsed.leafId);
}

export class LocalSessionProvider implements SessionProvider {
  private ptysBySession = new Map<string, Pty>();
  private knownPtySessionIds = new Set<string>();
  // A detached PTY is intentionally recoverable: its session identity remains addressable while no live
  // process exists. The marker lets the exit callback preserve that offline blocker after pty.kill().
  private detachedPtySessionIds = new Set<string>();
  private supervisor = new SessionPtySupervisor();
  private readonly projectId: string;
  private readonly sessionPath: string;
  private readonly workspaceId: string;
  // One hook source per agent process, not per PTY: a tmux-backed agent keeps running (and keeps
  // posting with the token it was started with) after the PTY that attached to it exits.
  private readonly hookSourcesByPtySession = new Map<string, HookSource>();
  private readonly resolveTmuxSetting: () => Promise<boolean>;
  private readonly shellSetup?: string;
  private readonly shellProfile: ResolvedShellProfile;
  private readonly ctx: IExecutionContext;
  private readonly sessionEnvVars: Record<string, string>;
  constructor({
    projectId,
    sessionPath,
    workspaceId,
    tmux = false,
    shellSetup,
    shellProfile,
    ctx,
    sessionEnvVars = {},
  }: {
    projectId: string;
    sessionPath: string;
    workspaceId: string;
    tmux?: boolean | (() => Promise<boolean>);
    shellSetup?: string;
    shellProfile: ResolvedShellProfile;
    ctx: IExecutionContext;
    sessionEnvVars?: Record<string, string>;
  }) {
    this.projectId = projectId;
    this.sessionPath = sessionPath;
    this.workspaceId = workspaceId;
    const initialTmux = typeof tmux === 'boolean' ? tmux : false;
    this.resolveTmuxSetting = typeof tmux === 'function' ? tmux : async () => initialTmux;
    this.shellSetup = shellSetup;
    this.shellProfile = shellProfile;
    this.ctx = ctx;
    this.sessionEnvVars = sessionEnvVars;
  }

  async sendMessage(
    session: Session,
    message: SessionMessage,
  ): Promise<{ status: 'not-ready' } | { status: 'accepted'; messageId: string }> {
    const ptySessionId = makePtySessionId(session.projectId, session.id, session.id);
    const pty = this.ptysBySession.get(ptySessionId);
    if (!pty) return { status: 'not-ready' };
    return injectSessionMessageWhenReady({ pty, session, message });
  }

  async startSession(
    session: Session,
    initialSize: { cols: number; rows: number } = {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    },
    isResuming: boolean = false,
    initialPrompt?: string,
    forkFromProviderSessionId?: string
  ): Promise<void> {
    return this.startSessionInternal(
      session,
      initialSize,
      isResuming,
      initialPrompt,
      false,
      forkFromProviderSessionId
    );
  }

  /**
   * 一条会话同一时刻只有一次启动在飞;后到的调用者**加入**它、拿它的结局(#6183)。
   *
   * ⚠️ 此前后到者在 `beginStart` 返回空时直接 return,于是它读到的是「起来了」—— 新建任务时
   * 会话页那次 hydrate 恰好是后到者:在飞的那次启动卡住 / 失败 / 被取消,等在界面前的这一方
   * 都拿到一个成功,界面停在「正在启动会话…」永远转(mac1 实测)。
   */
  private readonly startsInFlight = new Map<string, Promise<void>>();

  private startSessionInternal(
    session: Session,
    initialSize: { cols: number; rows: number },
    isResuming: boolean,
    initialPrompt: string | undefined,
    requireDesired: boolean,
    forkFromProviderSessionId?: string
  ): Promise<void> {
    const ptySessionId = makePtySessionId(session.projectId, session.id, session.id);
    // 只加入**仍然当前**的那次:stop() 已经取消了它(换模型重开 = stop 再 start)时,新的启动要真的起。
    const inFlight = this.startsInFlight.get(ptySessionId);
    if (inFlight && this.supervisor.hasStartInFlight(ptySessionId)) return inFlight;
    const run = this.startSessionOnce(
      session,
      initialSize,
      isResuming,
      initialPrompt,
      requireDesired,
      forkFromProviderSessionId
    ).finally(() => {
      if (this.startsInFlight.get(ptySessionId) === run) this.startsInFlight.delete(ptySessionId);
    });
    this.startsInFlight.set(ptySessionId, run);
    return run;
  }

  private async startSessionOnce(
    session: Session,
    initialSize: { cols: number; rows: number },
    isResuming: boolean,
    initialPrompt: string | undefined,
    requireDesired: boolean,
    // Only the initial fork spawn carries the source id; later spawns resume the child id.
    forkFromProviderSessionId?: string
  ): Promise<void> {
    const ptySessionId = makePtySessionId(session.projectId, session.id, session.id);
    this.knownPtySessionIds.add(ptySessionId);
    this.detachedPtySessionIds.delete(ptySessionId);

    const spawnSize = ptySessionRegistry.getLastSize(ptySessionId) ?? initialSize;
    const spawnToken = this.supervisor.beginStart(ptySessionId, {
      requireDesired,
      mode: isResuming ? 'resume' : 'fresh',
    });
    if (!spawnToken) return;
    let spill: SpillLargePromptResult | undefined;
    let sessionpageHostLifecycleStarted = false;
    let spawnAccepted = false;
    const plugin = getPlugin(session.providerId);
    let stopTrackingProviderSession: (() => void) | undefined;
    let tmuxEnabled = false;
    let admission: LocalSessionAdmission | undefined;
    let hookSource: HookSource | undefined;
    let stopPresence: (() => void) | undefined;
    const releaseHookSource = (): void => {
      if (!hookSource) return;
      const registered = this.hookSourcesByPtySession.get(ptySessionId);
      if (registered !== hookSource) {
        // Never registered (this spawn was rejected) or already superseded: nothing else is using
        // these credentials, and the agent that held them is gone.
        hookSource.dispose();
        return;
      }
      // Under tmux the agent outlives the PTY that attached to it, so its credentials are revoked by
      // stopSession — the call that actually kills that session. Read the session's process fact, not
      // this spawn's closure: the setting can differ between two generations of one session.
      if ((sessionProcess(session.id)?.home ?? (tmuxEnabled ? 'tmux' : 'host')) === 'tmux') return;
      this.hookSourcesByPtySession.delete(ptySessionId);
      hookSource.dispose();
    };
    // #5331 启动台账:TUI 腿 spawn 之前每一段各花多少。与 ACP 腿的 `sessionpage/acp-start` 同形,
    // 一行一条会话,❌ 不逐段打日志(会淹没真实事件)。
    const startedAt = Date.now();
    const marks: Array<[string, number]> = [];
    let lastMark = 0;
    const mark = (name: string): void => {
      const at = Date.now() - startedAt;
      marks.push([name, at - lastMark]);
      lastMark = at;
    };
    try {
      tmuxEnabled = await this.resolveTmuxSetting();
      mark('tmux-setting');
      if (tmuxEnabled && process.platform !== 'win32') {
        await assertTmuxAvailable(this.ctx, `session ${session.id}`);
      }
      // A detached tmux attachment does not prove that its child process ended, so
      // onExit cannot validate identity there. The next hydrate/replacement is the
      // fail-loud boundary: a fork lineage must never resume-last or start fresh.
      if (isResuming && session.forkedFrom) {
        resolveForkResumeCommandArgs(session);
      }
      const workspaceTrust = await workspaceTrustService.maybeAutoTrust({
        providerId: session.providerId,
        workspacePath: this.sessionPath,
        host: { kind: 'local', homedir: homedir() },
        force: isAutoApproveIntent(session),
        autoApprove: isAutoApproveIntent(session),
      });
      mark('workspace-trust');
      // 随 app 发的程序入口是应用级事实:终端腿的物化器(本次 spawn 前、同一进程里)要把中继的路径写进
      // 托管的全局 MCP 配置(Antigravity,#6335)。幂等,已有值不覆盖。
      registerGuguMcpStdioRelayEntry();
      const sessionpageHook = getEmdashPtySessionpageHook();
      assertSessionSurfaceDeclared({
        providerId: session.providerId,
        surface: 'tui',
        descriptor: plugin.capabilities.sessionBundle,
      });
      const hostOwnsEventModule = Boolean(
        sessionpageHook
        && (
          plugin.capabilities.sessionBundle.extension.kind === 'event-module'
          || plugin.capabilities.sessionBundle.sessionpage['tui']?.hostAdapter
            === 'opencode-serve-attach-v1'
        )
      );
      const agentSession = resolveAgentSessionCommandArgs(session, isResuming);

      // 这一家跑起来是什么样 —— 与聊天腿、登录、模型探针**同一个**算法(#5702)。
      // ❌ 别在这里另拼 `resolveAgentExecutable` 的入参、也❌ 别另拼一份 env:
      //    那正是「终端腿吃得到设置里的额外参数、聊天腿吃不到」的由来。
      const runContext = await resolveLocalAgentRunContext(session.providerId, {
        sessionId: session.id,
        sourceSessionId: session.forkedFrom?.sessionId,
        // 终端腿的程序 —— 被伴随程序认领时就是它(#6335,Antigravity 的 `agy`)。
        role: 'tui',
        shellProfile: this.shellProfile,
      });
      // 解析器对这一家可执行文件的诊断(没装 / 正在更新):harness 那一侧的事,原话给人看(#7103)。
      if (runContext.cli.kind === 'unresolved') throw new HarnessStartupError(runContext.cli.message);
      const executableCli = runContext.cli.path;
      mark('agent-executable');
      // #6183 版本探针等进程退出,不设墙钟 ⇒ 这一步要看得见(会话页显示「正在检查 <引擎>」)、
      // 能取消(`stopSession` → supervisor abort 这次启动的信号 → 探针被收掉,原因写明等了多久)。
      events.emit(sessionStartStageChannel, {
        sessionId: session.id,
        stage: 'checking-executable',
        executable: executableCli,
        since: Date.now(),
      });
      const compatibleRuntime = await resolveSessionRuntimeCompatible({
        providerId: session.providerId,
        surface: 'tui',
        descriptor: plugin.capabilities.sessionBundle,
        executable: executableCli,
        executionContext: this.ctx,
        runtimeExecutable: runContext.runtimeExecutable,
        // 经 node 起的家(pi)在 Windows 上要从 `.cmd` 壳读出 JS 入口再交给 node(#6390)。
        windowsShimReader: diskWindowsShimReader,
        signal: spawnToken.signal,
      }).finally(() => {
        events.emit(sessionStartStageChannel, { sessionId: session.id, stage: null });
      });
      mark('runtime-compatible');
      // hook 在版本探针之后装:有的 hook 键只在某个 harness 版本之后才被认(HookSpec.sinceVersion),
      // 版本取自刚才对**这一次将要 spawn 的那个可执行文件**的探针,❌ 另探一次、❌ 默认按新版本写。
      // 写不写、写到哪由 descriptor 的 hooks.scope 决定(`session` 的家一个字节都不写,含 codex 那条
      // 会话级 `notify` 覆盖),❌ 这里不按 provider 名字另开例外。
      if (!hostOwnsEventModule) {
        await ensureHooksInstalled({
          providerId: session.providerId,
          sessionPath: this.sessionPath,
          harnessVersion: compatibleRuntime.harnessVersion,
        });
      }

      // 对话页「新建 Agent」的首句是**一条真的咕咕消息**(spec delivery-routing:聊天页新建 agent
      // 的人类首句对声明 startup channel 的非 Codex PTY provider 在 spawn 时消费 chat delivery
      // envelope,并以同一稳定 message id 写入聊天实体行)。所以在 buildCommand 之前先经宿主的
      // 注入器边界把 DM 开好、消息落库、标记已读,拿回同一份 route=chat 信封,再交给这一家自己的
      // 启动槽 —— ⇒ 模型收到的是启动那一刻的第一轮,聊天页有正常气泡,回复落回那条 DM。
      //
      // ⚠️ 信封只在 spawn 这一刻**临时构造**,❌ 不写进持久化的 `config.initialPrompt`
      //    (spec agent-create 原文);落库的一直是裸文本 + 稳定 message id。
      // ⚠️ 装了钩子却解析不出信封 ⇒ **抛**。❌ 不许悄悄退回裸文本:退回去那一轮会以「不是消息」
      //    的身份进模型,而用户在聊天页看到的仍是一条消息 —— 两边就此分叉,且不报错。
      // ⚠️ 这道闸必须**自己再判一次**「这一家真的吃启动 prompt 吗」,❌ 不能只信渲染进程当初的选路。
      //    反例是可达的:一条对话页会话建成时 provider 声明 `argv`(于是带上了 startupOrigin +
      //    initialMessageId),之后那一家的声明被改成 `keystroke`(本 PR 对 kimi 做的正是这种改动)——
      //    `restart-session.ts` 会原样保留 startupOrigin/initialMessageId 并重新给出 initialPrompt,
      //    于是 `planSystemBootstrap` 返回 `{ readyText: <信封> }`,**整个 route=chat 信封会被打进 pty**
      //    —— 正是本 PR 与 [[session-injection]]「禁止写 pty」要判死的那件事。
      //    ACP 腿早有对称的闸(main.ts:`initialMessageId && !startupOrigin` 即抛),PTY 腿补上。
      const chatPageFirstTurn = !agentSession.isResuming
        && (session.startupOrigin === 'chat-page' || Boolean(session.taskChatId))
        && Boolean(session.initialMessageId)
        && Boolean(initialPrompt?.trim());
      // 首句由宿主在就绪之后经 local-session 注入的家(`providerStartupTurnViaLocalSession`):那条注入就是
      // 这条腿平常收咕咕消息的那条路(对话页的后续消息同样是信封写进 pty),信封走它不是降级。
      const startupTurnViaLocalSession = providerStartupTurnViaLocalSession(
        plugin.capabilities.prompt,
        plugin.capabilities.sessionBundle.sessionpage['tui']?.messageTransport,
      );
      if (
        chatPageFirstTurn
        && !providerConsumesStartupPrompt(plugin.capabilities.prompt, 'pty')
        && !startupTurnViaLocalSession
      ) {
        throw new Error(
          `chat-page first turn for ${session.id} carries a startup message id, but provider `
          + `${session.providerId} declares no argv/stdin startup channel `
          + `(prompt.kind=${plugin.capabilities.prompt.kind}) — refusing to keystroke the delivery envelope`
        );
      }
      let startupPrompt = initialPrompt;
      if (chatPageFirstTurn) {
        const resolveChatStartupEnvelope = getEmdashPtyChatStartupEnvelope();
        if (!resolveChatStartupEnvelope) {
          throw new Error(
            `chat-page first turn for ${session.id} has no host envelope resolver installed`
          );
        }
        startupPrompt = await resolveChatStartupEnvelope({
          sessionId: session.id,
          providerId: session.providerId,
          projectId: session.projectId,
          workspaceId: this.workspaceId,
          cwd: this.sessionPath,
          agentDisplayName: session.agentDisplayName,
          messageId: session.initialMessageId!,
          text: initialPrompt!,
          taskChatId: session.taskChatId,
        });
      }

      // Very large prompts (e.g. a full Linear issue + activity context) can blow
      // past OS argument limits and crash the underlying CLI. Spill them to a temp
      // markdown file and hand the agent a short pointer message instead (ENG-1546).
      // ⚠️ 对话页首轮**不 spill**:spill 会把正文换成一个指向临时文件的短句,而那一轮的正文是
      //    投递信封本身 —— 换掉它等于把「这是一条谁发来的咕咕消息」整个丢掉,agent 只会看到一个
      //    文件路径。信封超限属于 argv 限制,该响亮失败,❌ 不该静默降级成另一种语义。
      if (!agentSession.isResuming && initialPrompt && !chatPageFirstTurn) {
        spill = await spillLargePrompt(initialPrompt);
      }
      mark('startup-envelope+spill');
      const effectiveInitialPrompt = spill?.prompt ?? startupPrompt;
      // 首句走 local-session 的家:❌ 不进启动参数,spawn 之后过了启动门再注入(见下面 `startupTurnText`)。
      const startupTurnText = !agentSession.isResuming && startupTurnViaLocalSession
        ? effectiveInitialPrompt
        : undefined;
      const bootstrap = planSystemBootstrap(
        agentSession.isResuming || startupTurnViaLocalSession ? undefined : effectiveInitialPrompt,
        plugin.capabilities.prompt.kind,
      );

      if (forkFromProviderSessionId && plugin.capabilities.sessions.childId === 'provider-minted') {
        // Claude mints the child transcript id after the fork process starts. This intent is
        // needed for both product forks (which already have `forkedFrom`) and runtime-only
        // continuations; without it, recovery can only resume the placeholder conversation id
        // and loses the child history after the lease is replaced.
        await recordProviderContinuationIntent({
          sessionPath: this.sessionPath,
          sessionId: session.id,
          sourceProviderSessionId: forkFromProviderSessionId,
        });
      }

      // 分叉由这一家在**自己的存档**上做(命令行上没有分叉参数的家,Antigravity `agy`,见
      // `ISessionsBehavior.forkSessionInStorage`):先复制出子会话、记成这条会话的原生 id,
      // 再按普通续跑(`resumeFlag <子 id>`)起进程 —— argv 上从头到尾不出现来源 id。
      // 首启失败后重试时子会话已经复制过(原生 id 已是它),❌ 再复制一份。
      let storageForkedProviderSessionId: string | undefined;
      const storageFork = plugin.behavior?.sessions?.forkSessionInStorage;
      if (forkFromProviderSessionId && storageFork) {
        const current = session.providerSessionId;
        if (current && current !== forkFromProviderSessionId && current !== session.id) {
          storageForkedProviderSessionId = current;
        } else {
          const forked = await storageFork({
            sourceProviderSessionId: forkFromProviderSessionId,
            cwd: this.sessionPath,
            // 与 spawn 同一份配置根(`GEMINI_HOME` 这类),存档跟着它挪。
            env: { ...runContext.env, ...runContext.configRootEnv },
            homeDir: homedir(),
          });
          const persisted = await setProviderSessionId(session.id, forked.providerSessionId);
          if (!persisted.success) {
            throw new Error(
              `failed to persist forked provider session id for ${session.id}: ${persisted.error.type}`
            );
          }
          session.providerSessionId = forked.providerSessionId;
          storageForkedProviderSessionId = forked.providerSessionId;
          if (session.forkedFrom?.sessionId) {
            await recordRuntimeForkOwnership({
              runtimeSessionId: session.id,
              sourceSessionId: session.forkedFrom.sessionId,
              provider: session.providerId,
              providerSessionId: forked.providerSessionId,
              workspaceId: this.workspaceId,
              cwd: this.sessionPath,
            });
          }
        }
        mark('storage-fork');
      }
      // argv 上到底有没有续跑 flag:存档分叉之后是「续跑子会话」。
      const commandResuming = agentSession.isResuming || storageForkedProviderSessionId !== undefined;

      // #5331 台账:平台模型这一发从前是 sessionpage hook 的**参数表达式**,无法单独计时。
      const platformModelForSpawn = await sessionPlatformModel(session.id);
      mark('platform-model');
      // 推理档旗标与 ACP 那条腿同一条规则:原样是记录里那一档(见 host.ts readSessionInjectionFacts,#6447);
      // 物化进配置文档的那一档在签发之后按模型收窄(platformArmedEffort)。
      const launchEffort = session.effort;

      const permissionMode = resolveSessionPermissionMode(session);
      let agentCommand = plugin.behavior.prompt!.buildCommand({
        cli: executableCli,
        extraArgs: runContext.extraArgs,
        // 档位与界面、聊天面板腿同一个答案,恒显式递到 argv:没有档位的记录(导入的)按编辑档再传。
        // ❌ 缺席就不传 —— 不加旗标不是任何一档,是 harness 自己挑(#7366)。
        permissionMode,
        initialPrompt: bootstrap.commandText,
        cliSessionId: agentSession.cliSessionId,
        providerSessionId: session.providerSessionId ?? undefined,
        forkFromProviderSessionId: storageForkedProviderSessionId ? undefined : forkFromProviderSessionId,
        isResuming: commandResuming,
        model: session.model ?? '',
        effort: launchEffort ?? '',
      });
      agentCommand = applySessionRuntimeCommand(agentCommand, {
        harnessExecutable: compatibleRuntime.executable,
        runtimeExecutable: compatibleRuntime.runtimeExecutable,
      });
      // 工作区信任走 argv 的家(`trust.channel = 'runtime-argv'`,mimocode 的 `--trust`)在这里
      // 追加到命令行尾部。追加要在 sessionpage hook 之前:各 host adapter 都以 baseArgs 为底,
      // 这样信任旗标在 divert / append 两种路径上都随行。没有的家是空数组。
      if (workspaceTrust.args.length > 0) {
        agentCommand = { ...agentCommand, args: [...agentCommand.args, ...workspaceTrust.args] };
      }
      // 关自更新走 argv 的家(`selfUpdate.kind = 'session-argv'`,#6186)同样追加在这里;env 那一种已在
      // runContext 里。整条替换 argv 的宿主(codex `--remote`)在自己的 argv 里读同一份声明。
      const selfUpdateArgs = harnessSelfUpdateLaunch(plugin.capabilities.sessionBundle).args;
      if (selfUpdateArgs.length > 0) {
        agentCommand = { ...agentCommand, args: [...agentCommand.args, ...selfUpdateArgs] };
      }
      // spec hook-status-derivation:记下这条 argv 上到底有没有 auto-approve flag。
      // 这是「一条 permission 通知算不算阻塞在人」唯一的判据来源 —— ❌ 别在下游按会话配置
      // 再推一遍那个决定,resume 跳过 flag / harness 没声明 flag 时两者会分叉。
      setSessionAutoApproved(session.id, agentCommand.autoApproved === true);

      // @@@sessionpage TASKPAGE-FUSION — session-page codex DIVERT (spec ④ native TUI + ⑧ control-channel
      // delivery). For a codex conversation, the gugu host starts a `codex app-server` (+ gugu MCP) and
      // returns `codex --remote <endpoint> resume <tid>`, so the visible TUI and the delivery channel
      // (Unix socket or Windows loopback WebSocket) are the SAME codex session (delivery never writes the pty). ?.()-guarded: hook unset or a
      // non-codex provider → null → the original buildCommand argv spawns unchanged (no regression).
      if (process.env.GUGU_DEBUG_AUTONOMY === '1') {
        autonomyDebugLogger.warn('durable session entering PTY hook', {
          sessionId: session.id,
          type: session.runtime,
          permissionMode: session.permissionMode,
          isResuming: agentSession.isResuming,
        });
      }
      // 接回还是新起,在钩子之前定下来:钩子要据此决定做不做新起才做的事(物化能力、重签平台票……)。
      // 与 tmux 启动行里 `has-session || new-session` 是同一个判据;tmux 调用失败就抛,❌ 当成「不在」去新起。
      const tmuxSessionName = tmuxEnabled ? makeTmuxSessionName(ptySessionId) : undefined;
      const start: 'fresh' | 'reattach' =
        tmuxEnabled && sessionsAliveInTmux(await listTmuxSessionNames(this.ctx)).has(session.id) ? 'reattach' : 'fresh';
      const sessionpageOverride = await sessionpageHook?.({
        sessionId: session.id,
        start,
        providerId: session.providerId,
        cwd: this.sessionPath,
        projectId: session.projectId,
        workspaceId: this.workspaceId,
        initialPrompt: agentSession.isResuming ? undefined : effectiveInitialPrompt,
        sourceSessionId: session.forkedFrom?.sessionId,
        forkFromProviderSessionId,
        resumeProviderSessionId: agentSession.isResuming
          ? session.providerSessionId
          : undefined,
        // #6264 TUI 住在 tmux 里 ⇒ 宿主把它的推理后台也放进 tmux(同名配对),活过宿主进程重启。
        ...(tmuxEnabled && process.platform !== 'win32'
          ? { tmuxSessionName: makeTmuxSessionName(ptySessionId) }
          : {}),
        onHarnessTitle: (title) => {
          try {
            applyHarnessTitle(session.id, title);
          } catch (error) {
            log.warn('LocalSession: failed to apply the harness session title', {
              sessionId: session.id,
              error: String(error),
            });
          }
        },
        onProviderSessionId: async (providerSessionId) => {
          const result = await setProviderSessionId(session.id, providerSessionId);
          if (!result.success) {
            throw new Error(
              `failed to persist provider session id for ${session.id}: ${result.error.type}`
            );
          }
          session.providerSessionId = providerSessionId;
          if (forkFromProviderSessionId && session.forkedFrom?.sessionId) {
            await recordRuntimeForkOwnership({
              runtimeSessionId: session.id,
              sourceSessionId: session.forkedFrom.sessionId,
              provider: session.providerId,
              providerSessionId,
              workspaceId: this.workspaceId,
              cwd: this.sessionPath,
            });
          }
        },
        onProviderSessionEndpoint: async (endpoint) => {
          await setSessionEndpoint(session.id, endpoint);
          session.providerSessionEndpoint = endpoint;
        },
        baseCommand: agentCommand.command,
        baseArgs: agentCommand.args,
        // argv 里到底有没有续跑 flag —— 宿主要在它上面追加参数时必须知道。
        // ❌ 别让宿主从 resumeProviderSessionId 反推:名单外的家在「要续跑但还没拿到
        //    引擎自己的 session id」时,resumeProviderSessionId 是空的而 argv 已带 `-C`。
        //    存档分叉也是这个形状:生命周期仍是 fork(`forkFromProviderSessionId` 照递),argv 却是续跑子会话。
        isResuming: commandResuming,
        // A diverting host replaces the argv wholesale, so the user's picks have to travel separately —
        // otherwise the composer's model / effort controls silently do nothing on that path.
        model: session.model ?? undefined,
        effort: launchEffort ?? undefined,
        permissionMode,
        // @@@2503 composer 选的模型来源(平台 / harness),按会话记的那条。存量会话没有记录 →
        // undefined,宿主照旧回退 agent 级配置。
        platformModel: platformModelForSpawn,
        // spec agent-provisioning:显式命名过就用那个名字开户,没有才落到「<引擎 label> <序号>」。
        agentDisplayName: session.agentDisplayName,
        // spec `mcp-session-toggle`:原样递,`[]` 也递 —— 归一成 undefined 会让
        // 「决定过、一台没关」与「从没碰过」同形。
        mcpDisabledServers: session.mcpDisabledServers,
      });
      mark('sessionpage-host');
      if (agentCommand.forkHandledByHost && !sessionpageOverride) {
        throw new Error(
          `Fork for ${session.providerId} requires its sessionpage host adapter; no override was provided`,
        );
      }
      sessionpageHostLifecycleStarted = sessionpageHook !== null;
      // @@@2503 宿主 override 的 env **单独持有**,在 spawn env 的最后一层才合并(见下面 spawnLocalPty)。
      // 它从前并进 agentCommand.env,于是排在 customEnv(provider 设置里用户自己存的 env)和任务级
      // sessionEnvVars 前面 —— 一个老 BYOK 用户在 provider 设置里存过 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL,
      // 平台会话就会实跑他自己的 Key,而界面上写着咕咕的模型。这层 env 是宿主的注入(平台中转、能力包、
      // rendezvous 通道),不是用户偏好,必须压过用户偏好。
      const sessionpageEnv = sessionpageOverride?.env ?? {};
      if (sessionpageOverride) {
        agentCommand = {
          ...agentCommand,
          command: sessionpageOverride.command,
          args: sessionpageOverride.args,
        };
      }

      const colorEnv = await getTerminalColorEnv();
      mark('terminal-color');

      const resolved = resolveLocalPtySpawn({
        platform: process.platform,
        env: process.env,
        intent: {
          kind: 'run-command',
          cwd: this.sessionPath,
          command: { kind: 'argv', command: agentCommand.command, args: agentCommand.args },
          shellProfile: this.shellProfile,
          shellSetup: this.shellSetup,
          tmuxEnabled,
          tmuxSessionName,
        },
      });

      logLocalPtySpawnWarnings('LocalSessionProvider', resolved.warnings, {
        sessionId: session.id,
        ptySessionId,
      });

      const ptyId = makePtyId(session.providerId, session.id);
      // Re-attaching to a live tmux session does not start an agent, so it must hand that PTY the
      // credentials the running agent already holds instead of minting ones it will never read.
      // #6264 After a host-process restart the map is empty, but the agent in tmux still holds the credentials
      // the previous process minted: the hook server kept them (hook-sources.json) and hands them back once.
      hookSource = (tmuxEnabled
        ? this.hookSourcesByPtySession.get(ptySessionId) ?? agentHookService.takeRestoredSource(ptySessionId)
        : undefined)
        ?? agentHookService.createSource(ptyId, compatibleRuntime.harnessVersion);
      if (plugin.capabilities.sessionBundle.sessionpage['tui']?.messageTransport === 'local-session') {
        admission = new LocalSessionAdmission(
          session.id,
          hookSource.id,
          // The same fact the resume argv is built from: a fork mints a new child id, so only a
          // plain resume has a native session this spawn is required to come back on — or a storage
          // fork, whose child id was minted before spawn and is exactly what the argv resumes.
          (agentSession.isResuming && !forkFromProviderSessionId) || storageForkedProviderSessionId
            ? session.providerSessionId
            : undefined,
        );
      }
      const port = agentHookService.getPort();
      const token = hookSource.token;
      // The supervisor's replacement reuses this `conversation` object, so it must carry the native
      // id this spawn reported. A fork mints a child id, and a provider that learns its id only after
      // spawn reports it the same way; without it the replacement cannot name the session to resume
      // and degrades to resume-last or whatever the provider does with an id-less resume flag.
      const currentHookSourceId = hookSource.id;
      stopTrackingProviderSession = agentHookService.on('agent:session', (event) => {
        if (event.sessionId === session.id && event.sourceId === currentHookSourceId) {
          session.providerSessionId = event.providerSessionId;
        }
      });
      mark('spawn-prepared');
      log.info('LocalSessionProvider:start stages', {
        sessionId: session.id,
        providerId: session.providerId,
        totalMs: Date.now() - startedAt,
        steps: Object.fromEntries(marks),
      });
      const spawnedAt = Date.now();
      // 叠放顺序全产品**只有一处**(#5702):底座 env(白名单 + 平台补偿 + 用户设置里的 env)
      // → 这一家自己的命令 env → 独立配置根 → 每次调用才有的宿主注入。
      // ❌ 别在这里重排 —— 从前终端腿与聊天腿各排各的,同一个变量两条腿能给出不同的值。
      const spawnEnv = composeAgentSpawnEnv(runContext, {
          providerEnv: agentCommand.env,
          hostInjections: [
            // 钩子端口/令牌按会话各不相同,所以它是注入而不是身份的一部分。
            buildAgentHookEnv(port > 0 ? { port, ptyId, token } : undefined),
            // 工作区信任走 env 的家(`trust.channel = 'runtime-env'`,claude)在这里带上它那几个变量。
            workspaceTrust.env,
            colorEnv,
            this.sessionEnvVars,
            // 最后一层:宿主的注入压过用户自定义 env(见上面 sessionpageEnv 的说明)。没有 override 时是空对象。
            sessionpageEnv,
            // 不经 Windows 壳直接起时,壳原本会设的变量(它的 SET 在一切之后执行)。
            resolved.env,
          ],
        });
      const pty = spawnLocalPty({
        id: ptySessionId,
        command: resolved.command,
        args: resolved.args,
        cwd: resolved.cwd,
        env: spawnEnv,
        cols: spawnSize.cols,
        rows: spawnSize.rows,
      });
      recordSessionProcess(session.id, { home: tmuxEnabled ? 'tmux' : 'host', start });
      // 宿主说「这条会话还没就绪」⇒ 门开之前写进这条 pty 的一切都等着(首句、outbox、用户刚发的)。
      // ⚠️ 只在这一发真的起了引擎时挂:tmux 重连只是接回一个早已就绪的会话,等不到第二次就绪信号;
      //    开了 tmux 的**首次**启动照样新起引擎,照样要等。
      if (sessionpageOverride?.startupGate && start === 'fresh') {
        setPtyStartupGate(pty, sessionpageOverride.startupGate);
      }

      const resumeProviderSessionId = session.providerSessionId;
      pty.onExit((info) => {
        stopPresence?.();
        releaseHookSource();
        admission?.dispose();
        stopTrackingProviderSession?.();
        stopTrackingProviderSession = undefined;
        // The spilled context file is only needed while this process runs.
        void spill?.cleanup();
        const decision = this.supervisor.handleExit(ptySessionId, pty);
        if (decision.kind === 'stale') return;
        const localSessionSessionpage =
          plugin.capabilities.sessionBundle.sessionpage['tui']?.messageTransport === 'local-session';
        if (localSessionSessionpage) {
          // Keep the identity mapped while the supervisor waits to spawn the replacement PTY. The offline
          // target makes bridge delivery durable-pending instead of falling through to gugu-native.
          replaceLiveWithOfflineForSession(session.id);
        } else {
          unregisterLocalSessionDelivery(session.id);
        }
        const replacementSize = ptySessionRegistry.getLastSize(ptySessionId) ?? spawnSize;
        const sessionTmux = (sessionProcess(session.id)?.home ?? (tmuxEnabled ? 'tmux' : 'host')) === 'tmux';

        ptySessionRegistry.unregister(ptySessionId, { pty, exitInfo: info });
        this.ptysBySession.delete(ptySessionId);
        if (decision.kind === 'stopped') return;
        // 不在 tmux 里:pty 没了就是进程没了。
        if (!sessionTmux) forgetSessionProcess(session.id);

        if (forkFromProviderSessionId && !sessionTmux) {
          try {
            resolveForkResumeCommandArgs(session, forkFromProviderSessionId);
          } catch (error) {
            this.supervisor.stop(ptySessionId);
            notifySessionpageEndedFromExit(session.id);
            emitSessionSpawnFailure(session, error);
            return;
          }
        }

        // 引擎真的没了:落 idle、要么起替身、要么 teardown —— 不在 tmux 里时 pty 退出就是这一刻。
        const settleEngineGone = (): void => {
          if (decision.kind === 'failed' && isUnexpectedPtyExit(info)) {
            // A PTY can spawn successfully while its helper fails to exec the requested command.
            // Once recovery is exhausted, end the parallel app-server lifecycle before publishing
            // the durable error so a later turn/completed event cannot overwrite it.
            notifySessionpageEndedFromExit(session.id);
            const failure = describeStartupExit(info, resumeProviderSessionId);
            emitSessionSpawnFailure(session, failure);
            events.emit(sessionDeliveryFailedChannel, {
              sessionId: session.id,
              projectId: session.projectId,
              message: failure.message,
            });
            return;
          }

          // @@@exit-settles-in-process (#6380) —— 进程真的没了,harness 不会再打回任何一条 hook 边沿 ⇒ 这一轮在不在跑
          // 交给唯一的写入者落 idle,与 stopSession 同一条进程内调用;会话页渲染层随写入者的输出更新,❌ 自己改状态。
          void agentStatusWriter
            .settleSessionExited({ sessionId: session.id })
            .catch((error: unknown) => {
              log.error('LocalSessionProvider: agent exited but its status could not be settled', {
                sessionId: session.id,
                error: String(error),
              });
            });

          if (this.supervisor.isDesired(ptySessionId)) {
            this.scheduleReplacement({
              session,
              initialSize: replacementSize,
            });
            return;
          }

          // @@@2503 正常退出(用户 /exit、agent 跑完自退)也要 teardown。此前只有「失败且非预期退出」
          // (上面那条)和 destroySession 会通知宿主,于是最常见的那条退出路径根本不通知 —— 宿主那边
          // 这条会话的平台凭据就一直挂着:续期循环每半个 TTL 续一次,会话永远 expires_at > now() 且
          // revoked_at 为空,永远进不了结算巡检队列,真实用量永远结不上账。
          // 只在**不再重启**时通知:上面 isDesired 的分支是要接着起替身进程,那条会话并没有结束。
          notifySessionpageEndedFromExit(session.id);
        };
        if (sessionTmux) {
          // 退出的只是 attach 到 tmux 的那个 client;引擎在不在问 tmux(与接回同一个判据)。还在 = 只是断开,
          // 不 teardown;不在了 = 引擎死了(被杀、崩了、自己退了),与不在 tmux 里的退出走同一段。
          // 判定期间这条会话换了一代(重开、被停)就不再替旧的一代做决定。
          const exited = sessionProcess(session.id);
          void listTmuxSessionNames(this.ctx).then(
            (names) => {
              if (sessionProcess(session.id) !== exited || sessionsAliveInTmux(names).has(session.id)) return;
              forgetSessionProcess(session.id);
              // 它的 hook 凭据随它一起失效(在 tmux 里时 releaseHookSource 为它留着)。
              if (hookSource && this.hookSourcesByPtySession.get(ptySessionId) === hookSource) {
                this.hookSourcesByPtySession.delete(ptySessionId);
                hookSource.dispose();
              }
              settleEngineGone();
            },
            (error: unknown) => {
              log.error('LocalSessionProvider: tmux attach exited and tmux cannot be read; engine state unknown', {
                sessionId: session.id,
                error: String(error),
              });
            },
          );
          return;
        }
        settleEngineGone();
      });

      if (!this.supervisor.acceptSpawn(ptySessionId, spawnToken, pty)) {
        releaseHookSource();
        admission?.dispose();
        if (plugin.capabilities.sessionBundle.sessionpage['tui']?.messageTransport !== 'local-session') {
          unregisterLocalSessionDelivery(session.id);
        }
        // A rejected token never owned a delivery binding. In particular, an old spawn can return here
        // after stop()+start() has installed a replacement generation for the same conversation. Do not
        // demote that replacement's live owner to offline; the generation that owns the binding performs
        // its own exit/startup transition.
        stopTrackingProviderSession?.();
        stopTrackingProviderSession = undefined;
        try {
          pty.kill();
        } catch {}
        if (ptySessionRegistry.get(ptySessionId) === pty) {
          ptySessionRegistry.unregister(ptySessionId);
        }
        if (sessionpageHostLifecycleStarted) {
          sessionpageHostLifecycleStarted = false;
          await notifyGuguPtySessionpageEnded(session.id);
        }
        return;
      }
      spawnAccepted = true;

      ptySessionRegistry.register(ptySessionId, pty, {
        size: spawnSize,
        onProviderReviewGate: (gate) => {
          agentStatusWriter.reportProviderReviewGate({
            sessionId: session.id,
            projectId: session.projectId,
            gate,
          });
        },
        onProviderBlocker: (blocker) => {
          agentStatusWriter.reportProviderBlocker({
            sessionId: session.id,
            projectId: session.projectId,
            blocker,
          });
        },
        metadata: {
          providerId: session.providerId,
          title: session.title,
          ...(start === 'reattach' ? {} : { agentStartedAt: spawnedAt }),
        },
      });
      stopPresence = startPresenceInterrupt({
        plugin,
        harnessVersion: compatibleRuntime.harnessVersion,
        spawnEnv,
        // tmux 里 pty 的子进程是 tmux 的客户端,不是 harness:按它的会话 id 找一次。
        location: tmuxEnabled
          ? { kind: 'session', sessionId: agentSession.cliSessionId }
          : { kind: 'pid', pid: pty.getPid?.() ?? NaN },
        sessionId: session.id,
        projectId: session.projectId,
        providerId: session.providerId,
      });
      // Registered only now: a rejected spawn must not displace the live generation's entry, which
      // is the only handle stopSession has for revoking its credentials.
      this.hookSourcesByPtySession.set(ptySessionId, hookSource);
      // Under tmux the agent outlives this host process too (upgrade, crash): keep its credentials on disk (#6264).
      if (tmuxEnabled) hookSource.keepAcrossRestart(ptySessionId);
      this.ptysBySession.set(ptySessionId, pty);
      if (admission) {
        // A session-page local-session provider is not contactable until its roster identity is bound.
        // Make that binding part of spawn readiness so a missing/failed provision cannot look ready.
        try {
          await this.registerSessionpageLocalSessionDelivery(session, ptySessionId, pty, admission);
        } catch (error) {
          if (this.ptysBySession.get(ptySessionId) === pty) {
            this.supervisor.stop(ptySessionId);
            this.ptysBySession.delete(ptySessionId);
            ptySessionRegistry.unregister(ptySessionId, { pty });
            replaceLiveWithOfflineForSession(session.id);
            try {
              pty.kill();
            } catch (killError) {
              log.warn('LocalSessionProvider: failed to stop unbound local-session PTY', {
                sessionId: session.id,
                error: String(killError),
              });
            }
          }
          throw error;
        }
      }
      if (startupTurnText) {
        // 与这条会话之后的每一条消息同一条路(local-session 注入),过同一道启动门。
        const startupMessageId = session.initialMessageId ?? randomUUID();
        void injectSessionMessageWhenReady({
          pty,
          session,
          message: { id: startupMessageId, text: startupTurnText },
        }).then(
          (result) => {
            if (result.status !== 'accepted') {
              log.warn('LocalSessionProvider: startup turn not delivered before the PTY exited', {
                sessionId: session.id,
                providerId: session.providerId,
              });
            }
          },
          (error) => {
            log.error('LocalSessionProvider: startup turn delivery failed', {
              sessionId: session.id,
              providerId: session.providerId,
              error: String(error),
            });
          },
        );
      }
      if (bootstrap.readyText) {
        void injectSystemBootstrapWhenReady({
          pty,
          session,
          text: bootstrap.readyText,
          projectPath: this.sessionPath,
        });
      }
      void drainSessionMessageOutbox({
        projectId: session.projectId,
        sessionId: session.id,
      });
    } catch (error) {
      releaseHookSource();
      admission?.dispose(error instanceof Error ? error : new Error(String(error)));
      stopTrackingProviderSession?.();
      // No PTY was created (or its onExit never fired), so clean up the temp file here.
      void spill?.cleanup();
      const failedCurrentSpawn = this.supervisor.failSpawn(ptySessionId, spawnToken);
      if (!this.ptysBySession.has(ptySessionId)) {
        if (plugin.capabilities.sessionBundle.sessionpage['tui']?.messageTransport === 'local-session') {
          replaceLiveWithOfflineForSession(session.id);
        } else {
          unregisterLocalSessionDelivery(session.id);
        }
      }
      let startupError = error;
      if (sessionpageHostLifecycleStarted) {
        sessionpageHostLifecycleStarted = false;
        try {
          await notifyGuguPtySessionpageEnded(session.id);
        } catch (teardownError) {
          startupError = new AggregateError(
            [error, teardownError],
            `Session-page session startup and teardown both failed for ${session.id}`
          );
        }
      }
      // stop() or a newer start generation can invalidate this token while the sessionpage hook is still
      // awaiting provider readiness. That rejection is the old generation finishing its requested stop,
      // not a conversation startup failure for the renderer to surface.
      // ⚠️ 例外只有一种,而且判据是这次启动**自己的**事实(#6183):stop() abort 了它的信号 = 用户
      // 取消了一次还没起来的启动。原因(卡在哪一步、等了多久)要交还给等这次启动的人,
      // ❌ 静默 return —— 真机实测那样界面会停在「正在启动会话…」永远转下去。状态由 stop 自己收口。
      if (!failedCurrentSpawn && !spawnAccepted) {
        if (spawnToken.signal.aborted) throw describeCancelledStart(startupError, startedAt, marks);
        return;
      }
      const staleReplacement =
        startupError instanceof LocalSessionGenerationStaleError
        && this.supervisor.isDesired(ptySessionId);
      if (!staleReplacement) emitSessionSpawnFailure(session, startupError);
      throw startupError;
    }
  }

  private async registerSessionpageLocalSessionDelivery(
    session: Session,
    ptySessionId: string,
    pty: Pty,
    admission: LocalSessionAdmission,
  ): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.ptysBySession.get(ptySessionId) !== pty) {
        throw new LocalSessionGenerationStaleError(
          `session-page local-session PTY became stale before identity binding for ${session.id}`,
        );
      }
      const agent = await localAgentForSession(session.id, process.env);
      if (agent?.gugu_user_id) {
        if (this.ptysBySession.get(ptySessionId) !== pty) {
          throw new LocalSessionGenerationStaleError(
            `session-page local-session PTY became stale before identity binding for ${session.id}`,
          );
        }
        registerLocalSessionDelivery(agent.gugu_user_id, {
          sessionId: session.id,
          providerId: session.providerId,
          waitUntilReady: () => admission.waitUntilReady(),
          isTurnInFlight: () => admission.isTurnInFlight(),
          sendMessage: (message) => this.sendMessage(session, {
            id: message.id,
            text: message.text,
            kind: message.kind,
          }),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`session-page agent roster binding not found for ${session.id} after 2 seconds`);
  }

  private detachPty(ptySessionId: string): void {
    this.detachedPtySessionIds.add(ptySessionId);
    const pty = this.supervisor.stop(ptySessionId) ?? this.ptysBySession.get(ptySessionId);
    if (pty && this.ptysBySession.get(ptySessionId) === pty) {
      // Detach/dehydrate keeps the task identity and roster resumable. Keep a synchronous offline
      // blocker while the PTY is detached so ordinary Contacts delivery cannot fall through to native.
      preserveLocalSessionDeliveryForSession(ptySessionId);
    } else if (!pty) {
      // A prior generation may already have installed the blocker before this detach completes.
      // Do not clear it here: detach is recoverable and the identity remains addressable.
      preserveLocalSessionDeliveryForSession(ptySessionId);
    }
    this.ptysBySession.delete(ptySessionId);
    ptySessionRegistry.unregister(ptySessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('LocalAgentProvider: error killing PTY', {
          ptySessionId,
          error: String(e),
        });
      }
    }
  }

  async detachSession(sessionId: string): Promise<void> {
    const ptySessionId = makePtySessionId(this.projectId, sessionId, sessionId);
    this.detachPty(ptySessionId);
    const sessionTmux = sessionProcess(sessionId)?.home === 'tmux';
    if (!sessionTmux) {
      forgetSessionProcess(sessionId);
      this.knownPtySessionIds.delete(ptySessionId);
      this.supervisor.forget(ptySessionId);
    }
  }

  ownsSession(sessionId: string): boolean {
    return this.knownPtySessionIds.has(makePtySessionId(this.projectId, sessionId, sessionId));
  }

  async stopSession(sessionId: string): Promise<void> {
    const ptySessionId = makePtySessionId(this.projectId, sessionId, sessionId);
    const sessionTmux = sessionProcess(sessionId)?.home === 'tmux';
    this.detachedPtySessionIds.delete(ptySessionId);
    this.knownPtySessionIds.delete(ptySessionId);
    const cancelledStartInFlight = this.supervisor.cancelStart(ptySessionId);
    log.info('LocalAgentProvider: stopSession', { ptySessionId, cancelledStartInFlight });
    const pty = this.supervisor.stop(ptySessionId) ?? this.ptysBySession.get(ptySessionId);
    // stopSession tears down transport only. The persisted session-page identity remains addressable until the
    // reaper has deleted it, so keep an offline blocker across both the PTY-present and no-PTY races.
    preserveLocalSessionDeliveryForSession(ptySessionId);
    this.ptysBySession.delete(ptySessionId);
    ptySessionRegistry.unregister(ptySessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('LocalAgentProvider: error killing PTY', {
          ptySessionId,
          error: String(e),
        });
      }
    }
    if (sessionTmux) {
      await killTmuxSession(this.ctx, makeTmuxSessionName(ptySessionId));
    }
    // The agent process is gone either way now, so its hook credentials stop being valid here.
    this.hookSourcesByPtySession.get(ptySessionId)?.dispose();
    this.hookSourcesByPtySession.delete(ptySessionId);
    forgetSessionProcess(sessionId);
    this.supervisor.forget(ptySessionId);
    // @@@sessionpage TASKPAGE-FUSION — conversation truly ended → let the gugu host dispose the codex
    // app-server it started for this conversation (kill the process, drop the delivery registration). No-op
    // if this wasn't a diverted session-page codex conversation. detachSession does NOT call this (a detached
    // tab may reopen and reuse the same app-server/thread to preserve history).
    await notifyGuguPtySessionpageEnded(sessionId);
    await closeRuntimeForkOwnershipForRuntimeSession(sessionId);
    // #6095 —— 进程是我们杀的,harness 因此打不回任何一条 stop 边沿。「这一轮在不在跑」交给它唯一的
    // 写入者(spec agent-status),**放在最后**:记下来的事实不能跑在现实前面。
    // 「还有没有运行时」❌ 不落成事实(#6546):进程在不在不是 agent 的事实,下一条消息会按原会话唤醒它。
    // detachSession / destroyAll ❌ 不走这里:前者只是把 tab 收起来(tmux 会话还活着),
    // 后者是整个 app 在退,由启动时写入者的 settleAfterRestart 负责。
    await agentStatusWriter.settleSessionExited({
      sessionId,
      projectId: this.projectId,
    });
  }

  async destroyAll(): Promise<void> {
    const ptySessionIds = Array.from(this.knownPtySessionIds);
    // 销毁 = 这些会话的属主放弃了它们:在飞的启动一并取消,否则独立进程组里的版本探针会活过应用退出(#6183)。
    for (const ptySessionId of ptySessionIds) this.supervisor.cancelStart(ptySessionId);
    const sessionIds = ptySessionIds.flatMap((ptySessionId) => {
      const parsed = parsePtySessionId(ptySessionId);
      return parsed ? [parsed.leafId] : [];
    });
    await this.detachAll();
    for (const ptySessionId of ptySessionIds) this.detachedPtySessionIds.delete(ptySessionId);
    await Promise.all(
      ptySessionIds
        .filter((id) => {
          const parsed = parsePtySessionId(id);
          return parsed !== null && sessionProcess(parsed.leafId)?.home === 'tmux';
        })
        .map((id) => killTmuxSession(this.ctx, makeTmuxSessionName(id)))
    );
    for (const ptySessionId of ptySessionIds) {
      this.supervisor.forget(ptySessionId);
    }
    // destroyAll tears down transport but does not delete the persisted session-page identities. Keep every
    // local-session blocker until sessionpage-agent-reaper removes the corresponding identity and roster row.
    await Promise.all(sessionIds.map(async (id) => {
      await notifyGuguPtySessionpageEnded(id);
      await closeRuntimeForkOwnershipForRuntimeSession(id);
    }));
    this.knownPtySessionIds.clear();
    for (const source of this.hookSourcesByPtySession.values()) source.dispose();
    this.hookSourcesByPtySession.clear();
    for (const id of sessionIds) forgetSessionProcess(id);
  }

  async detachAll(): Promise<void> {
    for (const [ptySessionId, pty] of this.ptysBySession) {
      this.detachedPtySessionIds.add(ptySessionId);
      // Keep every recognized local-session identity mapped offline across task/session unload.
      preserveLocalSessionDeliveryForSession(ptySessionId);
      this.supervisor.stop(ptySessionId);
      try {
        pty.kill();
      } catch {}
      ptySessionRegistry.unregister(ptySessionId);
    }
    this.ptysBySession.clear();
  }

  private scheduleReplacement({
    session,
    initialSize,
  }: {
    session: Session;
    initialSize: { cols: number; rows: number };
  }): void {
    setTimeout(() => {
      this.startSessionInternal(session, initialSize, true, undefined, true).catch(
        (e) => {
          log.error('LocalSessionProvider: replacement failed', {
            sessionId: session.id,
            error: String(e),
          });
        }
      );
    }, RESPAWN_DELAY_MS);
  }
}
