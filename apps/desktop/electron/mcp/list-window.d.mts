// list-window.mjs 的类型面(与 mcp-tool-description-budget.d.mts 同一做法:给真类型,不压成 any)。
import type { z } from 'zod'
import type { AgentStatus, AgentStatusDetail } from '../../../../packages/core/src/shared/agentStatus'

export declare const LIST_DEFAULT_ROWS: number
export declare function parseRows(value: unknown, defaultRows?: number): { from: number; to: number }
export interface ListWindow<T> {
  total: number
  rows: string | null
  next: string | null
  items: T[]
}
export interface ListSpec<T> {
  namesOf: (row: T) => ReadonlyArray<unknown>
  keep?: (row: T, args: Record<string, unknown>) => boolean
  statusFilter?: boolean
  catalog?: boolean
}
export declare function windowList<T>(
  items: readonly T[],
  args: Record<string, unknown> | undefined,
  spec: ListSpec<T>,
): ListWindow<T>
/** 列表工具的整份结果按约定切窗(`key` 缺省 = 整张表就是结果)。 */
export declare function windowResult<T>(
  spec: ListSpec<T> & { key?: string },
  result: unknown,
  args: Record<string, unknown> | undefined,
): unknown
export declare function describeWindow(
  window: { from: number; to: number },
  total: number,
  pageLength: number,
): Omit<ListWindow<never>, 'items'>
export declare function withoutListArgs<T extends Record<string, unknown>>(args: T, extraKeys?: readonly string[]): T

export declare const listRowsSchema: z.ZodType<string | undefined, unknown>
export declare const listNameSchema: z.ZodOptional<z.ZodString>
export declare const listWindowShape: { rows: typeof listRowsSchema; name: typeof listNameSchema }

export type AgentStatusFilterWord = AgentStatus | AgentStatusDetail
export declare const AGENT_STATUS_FILTER_WORDS: readonly AgentStatusFilterWord[]
export declare const agentStatusFilterSchema: z.ZodOptional<z.ZodString>
export declare const pinnedFilterSchema: z.ZodOptional<z.ZodBoolean>
export declare function assertAgentStatusWord(word: unknown): void
export declare function matchesAgentStatus(
  row: { status?: string | null; detail?: string | null } | null | undefined,
  word: string | undefined,
): boolean
