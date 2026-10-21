import { z } from 'zod';

/**
 * 上下文压缩在转录里的那一条痕迹（spec `session-history-replay`）。
 *
 * **为什么必须画出来**：压缩之后，agent 那边记得的是一份摘要而不是原文。界面上如果什么都不标，
 * 「它读过我上面说的话」和「它只读过一段摘要」长得一模一样，用户没有任何依据判断该不该再说一遍。
 * 合同原话是「截断与失败都要留下可诊断的痕迹」。
 *
 * 形状照 ACP 的 `session-compaction` RFD 定：一次压缩是一个带 `compactionId` 的实体，
 * 先 `in_progress` 再 `completed`，摘要可以分块流式补齐。实际喂进来的是哪条通道见
 * `decode.ts` 的 `decodeCompactionSessionUpdate`——今天走的是适配器挂在 tool call 上的
 * `_meta.contextCompaction`。
 *
 * ❌ 别把它做成一条普通工具调用 —— 2026-09-10 实测就是这样：不认那个 `_meta` 键时，
 * 一次压缩在界面上长成一个「不认识的工具调用」，标题 `Compact conversation`，
 * 用户完全看不出上文已经被换成摘要了。
 */
export const transcriptCompactionSchema = z.object({
  kind: z.literal('compaction'),
  /** `${turnId}:compaction:${compactionId}` —— 同一次压缩的续报要落回同一行。 */
  id: z.string(),
  /** Stable order within the owning turn, assigned once by the reducer. */
  seq: z.number().int(),
  /** 协议给的那次压缩的 id，续报靠它对上号。 */
  compactionId: z.string(),
  /**
   * `failed` 不在 RFD 的枚举里，是我们这侧的收敛：压缩失败对用户是**一件要知道的事**
   * （上下文没被压掉，下一轮可能直接撞窗口），❌ 不能悄悄当成没发生。
   */
  status: z.enum(['in_progress', 'completed', 'failed']),
  /** 摘要正文，流式补齐；没有也正常（agent 可以只报边界不给摘要）。 */
  summary: z.string(),
  /** Epoch ms when the compaction row opened. */
  startedAt: z.number(),
  /** 用户自己敲的 `/compact`，还是撞到窗口自动压的。 */
  trigger: z.enum(['manual', 'automatic']).optional(),
  /**
   * 压之前 / 压之后的 token 数。这两个数是**用户唯一能据以判断"丢了多少原文"的依据**，
   * 所以拿到就画出来；拿不到（RFD 那条通道不给）就只画一条线。
   */
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
  durationMs: z.number().optional(),
  /** 压缩失败的原因；有它就一定是 `failed`。 */
  error: z.string().optional(),
});
export type TranscriptCompaction = z.infer<typeof transcriptCompactionSchema>;
