import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
// @ts-expect-error — the injected MCP server is an untyped .mjs module.
import { createGuguImServer, serveToolsList } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const SELF = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const GROUP = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const GROUP_TOOLS = [
  'group_add_agent', 'group_announcement_delete', 'group_announcement_post',
  'group_announcement_update', 'group_avatar_set', 'group_create',
  'group_info', 'group_join_decide', 'group_join_requests', 'group_leave', 'group_list',
  'group_remove_member', 'group_set_role', 'group_update',
]
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const text = (result: Record<string, unknown>) => (result.content as Array<{ text?: string }>).map(item => item.text ?? '').join('\n')

/** This tests the SDK/schema/actor/receipt path; database ACLs have separate real-DB controls. */
async function connect(options: { rejection?: string; kind?: string; forkOf?: string; receipt?: unknown } = {}) {
  const writes: Array<{ name: string; body: Record<string, unknown> }> = []
  const context = {
    supabaseUrl: '', anonKey: '', agentId: SELF, threadRootId: null,
    guguHome: '/tmp/gugu-listen-sdk-fixture',
    getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.x`,
    ...(options.forkOf === undefined ? {} : { forkOf: options.forkOf }),
  }
  const server = createGuguImServer(() => context, {
    trackRequest: <T,>(work: Promise<T>) => work,
    fetch: async () => { throw new Error('The SDK fixture must not contact a live endpoint') },
    restGet: async (path: string) => {
      if (path.startsWith('chats?') && path.endsWith('select=kind')) return [{ kind: options.kind ?? 'group' }]
      throw new Error(`Unexpected fixture read: ${path}`)
    },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      if (name === 'chat_facts') return [{ id: body.p_chat_id, kind: options.kind ?? 'group' }]
      writes.push({ name, body })
      if (options.rejection) throw new Error(options.rejection)
      if (options.receipt !== undefined) return options.receipt
      if (name === 'set_agent_listen_mode_as') return { chat_id: body.p_chat_id, user_id: body.p_agent_user_id, listen_mode: body.p_mode }
      if (name === 'set_group_member_role_as') return { chat_id: body.p_chat_id, user_id: body.p_member_user_id, role: body.p_role }
      throw new Error(`Unexpected fixture write: ${name}`)
    },
    restPatch: async () => { throw new Error('Direct table PATCH is not the listen-mode entry') },
  })
  serveToolsList(server, () => context)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'group-listen-mode-regression', version: '1' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  cleanup.push(async () => { await client.close(); await server.close() })
  return { client, writes, call: (args: Record<string, unknown>) => client.callTool({ name: 'group_set_role', arguments: args }) }
}

describe('listen_mode through the unchanged group tool', () => {
  it('keeps the frozen group tool names and advertises the added enum without an actor parameter', async () => {
    const h = await connect()
    const { tools } = await h.client.listTools()
    const names = tools.map(tool => tool.name).filter(name => name.startsWith('group_')).sort()
    console.log(names.join('\n'))
    expect(names).toEqual(GROUP_TOOLS)
    const tool = tools.find(tool => tool.name === 'group_set_role')!
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }>
    expect(properties.listen_mode?.enum).toEqual(['active', 'passive'])
    expect(properties.actor).toBeUndefined()
    expect(properties.as_user_id).toBeUndefined()
    expect(tool.inputSchema.additionalProperties).toBe(false)
  })

  it.each(['active', 'passive'])('omits member only to set its own %s listen mode', async listen_mode => {
    const h = await connect()
    const result = await h.call({ chat_id: GROUP, listen_mode })
    expect(result.isError, text(result)).not.toBe(true)
    expect(JSON.parse(text(result))).toEqual({ chat_id: GROUP, user_id: `user:${SELF}`, listen_mode })
    expect(h.writes).toEqual([{ name: 'set_agent_listen_mode_as', body: { p_chat_id: GROUP, p_agent_user_id: SELF, p_mode: listen_mode, p_as_user_id: SELF } }])
  })

  it('resolves an explicit target while keeping the actual calling Agent as actor', async () => {
    const h = await connect()
    const result = await h.call({ chat_id: GROUP, member: `user:${TARGET}`, listen_mode: 'passive' })
    expect(result.isError, text(result)).not.toBe(true)
    expect(JSON.parse(text(result))).toMatchObject({ user_id: `user:${TARGET}`, listen_mode: 'passive' })
    expect(h.writes).toEqual([{ name: 'set_agent_listen_mode_as', body: { p_chat_id: GROUP, p_agent_user_id: TARGET, p_mode: 'passive', p_as_user_id: SELF } }])
  })

  it.each(['agent_owner_or_group_manager_required', 'group_member_not_found', 'group_actor_not_authorized'])('preserves the authoritative RPC refusal: %s', async rejection => {
    const h = await connect({ rejection })
    const result = await h.call({ chat_id: OTHER, member: `user:${TARGET}`, listen_mode: 'active' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(rejection)
    expect(h.writes.map(write => write.name)).toEqual(['set_agent_listen_mode_as'])
  })

  it.each([
    { chat_id: GROUP },
    { chat_id: GROUP, member: `user:${TARGET}` },
    { chat_id: GROUP, role: 'admin' },
    { chat_id: GROUP, member: `user:${TARGET}`, role: 'admin', listen_mode: 'passive' },
    { chat_id: GROUP, listen_mode: 'active', as_user_id: TARGET },
    { chat_id: GROUP, listen_mode: 'invalid' },
  ])('rejects invalid or absent changes without a mutation: %j', async args => {
    const h = await connect()
    const result = await h.call(args)
    expect(result.isError).toBe(true)
    expect(h.writes).toEqual([])
  })

  it('keeps the existing role call and receipt unchanged', async () => {
    const h = await connect()
    const result = await h.call({ chat_id: GROUP, member: `user:${TARGET}`, role: 'admin' })
    expect(result.isError, text(result)).not.toBe(true)
    expect(JSON.parse(text(result))).toEqual({ chat_id: GROUP, user_id: `user:${TARGET}`, role: 'admin' })
    expect(h.writes).toEqual([{ name: 'set_group_member_role_as', body: { p_chat_id: GROUP, p_member_user_id: TARGET, p_role: 'admin', p_as_user_id: SELF } }])
  })

  it.each(['dm', 'topic'])('preserves the group-only scope for %s', async kind => {
    const h = await connect({ kind })
    const result = await h.call({ chat_id: GROUP, member: `user:${TARGET}`, listen_mode: 'passive' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('chat_id must identify a group')
    expect(h.writes).toEqual([])
  })

  it('preserves side-chat refusal before mutation', async () => {
    const h = await connect({ forkOf: 'source' })
    const result = await h.call({ chat_id: GROUP, listen_mode: 'passive' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('运行时分叉')
    expect(h.writes).toEqual([])
  })

  it('requires an exact authoritative listen receipt', async () => {
    const h = await connect({ receipt: { chat_id: GROUP, user_id: TARGET, listen_mode: 'active' } })
    const result = await h.call({ chat_id: GROUP, member: `user:${TARGET}`, listen_mode: 'passive' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('database did not confirm listen_mode')
  })
})
