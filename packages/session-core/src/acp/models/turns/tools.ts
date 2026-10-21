import { z } from 'zod';

export const toolStatusSchema = z.enum(['running', 'done', 'error']);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

/**
 * `subagent-batch` —— 一次并行派发(#4981)。
 *
 * 上游 `elements-subagent-list` 把这件事说透了:「派给多个子 agent 天然就是一个回合里的
 * 多次工具调用,一个 worker 一次;**这个列表不是任何单次调用的 UI,它是从所有调用汇总
 * 出来的**」。所以它不是一种新工具,而是一组已有工具调用的**聚合**,与 `read-batch`
 * 同一个位置。
 */
export const toolCallGroupKindSchema = z.enum(['read-batch']);
export type ToolCallGroupKind = z.infer<typeof toolCallGroupKindSchema>;
