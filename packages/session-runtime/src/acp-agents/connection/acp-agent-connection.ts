import type { Client, InitializeResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import type {
  AdapterExit,
  InitializeFailedError,
  NormalizedEvent,
  SpawnFailedError,
} from '@gugu/session-core/acp';
import { acpErr, decodeSessionUpdate } from '@gugu/session-core/acp';
import type { AcpProcessHandle, AcpProcessHost } from '@gugu/session-core/acp/node';
import type { AcpAgentApi, AgentHostAcpSpawn, IAcpBehavior } from '@gugu/session-core/agents/plugins';
import type { Result } from '@gugu/session-shared';
import { ok, toSerializedError, type Serializable, type SerializedError } from '@gugu/session-shared';
import { noopLogger, type Logger } from '@gugu/session-shared/logger';
import type { Scope } from '@gugu/session-wire/util';

type AcpAgentProcessHost = Pick<AcpProcessHost, 'spawn' | 'spawnTerminal'>;

type ProcessClosed =
  | {
      kind: 'exit';
      exitCode: number | null;
      signal: string | null;
    }
  | {
      kind: 'error';
      error: Error;
      exitCode: number | null;
      signal: string | null;
    };

export type AcpConnectionError = SpawnFailedError | InitializeFailedError;
export type AcpSessionUpdateNormalizer = (raw: SessionUpdate) => NormalizedEvent;

/** Live connection to one spawned agent process. */
export interface AcpAgentConnection {
  agent: AcpAgentApi;
  normalize: AcpSessionUpdateNormalizer;
  supportsLoadSession: boolean;
  supportsForkSession: boolean;
  /** agent 在 initialize 里声明它收 image 块;没声明按协议默认 false。 */
  supportsImagePrompt: boolean;
  /** agent 在 initialize._meta 里声明 ACP steering 扩展。 */
  supportsSteering: boolean;
  /**
   * agent 自己报状态(ACP v2 的 `state_update`):在不在跑只听它的,谁开的工都一样。
   * v1 的家只有「prompt 请求还没答」这一个事实可用。
   */
  reportsState: boolean;
  /**
   * 这条连接**实际**在跟哪个进程说话 —— spawn 当场绑定的 pid,拿不到时为 null。
   *
   * 它此前只进了日志(下面那行 `delivery process bound`)。会话**重载**要用它当判据:
   * 适配器连接按 conversation key 归属；重载时进程身份是判断新 spawn 是否真的发生的证据，
   * 而不是「我们调过 stop 了」。
   */
  pid: number | null;
  /** Signal the bound process and wait for its actual exit, without force escalation. */
  stopProcess(): Promise<void>;
}

/**
 * Spin up an agent process, initialize it, and return a ready connection.
 * Setup failures are reported as Result errors; `onClosed` is reserved for
 * unexpected exits after the connection is ready.
 */
export async function createAcpAgentConnection(
  deps: {
    host: AcpAgentProcessHost;
    behavior: IAcpBehavior;
    logger?: Logger;
  },
  args: {
    providerId: string;
    spawn: AgentHostAcpSpawn;
    scope: Scope;
    /** Factory called once; the runtime passes its buildAgentClient result here. */
    buildClient: (agent: AcpAgentApi, normalize: AcpSessionUpdateNormalizer) => Client;
    /** Pool key this connection was provisioned under; carries the conversation id when the
     *  session is platform-isolated, so the logged binding is addressable. */
    connectionKey: string;
    /**
     * Called when a ready process exits unexpectedly.
     *
     * ⚠️ 它此前只带 `exitCode`。signal 与适配器 stderr 的尾巴在**这个签名上**就被截断了 ——
     * 而它们在下面那条 `task/acp-exit` 日志里是齐全的。于是产品面只能说「这条指令没能送达」,
     * 说不出「引擎退了,退出码 1,它最后说的是这两行」(#5858 / #4875 ②)。
     * ⇒ 边界上有多少就交出去多少;❌ 不让下游回头去捞日志拼。
     */
    onClosed: (exit: AdapterExit) => void;
    /** 进程 stderr 的每一整行(见 `IAcpBehavior.turnFailure`)。 */
    onStderrLine?: (line: string) => void;
  }
): Promise<Result<AcpAgentConnection, AcpConnectionError>> {
  const {
    providerId,
    connectionKey,
    spawn,
    scope,
    buildClient,
    onClosed,
    onStderrLine,
  } = args;
  const { host, behavior, logger = noopLogger } = deps;
  const connectionScope = scope.child(`acp-connection:${providerId}`);

  let handle: AcpProcessHandle;
  try {
    handle = await host.spawn({
      command: spawn.command,
      args: spawn.args,
      env: spawn.env,
      cwd: spawn.cwd,
    });
  } catch (e) {
    await connectionScope.dispose();
    return acpErr.spawnFailed(toSerializedError(e));
  }

  // 投递进程绑定 —— 宿主**实际从这个 handle 的 stdout 读回复**,所以它就是这条连接的投递进程。
  // 绑定在 spawn 当场构造,❌ 不是事后按存活/时序反推(那只会把"读数时刻挑存活 pid"的偏差换个名字)。
  // ⚠️ 只记 connectionKey / pid / 时刻:❌ 不记 env、❌ 不记 argv —— 那会把凭据带进日志(探针红线)。
  logger.info('session/acp-start: delivery process bound', {
    connectionKey,
    providerId,
    pid: handle.pid,
    spawnedAt: new Date().toISOString(),
  });

  const stderrTail = createStderrTail();
  let stderrPartial = '';
  if (handle.stderr) {
    const onStderr = (data: Buffer): void => {
      const text = data.toString();
      stderrTail.push(text);
      if (onStderrLine) {
        const lines = (stderrPartial + text).split('\n');
        stderrPartial = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) onStderrLine(line);
      }
      logger.debug('createAcpAgentConnection: agent stderr', { text: text.trim() });
    };
    handle.stderr.on('data', onStderr);
    connectionScope.add(() => {
      handle.stderr?.off?.('data', onStderr);
      handle.stderr?.removeListener?.('data', onStderr);
    });
  }

  let actualExitObserved = false;
  connectionScope.add(() => {
    // 已退出由进程宿主识别；其它失败交给 scope 的 cleanup-error 出口。
    if (!actualExitObserved) handle.kill('SIGTERM');
  });

  const processClosed = onceProcessClosed(handle, logger);
  let processExited = false;
  void processClosed.then(() => { processExited = true; });
  // #6360 `processClosed` 在「退出」与「进程 error」谁先到就落定;而适配器秒退时先到的常是
  // stdin 的 `write EPIPE`(进程 error),真正的退出码还在路上。
  // ⇒ 启动失败要报「它自己怎么说」时,落定的时刻是**这个进程自己的退出事件**,stderr 取那一刻已读到的。
  // ❌ 不等 stderr 读到 EOF:harness 拉起的孙进程继承了 stderr 还活着时(Bun / node 包装脚本常见),
  // 管道在父进程退出后也不会关,那就是永远等下去。卡住的孙进程归收树(#6353),不归失败原因。
  const processExit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    handle.onExit(exit => { actualExitObserved = true; resolve(exit); });
  });

  const normalize = (raw: SessionUpdate): NormalizedEvent => {
    const base = decodeSessionUpdate(raw);
    return behavior.enrich ? behavior.enrich(base, raw) : base;
  };

  let connection: AcpAgentApi;
  try {
    connection = behavior.connect({ stdin: handle.stdin, stdout: handle.stdout }, (agent) =>
      buildClient(agent, normalize)
    );
  } catch (e) {
    await connectionScope.dispose();
    return acpErr.initializeFailed(toSerializedError(e));
  }

  try {
    // @@@6183 initialize 等的是**两个事实之一**:适配器回了 `initialize`,或者它退出了。
    // ❌ 没有第三条「时钟到了」。这里曾经有一个 10s 的预算,它量的不是适配器,是机器:
    // mac1 load 23–34 时 mimocode 冷启动就是会超过 10s,而那个进程**活着、正在起来** ——
    // 定时器把一次慢启动判成「起不来」,杀掉它,然后宿主每 5 分钟再杀一次。
    // 适配器真的卡死(活着、永不回话)时,收口的是**这次启动的属主**:会话被停止 / 删除 /
    // 应用退出都会销毁 `scope` ⇒ 上面那条 cleanup 发 SIGTERM ⇒ `processClosed` 落定 ⇒
    // 这里以「退出」这个事实结束。见 spec harness-capability-adapters「启动只等事实」。
    const initialized = await Promise.race([
      initializeAgent(connection, host, behavior),
      processClosed.then(failClosedBeforeReady),
    ]);
    const supportsLoadSession = initialized.agentCapabilities?.loadSession === true;
    const supportsForkSession = initialized.agentCapabilities?.sessionCapabilities?.fork != null;
    const supportsImagePrompt = initialized.agentCapabilities?.promptCapabilities?.image === true;
    const initializeMeta = (initialized as InitializeResponse & { _meta?: unknown })._meta;
    const supportsSteering = isSteeringCapability(initializeMeta);
    const reportsState = initialized.protocolVersion >= 2;
    logger.debug('createAcpAgentConnection: initialized', {
      supportsLoadSession,
      supportsForkSession,
      supportsImagePrompt,
      supportsSteering,
      reportsState,
    });
    const ended = processExit.then(async (exit) => {
      const closed = { kind: 'exit' as const, exitCode: exit.code, signal: exit.signal };
      // @@@5405 先把这棵树收干净,再把「进程没了」报出去 —— 顺序本身就是合同的一部分。
      // 报出去的下一步是宿主结算这一代平台额度(撤令牌 + 删那份 0600 settings 文档)。
      // 适配器被 SIGKILL 时它没机会收自己拉起的引擎,引擎 reparent 到 PID1 继续跑完手上的工具
      // 调用,然后拿一份刚被撤销的凭据打网关 —— 实测 401,而用户只看见一次没人解释得了的失败。
      // ⇒ 收树在前、通知在后;❌ 不在网关那侧吞掉那个 401,那是把症状盖住而不是修顺序。
      // 收树本身失败不能吞掉这条通知:会话永远停在 ready 比一个孤儿更糟 ⇒ 如实记 reapError。
      let reaped: number | null = null;
      let reapedPids: number[] = [];
      let reapError: string | undefined;
      try {
        const result = await handle.reap();
        reaped = result.reaped;
        reapedPids = result.pids;
      } catch (e) {
        reapError = e instanceof Error ? e.message : String(e);
      }
      if (connectionScope.disposed) return;
      // 适配器**意外**退出 —— 这条独占该进程的会话此刻失去运行时。
      // 从前这里一行不记:退出码、信号、适配器最后说的话全部丢掉,于是「适配器为什么退」
      // 在真机上无从回答(#5388:owner 那台 00:31:27 猝死,三个仪器都只能看见后果)。
      // 哪条会话被带走由 SessionManager 那边报 —— 它才知道记录与 processKey 的绑定。
      logger.error('session/acp-exit: adapter process exited unexpectedly', {
        connectionKey,
        providerId,
        pid: typeof handle.pid === 'number' ? handle.pid : null,
        exitCode: exitCodeFromClosed(closed),
        signal: signalFromClosed(closed),
        stderrTailLines: stderrTail.lineCount(),
        stderrTail: stderrTail.text(),
        // 收掉了几个:0 与「没收」不是同一件事,所以这一格必须出现在每条退出记录上。
        reapedChildren: reaped,
        reapedPids,
        reapError,
      });
      onClosed({
        exitCode: exitCodeFromClosed(closed),
        signal: signalFromClosed(closed),
        stderrTail: stderrTail.text(),
      });
    });
    return ok({
      agent: connection,
      normalize,
      supportsLoadSession,
      supportsForkSession,
      supportsImagePrompt,
      supportsSteering,
      reportsState,
      pid: typeof handle.pid === 'number' ? handle.pid : null,
      stopProcess: async () => {
        if (!actualExitObserved) handle.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ended,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error('stop_pending: executor is still stopping; check its state before reporting success'), { code: 'stop_pending' })), 10_000);
            }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      },
    });
  } catch (e) {
    // #6360 initialize 没等到回话 —— 最常见的是适配器自己先退了(配置坏、依赖缺、env 错),
    // 而传输层只会说 `ACP connection closed` / `write EPIPE`。真因在**进程自己**那里:它的退出码/信号
    // 与它最后打到 stderr 的那几行。先把这份自述拿到手,再报失败 —— ❌ 不替它编原因。
    //
    // 等不等它的「退出」由失败本身说了算,❌ 不靠时钟:
    // · **传输没了**(进程已退 / `ACP connection closed` / EPIPE / ECONNRESET)⇒ 它已经说不了话,
    //   下一个事实就是它自己的退出(SDK 先报「连接关闭」/ stdin 先报 EPIPE、毫秒后才到退出事件,见 reducer 那段)
    //   ⇒ 等到它的退出事件,报它的码与那一刻已读到的 stderr。
    //   万一它关了 stdout 却永远不退,收口的仍是这次启动的属主(停止/删除会话 ⇒ scope 被销毁 ⇒ SIGTERM),
    //   与上面「initialize 只等事实」同一个收口。
    // · 其余(它回了 JSON-RPC 错误、本地校验抛错……)⇒ 它可能还活着、不会自己退 ⇒ 当场停掉它,
    //   只报它此刻的 stderr 尾巴,并如实标 `stoppedByGugu`(别让 SIGTERM 冒充「它自己崩了」)。
    const cause = toSerializedError(e);
    const transportLost = processExited
      || cause.code === 'EPIPE'
      || cause.code === 'ECONNRESET'
      || /ACP connection closed/.test(cause.message);
    let exit: AdapterExit;
    let stoppedByGugu = false;
    if (!transportLost) {
      handle.kill('SIGTERM');
      stoppedByGugu = true;
      exit = { exitCode: null, signal: null, stderrTail: stderrTail.text() };
    } else {
      const exited = await processExit;
      exit = { exitCode: exited.code, signal: exited.signal, stderrTail: stderrTail.text() };
    }
    logger.error('createAcpAgentConnection: initialize failed', {
      error: e instanceof Error ? e.message : String(e),
      exitCode: exit.exitCode,
      signal: exit.signal,
      stoppedByGugu,
      stderrTailLines: stderrTail.lineCount(),
      stderrTail: exit.stderrTail,
    });
    await connectionScope.dispose();
    return acpErr.initializeFailed(withAdapterExit(cause, exit, stoppedByGugu));
  }
}

