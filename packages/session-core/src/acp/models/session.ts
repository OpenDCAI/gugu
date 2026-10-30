import { z } from 'zod';
import { acpStartSessionErrorSchema } from '../api/errors';
import { acpPermissionRequestSchema } from './permissions';
import { sessionUsageSchema } from './config';
import { queuedPromptSchema } from './prompt';

export const stopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

/**
 * 上一个回合**怎么结束的** —— 与 `lastStopReason` 并列,不替代它。
 *
 * `lastStopReason` 只能表达 ACP 协议自己的停止原因(`stopReasonSchema`),异常终结在那张表里没有档,
 * 于是机器把它投影成 `null`;而 `null` 同时还表示「还没有任何回合结束过」(见 `initialMachineState`)。
 * **一个值背两个意思 ⇒ 下游结构上无法把「异常终结」与「尚未开始」分开**,徽标因此永不回落(#4618)。
 *
 * ⇒ 这里补的是**缺失的那条信息**,不是修正已有的那条:`lastStopReason` 的形状一个字节不动,
 * 既有消费者不必迁移。❌ 也不往 `stopReasonSchema` 里加 `'error'` —— 那是 ACP 协议的枚举,
 * 还被 `doneTurnReasonSchema` / bridge-protocol / extension-agents 复用,
 * 往协议枚举里塞协议没有的档 = 把建模缺口转嫁给协议层。
 *
 * 四态各自可读,❌ 不再有任何一个值承担两种含义:
 *   · 尚未有回合结束 —— `lastTurnOutcome === 'none'`
 *   · 正常终止      —— `'stopped'` 且 `lastStopReason` 在正常原因集合里
 *   · 取消          —— `'stopped'` 且 `lastStopReason === 'cancelled'`
 *   · 异常终结      —— `'errored'`(此时 `lastStopReason` 仍为 `null`,因为协议没给原因)
 */
export const lastTurnOutcomeSchema = z.enum(['none', 'stopped', 'errored']);
export type LastTurnOutcome = z.infer<typeof lastTurnOutcomeSchema>;

/**
 * ACP session lifecycle owned by the SessionMachine.
 *
 * - `starting`: agent process/session setup is in progress.
 * - `replaying`: an existing ACP session is loading historical updates.
 * - `ready`: no foreground work is active; a prompt can start immediately.
 * - `working`: a foreground user prompt turn is running.
 * - `cancelling`: cancellation was requested; waiting for agent settlement.
 * - `closed`: runtime session is no longer usable.
 */
export const sessionLifecycleSchema = z.enum([
  'starting',
  'replaying',
  'ready',
  'working',
  'cancelling',
  'lost',
  'closed',
]);
export type SessionLifecycle = z.infer<typeof sessionLifecycleSchema>;

/**
 * 适配器进程**怎么没的** —— 在连接层观测到的那一刻的完整事实。
 *
 * ⚠️ 这三格此前只进日志(`task/acp-exit`,#5388),没有一格走到结算:宿主的
 * `onProcessClosed(processKey, exitCode)` 只带退出码,signal 与 stderr 在**回调签名上**
 * 就被截断了。于是「引擎为什么退」在产品面无从回答,而收尾行只会说一句
 * 「这条指令没能送达」——**指令其实送达了,是引擎死了**(#5858 / #4875 ②)。
 *
 * ⇒ 事实在边界上是完整的,就一路带着走;❌ 不在结算处回头去捞日志把它拼回来。
 */
export type AdapterExit = {
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** 适配器自己最后说的话(按行去敏、按行数封顶的滚动尾巴);没有就是空串。 */
  readonly stderrTail: string;
};

