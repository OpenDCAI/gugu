import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { registerGuguTool } from './register-gugu-tool.mjs'

export interface SessionWebSearch {
  /** Evaluated when the harness connects, after platform startup has issued its lease. */
  available(): boolean
  run(query: string, signal: AbortSignal): Promise<string>
}

export function registerGuguWebSearchTool(server: McpServer, search: SessionWebSearch, track: GuguMcpRequestTracker): void {
  registerGuguTool(server, {
    name: 'web_search',
    description: 'Search the web for current information. Returns sources and search results.',
    schema: z.object({ query: z.string().trim().min(1) }).strict(),
  }, async (args, signal) => ({
    content: [{ type: 'text' as const, text: await search.run((args as { query: string }).query, signal) }],
  }), track)
}