/**
 * 把进程自己的退出事实挂到失败原因的结构化负载上(`SerializedError.data`,一层原始值 ——
 * `errorDetail` 会逐项列出,于是条件行的原因面上直接有 `exitCode=3` 与 stderr 尾巴)。
 * 缺的格不写:没有退出码就不写 `exitCode`,❌ 不补一个 null/0 冒充读数。
 */
function withAdapterExit(
  cause: SerializedError,
  exit: AdapterExit,
  stoppedByGugu: boolean,
): SerializedError {
  const base: Record<string, Serializable> =
    typeof cause.data === 'string'
      ? { details: cause.data }
      : cause.data && typeof cause.data === 'object' && !Array.isArray(cause.data)
        ? { ...(cause.data as Record<string, Serializable>) }
        : {};
  if (exit.exitCode !== null) base.exitCode = exit.exitCode;
  if (exit.signal) base.signal = exit.signal;
  if (stoppedByGugu) base.stoppedByGugu = true;
  const tail = exit.stderrTail.trim();
  if (tail) base.stderrTail = tail;
  return Object.keys(base).length > 0 ? { ...cause, data: base } : cause;
}

function isSteeringCapability(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
  const steering = (meta as { steering?: unknown }).steering;
  if (typeof steering !== 'object' || steering === null || Array.isArray(steering)) return false;
  return (steering as { supported?: unknown }).supported === true;
}

