import { z } from 'zod';
import { foregroundEndSchema } from '../../session-protocol';
import { terminalStateSchema } from '../terminals';
import { stopReasonSchema } from '../session';
import { transcriptCompactionSchema } from './compaction';
import { transcriptContextResetSchema } from './context-reset';
import { transcriptMessageSchema } from './messages';
import { transcriptSessionNoticeSchema } from './session-notice';
import { transcriptThinkingSchema } from './thinking';
import { toolNodeSchema } from './tool-calls';

export const transcriptItemSchema = z.union([
  transcriptMessageSchema,
  transcriptThinkingSchema,
  transcriptCompactionSchema,
  transcriptContextResetSchema,
  transcriptSessionNoticeSchema,
  toolNodeSchema,
]);
export type TranscriptItem = z.infer<typeof transcriptItemSchema>;

export const transcriptTurnInitiatorSchema = z.enum(['user', 'agent']);
export type TranscriptTurnInitiator = z.infer<typeof transcriptTurnInitiatorSchema>;

/**
 * Successful turn reasons come from foreground idle. `cycle_end` preserves a boundary
 * whose native reason was absent, null or unknown; `foreground` retains the original fact.
 *
 * ⚠️ 这里曾经叫 `quiesced`:「250 ms 没来事件就当它讲完了」。那不是边界,是猜 ——
 * 网关流式中途任何一次 >250 ms 的停顿都会把正在写的那条消息当场封口成一轮,
 * 下一段字再懒开新轮(owner 2026-09-06 真机:句号、右括号被切到下一段,半截消息
 * 底下冒出「复制消息」,轮在活动层/已提交层之间来回跳)。
 */
export const doneTurnReasonSchema = z.union([stopReasonSchema, z.literal('cycle_end')]);
export type DoneTurnReason = z.infer<typeof doneTurnReasonSchema>;

/** Cancellation is modeled as its own outcome instead of a successful stop reason. */
/**
 * `interrupted_for_message`:不是用户停的 —— 这一家收不了回合中途的插话,咕咕在工具边界替它停下
 * 这一轮,好让刚到的消息作为下一轮进去(transport tool-boundary interruption, #6335)。下一轮就是接着干,
 * 所以界面上❌ 不给「继续 / 丢弃」。
 */
export const cancelledTurnReasonSchema = z.enum(['cancelled', 'interrupted_for_message']);
export type CancelledTurnReason = z.infer<typeof cancelledTurnReasonSchema>;

/** Runtime-normalized failure categories that can settle a transcript turn. */
export const errorTurnReasonSchema = z.enum([
  'prompt_failed',
  'process_closed',
  'spawn_failed',
  'initialize_failed',
  'new_session_failed',
  'load_session_failed',
  'cancel_failed',
  'set_config_failed',
  'set_mode_failed',
]);
export type ErrorTurnReason = z.infer<typeof errorTurnReasonSchema>;

/**
 * ⚠️ 这里**曾经**还有一支 `interrupted`(reason: `process_closed` / `replaced`)——
 * 2026-09-20 随 #4875 ① 删掉。它被声明过、被翻译过,**从来没有任何生产者**:
 * 全仓 `settleTurn` 的每一个调用点读完,live runtime 只产出 `done` / `cancelled` / `error`。
 * 而一个被翻译过的枚举值,读起来与一个活着的状态没有区别 —— 有人照它写验收判据,
 * **红了十四轮才发现红的是判据自己**(#4875 的实账)。
 *
 * ⇒ 进程在回合中途死亡现在有了**真正的产地**:`error` + `process_closed`
 *   (见 session-runtime 的 `classifyTurnFailure`)。它对用户就是一次失败 ——
 *   这一轮没做完、要重开引擎 —— 所以它住在 `error` 里,而不是一支"非错误的中断"。
 * ❌ 不要把这支加回来:除非有人真的去产出它,否则加回来的只是第二份死词汇。
 */
