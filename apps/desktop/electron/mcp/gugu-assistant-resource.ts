import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { assistantResourceChanges, writeResourceOverflow } from '../sessionpage/assistant-resource-changes'
import { assistantStartupIndex, type AssistantStartupIndexDeps } from '../sessionpage/assistant-startup-index'

/** The native assistant hooks use the same authenticated action router as the listed tools. */
export function registerAssistantResource(server: McpServer, deps: AssistantStartupIndexDeps, guguHome?: string): void {
  server.registerResource('gugu-resource-index', 'gugu://assistant/resources', { mimeType: 'text/plain' }, async uri => {
    const owner = await deps.accountId()
    if (!owner) throw new Error('Assistant resource owner is unavailable')
    const changes = guguHome ? assistantResourceChanges(guguHome, owner) : null
    const revision = await changes?.revision()
    const index = await assistantStartupIndex({ ...deps, ...(changes ? {
      overflow: async (index: string, observedOwner: string) => {
        if (observedOwner !== owner || await deps.accountId() !== owner) throw new Error('Assistant resource account changed')
        return writeResourceOverflow(guguHome!, owner, index)
      },
      observed: async (lines: string[], observedOwner: string) => {
        if (observedOwner !== owner || await deps.accountId() !== owner) throw new Error('Assistant resource account changed')
        return changes.observe(lines, revision)
      },
    } : {}) })
    const version = index.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      .find(row => row.source === 'resource_version')?.version
    if (changes && typeof version === 'number' && await deps.accountId() === owner) await changes.full(version)
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: index }] }
  })
}