function onceProcessClosed(handle: AcpProcessHandle, logger: Logger): Promise<ProcessClosed> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (closed: ProcessClosed): void => {
      if (settled) return;
      settled = true;
      resolve(closed);
    };

    handle.onExit((exit) => {
      settle({ kind: 'exit', exitCode: exit.code, signal: exit.signal });
    });
    handle.onError((error) => {
      logger.error('createAcpAgentConnection: agent process error', { error: error.message });
      settle({ kind: 'error', error, exitCode: handle.exitCode, signal: null });
    });
  });
}

/**
 * `clientCapabilities.subagents` 是 ACP 草案字段(agent-client-protocol#1992),已发布的
 * `@agentclientprotocol/sdk` 里还没有它 ⇒ 直接写会被当成多余属性顶掉。上游适配器自己也是
 * 本地加宽同一个字段(`acp-subagents.d.ts` 的 `SubagentAwareSessionCapabilities`),这里照做。
 *
 * ⚠️ 这是一条**有到期日**的加宽:SDK 一旦发布 #1992,删掉这个类型、直接用 SDK 的即可 ——
 * 判据是 `InitializeRequest['clientCapabilities']` 上出现 `subagents`,那时这里会变成
 * 一个多余的交叉类型而不是编译错误,所以❌ 别指望编译器提醒你,升级 SDK 时手动核一次。
 */
