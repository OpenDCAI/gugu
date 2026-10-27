import { z } from 'zod';
import { transcriptTurnSchema } from '../models/turns';

/** Same epoch/sequence cursor shape as the record timeline; the data source stays ACP. */
const historyCursorSchema = z.object({ epoch: z.string(), seq: z.number().int() });
export type HistoryCursor = z.infer<typeof historyCursorSchema>;

export const historyPageInputSchema = z.object({
  sessionId: z.string(),
  before: z.number().int().optional(),
  limit: z.number().int(),
  /** 给了就改成「这个改动游标之后新增或改过的全部回合」(不分页,忽略 before / limit;@@@history-change-cursor)。 */
  changedSince: historyCursorSchema.optional(),
});

export const historyPageSchema = z.object({
  turns: z.array(transcriptTurnSchema),
  nextCursor: z.number().int().nullable(),
  /** 此刻的改动游标,下一次带着它问 `changedSince`。 */
  cursor: historyCursorSchema,
  /** The host restarted or the cursor cannot be resumed; request the first page. */
  reset: z.boolean(),
  /** 此刻已提交的回合数:比手里的少 = 有回合被拿掉了。 */
  count: z.number().int(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

export const resumeResultSchema = historyPageSchema.extend({
  providerSessionId: z.string(),
});
export type ResumeResult = z.infer<typeof resumeResultSchema>;

/** Both desktop transports fetch a visible picture by its original item id. */
export const toolImageInputSchema = z.object({
  sessionId: z.string(),
  itemId: z.string(),
  index: z.number().int().nonnegative(),
});
