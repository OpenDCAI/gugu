import { z } from 'zod';
import { attachmentRefSchema } from '../attachments';

export const transcriptMessageSchema = z.object({
  kind: z.literal('message'),
  /** Provider message id scoped to the turn, or reducer-synthesized fallback id. */
  id: z.string(),
  /** Stable order within the owning turn, assigned once by the reducer. */
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  /** Native provider boundary; never a display index or a text match. */
  revertAnchor: z.string().optional(),
  /** Attachment metadata only; bytes are served separately by the runtime. */
  attachments: z.array(attachmentRefSchema).optional(),
  /**
   * Epoch ms when this message **started** arriving (first chunk). Later chunks do not move it.
   *
   * 与 `TranscriptTurn.startedAt` 同一条合同:**缺席 = 不知道,不是「现在」**。回放
   * (ACP `session/load`)重放的是内容而不是当时的时刻,那时 reducer 手里只有回放自己的钟,
   * stamp 它等于把一周前的话标成刚才 —— 所以回放期间这一格根本不写。
   *
   * 用途:一轮被钩子劈成几段时(#5350),段与段的边界就是钩子通知这条消息的到达时刻 ——
   * 没有它,后面几段的折叠头写不出「用时」。
   */
  at: z.number().optional()
});
export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;
