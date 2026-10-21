import { z } from 'zod';

/**
 * 引擎那侧接不上这条会话了，从这条线往下它是一条**新**会话（spec `session-history-replay`）。
 *
 * # 它为什么必须画出来
 *
 * `session/load` 失败时，产品的选择是「会话照常打开」而不是把它变成一个打不开的东西 ——
 * 这条不变。但降级不能是**静默**的：会话页现在自己存着历史，屏幕上照旧是完整的对话，
 * 而 agent 那边其实一个字都没有。用户看到满屏历史，理所当然地以为它读过；
 * 它没有。合同原话是「截断与失败都要留下可诊断的痕迹」。
 *
 * ⚠️ 这与 `compaction` 不是一回事，❌ 别合并：压缩之后 agent 手里还有一份摘要，
 * 这里它手里**什么都没有**。给用户的动作也不同 —— 压缩后多半不用重说，这里往往要重说。
 */
export const transcriptContextResetSchema = z.object({
  kind: z.literal('context-reset'),
  /** `${turnId}:context-reset`：一条会话的一次重开只有一条线。 */
  id: z.string(),
  /** Stable order within the owning turn, assigned once by the reducer. */
  seq: z.number().int(),
  /**
   * 为什么接不上。**必须带**：`session-history-replay` 说「『少了一截』和『本来就没有』
   * 在界面上长得一模一样」，只画一条线而不留原因，事后没有任何东西能分开
   * 「provider 认不出这条会话」与「换了一家引擎、找不到那份 rollout」。
   */
  reason: z.string(),
  /** Epoch ms when the reset happened. */
  at: z.number(),
});
export type TranscriptContextReset = z.infer<typeof transcriptContextResetSchema>;
