import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerGuguTool } from '../../../../apps/desktop/electron/mcp/register-gugu-tool.mjs'
import { currentGuguToolInvocation } from '../../../../apps/desktop/electron/mcp/tool-call-context.mjs'

// App 体检 #15:社交域与会话页各域注册工具走同一串 —— 一次调用交宿主计时一次、记在工具自己的名字下;出错是 isError。
async function connected(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 't', version: '1' })
  register(server)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 't', version: '1' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return client
}

describe('registerGuguTool', () => {
  it('carries native call identity through the real SDK and concurrent asynchronous dispatch', async () => {
    const seen: Array<string | undefined> = []
    const client = await connected(server => registerGuguTool(server, {name: 'probe', description: 'probe', schema: z.object({})}, async () => {
      const before = currentGuguToolInvocation()
      await Promise.resolve()
      seen.push(currentGuguToolInvocation())
      expect(currentGuguToolInvocation()).toBe(before)
      return {content: [{type: 'text', text: 'ok'}]}
    }, work => work))
    try {
      await Promise.all(['native-a', 'native-b'].map(id => client.callTool({name: 'probe', arguments: {}, _meta: {'claudecode/toolUseId': id}})))
      expect(seen.sort()).toEqual([JSON.stringify(['claude', 'native-a']), JSON.stringify(['claude', 'native-b'])])
      expect(currentGuguToolInvocation()).toBeUndefined()
    } finally { await client.close() }
  })

  it('times the whole call once, under the tool’s name; a thrown error is the agent’s isError', async () => {
    const timed: (string | undefined)[] = []
    const track = <T,>(work: Promise<T>, toolName?: string): Promise<T> => { timed.push(toolName); return work }
    const client = await connected((server) => registerGuguTool(server, { name: 'probe', description: 'probe', schema: z.object({ fail: z.boolean().optional() }) }, async (args) => {
      if (args.fail) throw new Error('it failed')
      return { content: [{ type: 'text', text: 'ok' }] }
    }, track))
    expect(await client.callTool({ name: 'probe', arguments: {} })).toMatchObject({ content: [{ type: 'text', text: 'ok' }] })
    expect(await client.callTool({ name: 'probe', arguments: { fail: true } })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'error: it failed' }] })
    expect(timed).toEqual(['probe', 'probe'])
  })

  it('permissive: registered wide, then the preflight and the strict schema, naming an unknown key', async () => {
    const run = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sent' }] }))
    const preflight = vi.fn((args: unknown) => { if ((args as { to?: unknown }).to !== undefined) throw new Error('use to_user_ids') })
    const client = await connected((server) => registerGuguTool(server, { name: 'w', description: 'w', schema: z.object({ text: z.string() }), permissive: true, preflight }, run, (work) => work))
    expect(await client.callTool({ name: 'w', arguments: { to: 'x' } })).toMatchObject({ isError: true, content: [{ text: 'error: use to_user_ids' }] })
    const unknown = await client.callTool({ name: 'w', arguments: { text: 'hi', extra: 1 } }) as { content: { text: string }[] }
    expect(unknown.content[0]!.text).toContain('不认识的参数 extra')
    expect(await client.callTool({ name: 'w', arguments: { text: 'hi' } })).toMatchObject({ content: [{ text: 'sent' }] })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