type SubagentAwareInitializeRequest = Omit<
  Parameters<AcpAgentApi['initialize']>[0],
  'clientCapabilities'
> & {
  clientCapabilities: Parameters<AcpAgentApi['initialize']>[0]['clientCapabilities'] & {
    subagents?: Record<string, never>;
    /** `session-compaction` RFD 的客户端能力位;与 `subagents` 同一种加宽、同一个到期条件。 */
    session?: { compaction?: Record<string, never>; notices?: Record<string, never> };
  };
};

function initializeAgent(agent: AcpAgentApi, host: AcpAgentProcessHost, behavior: IAcpBehavior) {
  const sessionFailure = behavior.turnFailure?.fromPromptResponse ? ['sessionFailure'] : [];
  const request: SubagentAwareInitializeRequest = {
    protocolVersion: 1,
    clientInfo: { name: 'gugu', version: '1' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: typeof host.spawnTerminal === 'function',
      /**
       * ⚠️ 与上面那个 `terminal` **不是**一回事,别合并:上面那个是「agent 能不能让我替它跑
       * 工具用的终端」(带内反向请求,所以按 host 有没有 spawnTerminal 如实报);
       * 这个是「客户端能不能替用户跑一个**登录**终端」——咕咕能(`AgentSignInModal`),恒 true。
       *
       * 规范原文:「An Agent may advertise a `terminal` method only when this capability is
       * present」。不声明,agent 就**不会**把带 `args`/`env` 的登录方式交出来 —— 会话这条腿
       * 撞上 auth_required 时,界面拿到的仍然只是一个名字。
       */
      auth: { terminal: true },
      /**
       * 子智能体与后台任务的**双边握手**(#5117)。不声明,协议就按老形态走:
       * Agent/Task 退化成一个普通 tool call,子智能体的一切(它的 tool call、它起的
       * 后台命令)**留在根会话上**且不带任何血缘标记 —— 客户端想过滤都没有依据。
       * 出处是钉住的 0.75.1 自带 README「Subagent sessions」一节,逐字:
       * “Without either client signal, Agent/Task lifecycle keeps its legacy ordinary
       *  ACP tool-call representation and child interactions stay on the root session.”
       *
       * ⚠️ `_meta['subagent-transcript']` / `forwardSubagentText` 是**另一档**,同一段
       * README 说它们 “retain the flattened child transcript behavior” —— 那条是陷阱,
       * 声明了照样拍平,❌ 别拿它当这件事的开关。
       */
      subagents: {},
      /**
       * 上下文压缩的边界要能画出来(spec `session-history-replay`)。不声明这一位,agent
       * 就不会发 `compaction_update` —— 压缩在界面上与「什么都没发生」长得一模一样,而
       * 压缩之后 agent 记得的是摘要不是原文,用户没有依据判断该不该把上面的话再说一遍。
       * 出处:ACP `docs/rfds/session-compaction.mdx`,逐字
       * `{"clientCapabilities":{"session":{"compaction":{}}}}`。
       *
       * ⚠️ 声明了不等于今天就看得见:2026-09-10 实查 `@agentclientprotocol/claude-agent-acp`
       * 0.38.0,它把压缩报成一句字面文本 `"Compacting..."` 的 `agent_message_chunk`
       * (dist/acp-agent.js 的 `system/status` 分支),一条 `compaction_update` 都不发。
       * 这一位是**接好了等它** —— ❌ 别因为界面上还没出现过就断定这条路没通,
       * 也❌ 别改去匹配那句英文文案:那是供应商的措辞,改一次就静默失灵。
       *
       * `notices`:不声明,供应商的提示就伪装成不带 messageId 的 agent 文本,闲着时来一条会开出
       * 没人关的自发轮(会话一直 working、下一句永远排队)。
       */
      session: { compaction: {}, notices: {} },
      /**
       * ⚠️ 这一行**不是**上面 `auth.terminal` 的重复,删掉任何一个都会让一批 harness 变哑。
       *
       * 同一件事,线上有**两套互不相认的门控**:
       *  · 规范的 `clientCapabilities.auth.terminal` —— 新一代 adapter 认它
       *    (咕咕钉的 `@agentclientprotocol/*` 就是这一代);
       *  · Zed 的厂商扩展 `clientCapabilities._meta['terminal-auth']` —— 老一代认它
       *    (opencode / mimocode / 老 `@zed-industries/claude-code-acp` 走这条)。
       *
       * 一手出处(读的是真源码,不是文档转述):`sst/opencode@c2eacd7`
       * `packages/opencode/src/acp/service.ts:102-111`,逐字
       * `if (params.clientCapabilities?._meta?.["terminal-auth"] === true)` 才把
       * `_meta['terminal-auth'] = { command, args, label }` 挂上去。mimocode 是 opencode 的
       * 逐字节 fork,同一道门。
       *
       * 阴性对照(2026-08-27 真起进程):只发 `auth:{terminal:true}` 不发这一行,opencode 与
       * claude-code-acp **双双把 `_meta` 从方法里去掉**,只回裸的 `{description,name,id}` ——
       * 也就是说少了这行,拿到的仍然只是一个名字。
       */
      _meta: {
        'gugu.mcp-input-preview': true,
        'terminal-auth': true,
        /**
         * 上面 `subagents: {}` 是规范草案字段(agent-client-protocol#1992),已发布的
         * TypeScript SDK 还没保留它;在它落地之前,同一件事的过渡signal走 JetBrains AIR
         * 扩展。两个都发:规范字段一旦可用就**优先**(README:“The canonical field remains
         * supported and takes precedence once it is available.”),AIR 这份是兜底。
         *
         * ⚠️ 两个能力**各管一段,缺一不可**:
         *  · `nativeSubagentSessions` —— 子智能体拿到自己的会话(`subagent_spawned` /
         *    `subagent_state_update`),取消走规范的 `session/cancel` 打那个子会话。
         *  · `asyncTasks`             —— 后台任务生命周期(`async_task_spawned` /
         *    `_progress` / `_state_update`)。适配器里这条 lane 由
         *    `clientSupportsAsyncTasks(clientCapabilities)` 把关,**不声明就整条不发**,
         *    后台命令连 `canStop` / `toolCallId` 都拿不到。
         *
         * 形状不是猜的,来自 0.75.1 的 `air-extension.js`:`version` 必须是 ≥1 的整数,
         * `capabilities` 必须是数组且 `includes` 那个名字,三条全中才算声明过。
         */
        ...(agent.protocolVersion === 2
          ? {
              /**
               * v2 的后台任务扩展(`_async_task_*` 与 `_session/async_task/stop`)。v2 的子智能体是
               * 标准的子会话(取消走 `session/cancel`),后台命令没有标准形态,靠这个具名扩展。
               * v2 不声明 AIR 的子智能体能力; sessionFailure 只在终态消费者就位后单独声明。
               */
              asyncTasks: {},
              ...(sessionFailure.length ? { jetbrains: { air: { version: 1, capabilities: sessionFailure } } } : {}),
            }
          : {
              jetbrains: {
                air: {
                  version: 1,
                  capabilities: ['nativeSubagentSessions', 'asyncTasks', ...sessionFailure],
                },
              },
            }),
      },
    },
  };
  return agent.initialize(request);
}