/** Why a session became terminal without an intentional stop. */
export const sessionFailureSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('adapter-exit'),
    exitCode: z.number().int().nullable(),
    /** 收到的终止信号(`SIGKILL` 等);进程自己 exit 时为 null。 */
    signal: z.string().nullable().optional(),
    message: z.string().min(1),
  }),
  /**
   * 会话**没能起来**(#6183)。与 `adapter-exit` 同为 `lost`:这条会话此刻不能干活,原因在这里。
   *
   * ⚠️ 它此前不是一个状态:启动失败只删掉 `starting` 摘要,于是状态投影看到的是「会话消失了」
   * ⇒ reset,而 reset 不经过 presence 那条 tap ⇒ 聊天页停在 Running 5 分钟以上,
   * 会话页却写着「The engine could not start」—— 同一时刻两个面两句话。
   * `error` 是启动返回给调用方的那个结构化错误,原样,❌ 压成字符串。
   */
  z.object({
    kind: z.literal('start-failed'),
    message: z.string().min(1),
    error: acpStartSessionErrorSchema,
  }),
]);
export type SessionFailure = z.infer<typeof sessionFailureSchema>;

export const sessionStateSchema = z.object({
  lifecycle: sessionLifecycleSchema,
  /** The transcript's open group (display grouping), or null. Not the agent's state: see `lifecycle`. */
  activeTurnId: z.string().nullable(),
  pendingPermissions: z.array(acpPermissionRequestSchema),
  /** Last ACP prompt stop reason observed by the machine; separate from transcript outcomes. */
  lastStopReason: stopReasonSchema.nullable(),
  /** How the last turn ended. Parallel to `lastStopReason`; see `lastTurnOutcomeSchema`. */
  lastTurnOutcome: lastTurnOutcomeSchema,
  /** Prompts accepted while busy; attachments are references, never inline bytes. */
  queuedPrompts: z.array(queuedPromptSchema),
  /** Count of running background subagents, used for affordances and busy state. */
  backgroundAgentCount: z.number().int(),
  /** Running background commands (`runningBackgroundCommands`). Status only: not busy, not cancellable. */
  backgroundCommandCount: z.number().int(),
  /**
   * 这些后台命令的任务 id —— `runningBackgroundCommands` 在**本进程**里给出的结果本身,
   * `backgroundCommandCount` 是它的长度。面板花名册按它筛:转录里的卡(尤其库里读出来的旧轮)说「在跑」
   * 不算数,运行时说了才算 —— 上一个进程起的命令随进程没了,永远等不来终态(#6582)。
   * 缺席 = 对面是不报这一格的旧运行时(如远程咕咕 server 旧版),读者按「不知道、不过滤」处理;
   * ❌ 给它 `.default([])`:那会把旧运行时那头真在跑的卡全藏掉。
   */
  backgroundCommandTaskIds: z.array(z.string()).optional(),
  /** Machine-owned UI affordance: true while foreground or background work is active. */
  isGenerating: z.boolean(),
  /** Machine-owned UI affordance: true when a prompt may be accepted or queued. */
  canSubmit: z.boolean(),
  /** Machine-owned UI affordance: true when there is cancellable foreground/agent work. */
  canCancel: z.boolean(),
  /** Structured terminal cause; present for `lost`, absent for normal `closed`. */
  failure: sessionFailureSchema.nullable().optional(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * 会话正在起的**哪一步**(#6183)。启动不设墙钟 ⇒ 等待必须看得见:用户要知道它在等什么、等了多久,
 * 才谈得上取消;取消 / 失败时报出的原因也按这一格说「卡在哪一步、等了多久」。
 * - `preparing-adapter`:宿主在等这一家配对的 ACP 桥接下载完(#6394)。只在用户的 CLI 升级后第一次出现,
 *   由宿主经 `sessionStartStageChannel` 报(那时 worker 还没开始起会话),worker 自己从不报;
 * - `checking-executable`:版本探针在跑(`<engine> --version`);
 * - `starting-engine`:适配器进程已起,等它回 `initialize`;
 * - `opening-session`:`session/new` / `session/load` 及启动期配置。
 */
export const acpStartStageSchema = z.enum([
  'preparing-adapter',
  'checking-executable',
  'starting-engine',
  'opening-session',
]);
export type AcpStartStage = z.infer<typeof acpStartStageSchema>;
export const acpStartProgressSchema = z.object({
  stage: acpStartStageSchema,
  /** 这一步开始的时刻。 */
  since: z.number(),
  /** 整次启动开始的时刻。 */
  startedAt: z.number(),
  /** 正在被探 / 被起的那个可执行文件;解析不出时 null。 */
  executable: z.string().nullable(),
});
export type AcpStartProgress = z.infer<typeof acpStartProgressSchema>;

/** 一条待决的权限请求在等人什么;提问与计划审批也走 `session/request_permission`,由 `permissionWaitKind` 分类。 */
export const permissionWaitKindSchema = z.enum(['approval', 'question', 'plan']);
export type PermissionWaitKind = z.infer<typeof permissionWaitKindSchema>;

export const pendingPermissionWaitSchema = z.object({
  requestId: z.string(),
  waitKind: permissionWaitKindSchema,
});
export type PendingPermissionWait = z.infer<typeof pendingPermissionWaitSchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  providerId: z.string(),
  lifecycle: sessionLifecycleSchema,
  /** Admission is withdrawn before provider teardown; the process may still be exiting. */
  closing: z.boolean().optional(),
  /** UI affordance, includes background agents. Status reads `lifecycle` instead (park). */
  isGenerating: z.boolean(),
  lastStopReason: stopReasonSchema.nullable(),
  /** How the last turn ended. Parallel to `lastStopReason`; see `lastTurnOutcomeSchema`. */
  lastTurnOutcome: lastTurnOutcomeSchema,
  pendingPermissionCount: z.number().int(),
  /** The same pending requests as `pendingPermissionCount`, in arrival order, each with what it waits on. */
  pendingPermissionWaits: z.array(pendingPermissionWaitSchema),
  backgroundAgentCount: z.number().int(),
  /** Running background commands; see `sessionStateSchema.backgroundCommandCount`. */
  backgroundCommandCount: z.number().int(),
  queuedPromptCount: z.number().int(),
  /**
   * The context the engine last reported in use (`usage_update.used`); null until it reports one in this process.
   * Absent: an older runtime that does not report this cell — read it as "not known".
   */
  contextTokens: z.number().nullable().optional(),
  /** The window that reading is out of (`usage_update.size`), with the same null / absent meaning. */
  contextSize: z.number().nullable().optional(),
  /** The model this session reported when that reading arrived — a window belongs to one model (#7342). Same null / absent meaning. */
  contextModelId: z.string().nullable().optional(),
  /** The model this session reports it runs (ACP `currentModelId`); null until reported, absent from an older runtime. */
  modelId: z.string().nullable().optional(),
  /** The account's limit as this session's engine last reported it (`usage.rateLimit`); null until it reports one in this process. */
  rateLimit: sessionUsageSchema.shape.rateLimit,
  title: z.string().nullable(),
  /** The session record path the harness itself reported (`transcript_path` event); absent until it reports one. Host-local. */
  transcriptPath: z.string().optional(),
  /** Rolling provider tool names for the shared agent-presence projection. */
  recentActions: z.array(z.string()).optional(),
  /** Wall-clock time of the newest live tool action, when known — kept past the recent-actions window (same as the record timeline). */
  lastActionAt: z.number().nullable().optional(),
  /** Structured terminal cause; present for `lost`, absent for normal `closed`. */
  failure: sessionFailureSchema.nullable().optional(),
  /** Present only while `lifecycle === 'starting'`: which start step is being awaited. */
  startProgress: acpStartProgressSchema.nullable().optional(),
  /**
   * 适配器声明了 `loadSession`:停掉之后下一次启动能按原 provider session 接回来。
   * 起动占位摘要(还没有 cell)不带;缺席 = 不知道,读者按「接不回来」处理。
   */
  canLoadSession: z.boolean().optional(),
  updatedAt: z.number(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
