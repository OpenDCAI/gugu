import { describe, expect, it } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
// @ts-expect-error -- the existing MCP social registrar is an untyped ESM module.
import { createGuguImServer } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import { registerGuguSessionTools } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'
import { registerGuguExtensionTools, setExtensionCheckAvailable } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { registerGuguProjectTools } from '../../../../apps/desktop/electron/mcp/gugu-project-tool'
import { registerGuguScheduleTools } from '../../../../apps/desktop/electron/mcp/gugu-schedule-tool'
import { registerGuguLibraryTools } from '../../../../apps/desktop/electron/mcp/gugu-library-tool'
import { registerGuguActivityTools } from '../../../../apps/desktop/electron/mcp/gugu-activity-tool'
import { registerGuguGuideTools } from '../../../../apps/desktop/electron/mcp/gugu-guide-tool'
import { registerGuguWebSearchTool } from '../../../../apps/desktop/electron/mcp/gugu-web-search-tool'
import { registerGuguAppSearchTool } from '../../../../apps/desktop/electron/mcp/gugu-app-search-tool'
import { registerGuguCatalogTools } from '../../../../apps/desktop/electron/mcp/gugu-catalog-tools'
import { registerGuguWidgetTool } from '../../../../apps/desktop/electron/mcp/gugu-widget-tool'
import { createAllFamilies } from '../../../../apps/desktop/electron/device-actions/families'
import { CORE_TOOL_RISKS, DEVICE_ACTION_RISKS } from '../../../../apps/desktop/electron/permissions/inventory'

describe('service permission risk inventory', () => {
  it('classifies exactly the union of the real core tool registrars in both provision roles', async () => {
    const names = new Set<string>()
    const track = <T>(value: Promise<T>) => value
    const run = async () => ({})
    setExtensionCheckAvailable(true)
    try {
      for (const assistant of [false, true]) {
        const server = createGuguImServer(() => ({}), { trackRequest: track }) as McpServer
        try {
          registerGuguSessionTools(server, run, track, assistant)
          registerGuguExtensionTools(server, run, track)
          registerGuguProjectTools(server, run, track)
          registerGuguScheduleTools(server, run, track)
          registerGuguLibraryTools(server, run, track)
          registerGuguActivityTools(server, run, track)
          registerGuguGuideTools(server)
          registerGuguWebSearchTool(server, { available: () => true, run: async () => '' }, track)
          registerGuguAppSearchTool(server, () => null)
          registerGuguCatalogTools(server, () => [])
          registerGuguWidgetTool(server, () => null, async () => '')
          for (const name of Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)) names.add(name)
        } finally { await server.close() }
      }
    } finally { setExtensionCheckAvailable(false) }
    expect(Object.keys(CORE_TOOL_RISKS).sort()).toEqual([...names].sort())
  })
  it('classifies exactly the actual device actions, including generated computer mappings and mixed-case names', () => {
    const names = new Set(createAllFamilies(null).flatMap(family => family.actions.map(action => action.name)))
    expect(Object.keys(DEVICE_ACTION_RISKS).sort()).toEqual([...names].sort())
    expect(DEVICE_ACTION_RISKS['mail.send']).toMatchObject({ risk: 'high', effect: 'owner' })
    expect(DEVICE_ACTION_RISKS['computer.run_steps']).toMatchObject({ risk: 'high', effect: 'execute' })
  })
})
