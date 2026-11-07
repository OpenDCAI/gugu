import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { setExtensionCheckAvailable } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { createAllFamilies } from '../../../../apps/desktop/electron/device-actions/families'
import { CORE_TOOL_RISKS, DEVICE_ACTION_RISKS } from '../../../../apps/desktop/electron/permissions/inventory'

describe('service permission risk inventory', () => {
  it('classifies the entire actual MCP composition, including catalog-only tools and both provision roles', async () => {
    const names = new Set<string>()
    setExtensionCheckAvailable(true)
    try {
      for (const assistant of [false, true]) {
        const host = createDesktopGuguMcpHost()
        const client = new Client({ name: 'permission-inventory', version: '1' })
        try {
          await host.start()
          const grant = await host.grant('permission-inventory', {
            kind: 'social', ...(assistant ? { personalAssistant: true as const } : {}),
            expectedOwnerUserId: 'inventory-owner', subjectId: 'inventory-agent', agentId: 'inventory-agent',
            supabaseUrl: 'https://supabase.invalid', anonKey: 'test', threadRootId: null,
            guguHome: join(tmpdir(), 'permission-inventory'), getAccessToken: async () => 'test',
            runSessionAction: async () => ({}), runExtensionAction: async () => ({}),
            webSearch: { available: () => true, run: async () => '' },
          })
          await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
            requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
          }))
          for (const tool of (await client.listTools()).tools) names.add(tool.name)
          let rows: string | null = '20'
          while (rows) {
            const result = await client.callTool({ name: 'catalog_list', arguments: { rows } })
            expect(result.isError).not.toBe(true)
            const text = (result.content as { type: string; text: string }[])[0]!.text
            const page = JSON.parse(text) as { next: string | null; items: { call?: string }[] }
            for (const item of page.items) if (item.call) names.add(item.call.split('(')[0]!)
            rows = page.next
          }
        } finally { await client.close(); await host.dispose() }
      }
    } finally { setExtensionCheckAvailable(false) }
    expect(Object.keys(CORE_TOOL_RISKS).sort()).toEqual([...names].sort())
    // app_check drives a real page; project operations also change group access, despite their names.
    expect(CORE_TOOL_RISKS.app_check).toEqual({ risk: 'high', effect: 'execute' })
    expect(CORE_TOOL_RISKS.project_get).toEqual({ risk: 'high', effect: 'social' })
    expect(CORE_TOOL_RISKS.project_add_folder).toEqual({ risk: 'high', effect: 'permission' })
    expect(CORE_TOOL_RISKS.session_archive).toEqual({ risk: 'high', effect: 'permission' })
    for (const name of ['message_rules', 'message_members', 'topic_list', 'topic_members', 'group_info', 'group_list', 'profile_whoami', 'session_devices']) {
      expect(CORE_TOOL_RISKS[name]).toEqual({ risk: 'medium', effect: 'read' })
    }
  })
  it('classifies exactly the actual device actions, including generated computer mappings and mixed-case names', () => {
    const names = new Set(createAllFamilies(null).flatMap(family => family.actions.map(action => action.name)))
    expect(Object.keys(DEVICE_ACTION_RISKS).sort()).toEqual([...names].sort())
    expect(DEVICE_ACTION_RISKS['mail.send']).toMatchObject({ risk: 'high', effect: 'owner' })
    expect(DEVICE_ACTION_RISKS['computer.run_steps']).toMatchObject({ risk: 'high', effect: 'execute' })
  })
})