function failClosedBeforeReady(closed: ProcessClosed): never {
  if (closed.kind === 'error') throw closed.error;
  throw new Error(
    `ACP agent process exited before initialize completed `
      + `(code ${closed.exitCode ?? 'null'}, signal ${closed.signal ?? 'null'})`
  );
}

function exitCodeFromClosed(closed: ProcessClosed): number | null {
  return closed.exitCode;
}

function signalFromClosed(closed: ProcessClosed): string | null {
  return closed.signal;
}

/** 适配器 stderr 的滚动尾巴 —— 进程死了之后唯一还能问它「你最后说了什么」的地方。 */
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_LINE_CHARS = 400;

function createStderrTail(): {
  push: (chunk: string) => void;
  text: () => string;
  lineCount: () => number;
} {
  const lines: string[] = [];
  let pending = '';
  const keep = (line: string): void => {
    if (!line.trim()) return;
    lines.push(boundedRedactedLine(line));
    if (lines.length > STDERR_TAIL_LINES) lines.shift();
  };
  return {
    push(chunk) {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        keep(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      // 没有换行结尾的最后一段也要能被读到 —— 适配器常常正是死在半句话上。
      if (pending.length > STDERR_TAIL_LINE_CHARS) {
        keep(pending);
        pending = '';
      }
    },
    text() {
      const all = pending.trim() ? [...lines, boundedRedactedLine(pending)] : lines;
      return all.slice(-STDERR_TAIL_LINES).join('\n');
    },
    lineCount() {
      return pending.trim() ? Math.min(lines.length + 1, STDERR_TAIL_LINES) : lines.length;
    },
  };
}

/**
 * 一行进入尾巴的唯一处理点:先脱敏、再截断。⇒ 两个调用点(整行 / 无换行的残段)共用这一份,
 * ❌ 不各自拼一遍 `redactSecrets(...).slice(...)`。
 *
 * **这个顺序是承重的**,而且不是「大概更稳妥」——具体是哪条规则会塌,可以指名:
 * 带引号那条 kv 规则用反向引用 `("?)…\3` 要求闭合引号在场。若先截断、闭合引号落在 400 字符
 * 之外,它就匹配不上,于是值的前半段**以明文留在行里**(实测 `authorization="SSS…`
 * 漏出 24 个字符)。前缀锚定的那几条(`sk-` 等)截断后仍能匹配,不受影响 ——
 * 所以这条顺序保护的是**需要右边界的规则**,不是全部。
 */
function boundedRedactedLine(line: string): string {
  return redactSecrets(line.trim()).slice(0, STDERR_TAIL_LINE_CHARS);
}

/**
 * 适配器的 stderr 会带上游打出来的凭据(token / key / Authorization 头)。
 * 日志红线是「只打键名不打值」⇒ 值在**进入日志之前**就换成 `<redacted>`,
 * ❌ 不靠「大概不会打出来」。
 *
 * ⚠️ 规则按**形态**写,不按「今天哪个 adapter 会打什么」写:stderr 是第三方 adapter/SDK 的
 * 自由文本,咕咕对它没有控制权(#5391)。
 */
function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{8,}/g, '$1-<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>')
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|authorization)\b(\s*[:=]\s*)("?)[^\s",}]{4,}\3/gi,
      '$1$2<redacted>'
    )
    // URL query 里的凭据 —— 网关和 SDK 报错最常见的写法就是把整条请求 URL 打出来,而那里的
    // 参数名往往既没有 `api` 也没有 `access`(`?token=` / `&key=` / `&sig=`),上面三条一个都拦不住。
    // 只认 query 位置(`?`/`&` 紧跟参数名),散文里的 `key=value` 不受影响;值里排除 `<`,
    // 免得把已经换好的 `<redacted>` 再吃一遍。
    .replace(/([?&](?:key|token|auth|sig|signature)[A-Za-z0-9_-]*=)[^&\s"'<]+/gi, '$1<redacted>')
    .replace(/\beyJ[A-Za-z0-9._-]{16,}/g, '<redacted-jwt>')
    // 登录邮箱不是凭据,但它可识别到人,而这些日志会被贴进 issue 与证据包。只换本地部分、
    // **留域名** —— 域名说明「哪个租户/哪个上游」,对定位错网关有用,不说明「是谁」。
    // 末尾的 `(?![:/])` 把 scp 形式的 git 远端(`git@github.com:owner/repo`)排除在外:
    // 那不是一个邮箱地址,而是一条有用的 stderr。
    .replace(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b(?![:/])/g, '<redacted>@$1');
}