export const transcriptTurnOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done'), reason: doneTurnReasonSchema.optional() }),
  z.object({ kind: z.literal('cancelled'), reason: cancelledTurnReasonSchema.optional() }),
  z.object({
    kind: z.literal('error'),
    reason: errorTurnReasonSchema.optional(),
    /**
     * 出事那一侧**自己说的话**,逐字 —— `reason` 回答「哪一类失败」,它回答「到底是什么」。
     *
     * 谁来填:只有一个写入者,session-runtime 的 `classifyTurnFailure`。它按失败被观测到的**边界**
     * 分类(prompt 被拒 / 适配器进程退出 / 连接丢失),❌ 不在别处按字符串认人。
     *
     * 里面装什么:provider 的那句话 + 它带着的结构化负载(错误码、字段),或者适配器退出时的
     * 退出码/信号 + 它 stderr 的尾巴。**多行是正常的**,界面负责折叠 ——
     * ❌ 不在数据侧硬截断:被砍掉的那一半恰恰常常是能对账的那一半。
     */
    detail: z.string().optional(),
    /**
     * 这一轮失败是因为这家 harness 在这台机器上的登录不能用了(#6264):过期、被撤销、要重新登录。
     *
     * 只由 session-runtime 的 `classifyTurnFailure` 按**结构化信号**判(ACP `authRequired` 的 -32000、
     * codex 的 `codexErrorInfo: unauthorized` / HTTP 401),❌ 不按那句话的字面猜。
     * 老版本不认这一格会把它剥掉,照旧显示成一次普通的失败 —— 不会读坏。
     */
    signInRequired: z.boolean().optional(),
    /**
     * 这一轮是咕咕拒的:跑咕咕平台模型时,这一轮来要票、宿主签不出(#7103「谁拒绝谁说话」)。装的是原因
     * (session-core `GuguCatalogReason`,如 `membership-required`),界面按原因表说那一句、给那个按钮;
     * 这时 harness 自己那句(claude 的「apiKeyHelper is failing」)不是拒绝方的话,不进 `detail`。
     * 宿主在回绝取票**之前**把原因递进这一轮(announceSession),所以结算时一定已经在手上。老版本剥掉它照旧显示。
     */
    guguReason: z.string().optional(),
    /**
     * 上游(网关 / provider)回给 harness 的那一句,一行(#7103「谁拒绝谁说话」):「回合失败」那一行直接说它,
     * 原文照旧在 `detail`。只在 harness 把上游的 HTTP 错误体原样递上来、自己不另说一遍时才有(codex 的 turn.error);
     * 由 session-runtime 的 `classifyTurnFailure` 定。老版本剥掉它,照旧显示「回合未能完成」。
     */
    said: z.string().optional(),
  }),
]);
export type TranscriptTurnOutcome = z.infer<typeof transcriptTurnOutcomeSchema>;

export const transcriptTurnSchema = z.object({
  foreground: foregroundEndSchema.optional(),
  /** Reducer-generated turn id used to scope all item ids in this exchange. */
  id: z.string(),
  /** Stable session order, assigned when the turn opens. */
  seq: z.number().int(),
  /** Who opened the turn: a user prompt or agent-originated background activity. */
  initiator: transcriptTurnInitiatorSchema,
  /**
   * Epoch ms read off the wall clock at the moment this turn opened.
   *
   * **Absent means "unknown", never "now".** A turn rebuilt by provider replay
   * (ACP `session/load`) has no authentic clock: the protocol replays the
   * updates without their original timestamps, so the only `at` the reducer
   * holds during replay is the replay's own. Stamping that would date a
   * week-old conversation as today — confidently wrong, which is worse than no
   * reading at all. The reducer therefore leaves the field off during replay,
   * and consumers must render nothing rather than substitute a guess.
   */
  startedAt: z.number().optional(),
  /**
   * Epoch ms when this turn was closed (turn_end, or the next user prompt).
   *
   * Same rule as `startedAt`: absent during replay, because the only clock the
   * reducer holds then is the replay's own. Consumers pair it with `startedAt`
   * to say how long the turn worked (owner 2026-09-06: 「过程我不关心几步,我关心的
   * 是运行多长时间」); with either side missing there is no honest reading.
   */
  endedAt: z.number().optional(),
  items: z.array(transcriptItemSchema),
  /** Bounded snapshots for terminals this turn actually references. */
  terminals: z.array(terminalStateSchema).optional(),
  /** Durable settlement for the whole turn; absent for replayed history without an explicit end. */
  outcome: transcriptTurnOutcomeSchema.optional(),
});
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;
