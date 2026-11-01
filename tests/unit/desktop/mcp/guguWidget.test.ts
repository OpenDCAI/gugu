import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGuguWidgetTool } from '../../../../apps/desktop/electron/mcp/gugu-widget-tool'
import type { AppSearchHit, AppSearchSource } from '../../../../apps/desktop/electron/mcp/gugu-app-search-tool'
import { parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
// @ts-expect-error -- injectable ESM message writer
import { sendWidgetOf } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const manifest = parseExtensionManifest({ id: 'board', name: 'Board', version: '1.0.0', apiVersion: 26, defaultLocale: 'en', entry: 'main.html', contributes: { tabs: [{ name: 'main', title: 'Board', widget: { height: 240 } }] } })
const hit: AppSearchHit = { manifest, version: '1.0.0', state: 'on', widgetViews: [{ view: 'main', height: 240 }] }
const args = { chat_id: 'chat', app: 'board', view: 'main', text: 'Results', data: { count: 2 } }
const clients: Client[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())) })

async function connect(source: AppSearchSource) {
  const send = vi.fn().mockResolvedValue('sent (id=message)')
  const server = new McpServer({ name: 'widget', version: '1' })
  registerGuguWidgetTool(server, source, send)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'widget-test', version: '1' })
  clients.push(client)
  await Promise.all([server.connect(b), client.connect(a)])
  return { send, call: async (input: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'widget_send', arguments: input })
    return { error: result.isError, text: (result.content as { text: string }[])[0]!.text }
  } }
}

describe('widget_send', () => {
  it('serializes v2 and preserves the explicitly named destination', async () => {
    const { call, send } = await connect(async () => ({ apps: [hit] }))
    expect((await call(args)).error).not.toBe(true)
    expect(send).toHaveBeenCalledWith(args, JSON.stringify({ v: 2, text: 'Results', app: 'board', view: 'main', data: { count: 2 } }))
  })
  it('refuses oversized UTF-8 input before any write and says the actual size', async () => {
    const { call, send } = await connect(async () => ({ apps: [hit] }))
    expect(await call({ ...args, data: { s: '界'.repeat(1363) } })).toMatchObject({ error: true, text: expect.stringContaining('4097 UTF-8 bytes') })
    expect((await call({ ...args, text: '' })).text).toContain('1–200')
    expect(send).not.toHaveBeenCalled()
  })
  it('reads current App scope at each call, refusing off Apps and undeclared views', async () => {
    let state = 'off' as AppSearchHit['state']
    const { call, send } = await connect(async () => ({ apps: [{ ...hit, state }] }))
    expect((await call(args)).error).toBe(true)
    state = 'on'
    expect((await call({ ...args, view: 'other' })).error).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect((await call(args)).error).not.toBe(true)
  })
  it('refuses an unavailable App source rather than returning an empty result', async () => {
    const { call, send } = await connect(() => null)
    expect((await call(args)).text).toContain('not a side chat')
    expect(send).not.toHaveBeenCalled()
  })
  it('uses the message writer with a fixed identity, thread and no recipients', async () => {
    const rows: Record<string, unknown>[] = []
    const context = { agentId: 'agent', threadRootId: 'thread', guguHome: '/tmp/widget-test' }
    const deps = {
      restGet: async () => [],
      restRpc: async (name: string) => name === 'chat_facts' ? [{ id: 'chat', kind: 'group', group_prompt: null }] : name === 'list_member_ids' ? [{ user_id: 'agent' }] : [],
      restInsert: async (_table: string, row: Record<string, unknown>) => { rows.push(row) },
    }
    await sendWidgetOf(context, args, 'content', deps)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sender_user_id: 'agent', chat_id: 'chat', content: 'content', content_type: 'widget', thread_root_id: 'thread', to_user_ids: null })
    expect(rows[0]!.client_message_id).toBe(rows[0]!.id)
    await expect(sendWidgetOf({ ...context, forkOf: 'origin' }, args, 'content', deps)).rejects.toThrow('side chat')
  })
})
