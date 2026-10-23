import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { assistantStartupIndex, type AssistantStartupIndexDeps } from '../sessionpage/assistant-startup-index'

/** The native assistant hooks use the same authenticated action router as the listed tools. */
export function registerAssistantResource(server: McpServer, deps: AssistantStartupIndexDeps): void {
  server.registerResource('gugu-resource-index', 'gugu://assistant/resources', { mimeType: 'text/plain' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: await assistantStartupIndex(deps) }],
  }))
}
