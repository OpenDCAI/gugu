// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.GUGU_AGENT_ID = 'agent-1'
  process.env.GUGU_ACCESS_TOKEN = 'TOKEN'
})
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

// gugu-dev#181 防刷屏:同一个 agent 在同一个群(话题)里,人最后一次说话之后发得太密,message_send 的回执后面提醒一句,不拦。
const CONTEXT = { supabaseUrl: '', anonKey: '', agentId: 'agent-1', threadRootId: null, guguHome: '/tmp/gugu-im-flood-test' }
const USERS = [
  { id: 'agent-1', display_name: 'Claude 1', type: 'agent' },
  { id: 'agent-2', display_name: 'Claude 2', type: 'agent' },
  { id: 'owner-1', display_name: 'Owner', type: 'human' },
  { id: '77777777-7777-4777-8777-777777777777', display_name: 'Friend', type: 'human' },
]

/** 最近的在前(与 order=seq.desc 一致):每一项是 [发送者, 几秒前]。 */
function history(...runs: Array<[sender: string, count: number, everySeconds: number]>) {
  const rows: Array<{ sender_user_id: string; created_at: string }> = []
  let ago = 0
  for (const [sender, count, every] of runs) {
    for (let i = 0; i < count; i += 1) {
      rows.push({ sender_user_id: sender, created_at: new Date(Date.now() - ago * 1000).toISOString() })
      ago += every
    }
  }
  return rows
}

function send(opts: { kind?: string; rows?: unknown[]; messagesError?: Error; args?: Record<string, unknown>; tool?: string }) {
  const reads: string[] = []
  const inserted: unknown[] = []
  const deps = {
    restGet: async (path: string) => {
      reads.push(path)
      if (path.startsWith('messages?')) {
        if (opts.messagesError) throw opts.messagesError
        return opts.rows ?? []
      }
      if (path.startsWith('users?')) return USERS.filter((user) => path.includes(user.id))
      return []
    },
    restPatch: async () => {},
    restInsert: async (_table: string, row: unknown) => { inserted.push(row) },
    restRpc: async (name: string) => {
      if (name === 'chat_facts') return [{ id: 'c1', kind: opts.kind ?? 'group', source_chat_id: null, group_prompt: null }]
      if (name === 'list_member_ids') return USERS.map((user) => ({ user_id: user.id, role: 'member' }))
      if (name === 'request_agent_friend_contact') return [{ chat_id: 'c1', name: 'Friends', created: false, status: 'already_member' }]
      return null
    },
    storageUpload: async () => {},
    storagePublicUrl: (_bucket: string, path: string) => `https://storage.test/${path}`,
    storageRemove: async () => {},
  }
  const result = callToolImpl({ ...CONTEXT, getAccessToken: async () => 'TOKEN' }, opts.tool ?? 'message_send',
    opts.args ?? { chat_id: 'c1', text: 'hello' }, deps) as Promise<string>
  return result.then((text) => ({ text, reads, inserted }))
}

describe('gugu-dev#181 message_send flood notice', () => {
  test('8 messages within a minute stay under the line: plain receipt', async () => {
    const { text } = await send({ rows: history(['agent-1', 8, 5]) })
    expect(text).toMatch(/^sent \(id=[^)]+\)$/)
  })

  test('the 9th message within a minute gets a notice, and is still sent', async () => {
    const { text, inserted } = await send({ rows: history(['agent-1', 9, 5]) })
    expect(inserted).toHaveLength(1)
    expect(text).toMatch(/^sent \(id=[^)]+\)\n提醒:你在这个群里 1 分钟内已发 9 条,其间没有人发言。/)
  })

  test('13 messages spread over five minutes trip the 5-minute line', async () => {
    const { text } = await send({ rows: history(['agent-1', 13, 20]) })
    expect(text).toContain('5 分钟内已发 13 条')
  })

  test('31 messages within an hour trip the 1-hour line', async () => {
    const { text } = await send({ rows: history(['agent-1', 31, 100]) })
    expect(text).toContain('1 小时内已发 31 条')
  })

  test('a human message restarts the count; other agents do not', async () => {
    const reset = await send({ rows: history(['agent-1', 5, 2], ['owner-1', 1, 2], ['agent-1', 10, 2]) })
    expect(reset.text).toMatch(/^sent \(id=[^)]+\)$/)
    const agents = await send({ rows: history(['agent-1', 5, 2], ['agent-2', 1, 2], ['agent-1', 10, 2]) })
    expect(agents.text).toContain('1 分钟内已发 15 条')
  })

  test('a topic is counted on its own chat and named as a topic', async () => {
    const { text, reads } = await send({ kind: 'topic', rows: history(['agent-1', 9, 5]) })
    expect(text).toContain('你在这个话题里 1 分钟内已发 9 条')
    expect(reads.some((path) => path.startsWith('messages?chat_id=eq.c1&'))).toBe(true)
  })

  test('a failed frequency read is said plainly and never fails the send', async () => {
    const { text, inserted } = await send({ rows: [], messagesError: new Error('HTTP 503') })
    expect(inserted).toHaveLength(1)
    expect(text).toMatch(/^sent \(id=[^)]+\)\n这条已发出;发送频率没读到\(HTTP 503\),不用重发。$/)
  })

  test('a DM is not counted', async () => {
    const { text, reads } = await send({ kind: 'dm', rows: history(['agent-1', 20, 1]) })
    expect(text).toMatch(/^sent \(id=[^)]+\)$/)
    expect(reads.some((path) => path.startsWith('messages?'))).toBe(false)
  })

  test('contact_friend keeps its JSON receipt', async () => {
    const { text } = await send({
      tool: 'contact_friend',
      args: { friend_user_id: 'user:77777777-7777-4777-8777-777777777777', text: 'hello' },
      rows: history(['agent-1', 20, 1]),
    })
    expect(JSON.parse(text)).toMatchObject({ chat_id: 'c1', created: false })
  })
})
