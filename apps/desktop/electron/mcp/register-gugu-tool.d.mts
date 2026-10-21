// register-gugu-tool.mjs 的类型面(与 list-window.d.mts 同一做法)。
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { z } from 'zod'

export type GuguToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type GuguToolResult = { content: GuguToolContent[]; isError?: boolean }

export interface GuguToolRegistration {
  name: string
  description: string
  schema: z.ZodTypeAny
  /** 注册宽、执行严(社交域写类工具):见 register-gugu-tool.mjs。 */
  permissive?: boolean
  preflight?: (args: unknown) => void
}

export declare function registerGuguTool(
  server: McpServer,
  def: GuguToolRegistration,
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<GuguToolResult>,
  track: <T>(work: Promise<T>, toolName?: string) => Promise<T>,
): void
