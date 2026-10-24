import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.GUGU_AGENT_ID = 'agent-1'
  process.env.GUGU_ACCESS_TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'owner-1' })).toString('base64url')}.x`
})
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl, RpcHttpError, RpcTransportError } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const SESSION_CONTEXT = {
  supabaseUrl: '', anonKey: '', agentId: 'agent-1', chatId: 'c1', threadRootId: null,
  guguHome: '/tmp/gugu-im-outbox-test',
  getAccessToken: async () => process.env.GUGU_ACCESS_TOKEN || '',
}
const callTool = (name: string, args: Record<string, unknown>, deps: Record<string, unknown>) =>
  callToolImpl(SESSION_CONTEXT, name, args, deps)

const MEMBERS = ['agent-1', 'owner-1', 'member-1']

// S2b:per-turn lease/context 与 mark/clear/delivered 标记机器已退役 —— 发帖永远是稳定 id 直插
// restInsert('messages', row);restRpc 只剩 chat_facts / list_member_ids 两条读。
/** The attachments function as core's client reaches it: upload → a form → OSS; commit → the message (kept in `commits`). */
function attachmentsFake(uploads: string[], commits: Array<Record<string, unknown>>) {
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/attachments/upload')) return new Response(JSON.stringify({ staging_key: `staging/o/${uploads.length + 1}`, url: 'https://oss.test/', fields: {}, max_bytes: 25 * 1024 * 1024 }))
    if (url === 'https://oss.test/') { uploads.push(((init?.body as FormData).get('file') as File).name); return new Response(null, { status: 204 }) }
    const args = JSON.parse(String(init?.body)) as Record<string, unknown>
    commits.push(args)
    return new Response(JSON.stringify({ message: { id: args.message_id, chat_id: args.chat_id } }))
  }) as typeof globalThis.fetch
  return async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch })
}
function makeDeps(overrides: Record<string, unknown> = {}) {
  const inserted: Array<Record<string, unknown>> = []
  const rpcs: Array<[string, Record<string, unknown>]> = []
  const uploads: string[] = []
  const commits: Array<Record<string, unknown>> = []
  const deps: Record<string, unknown> = {
    restGet: async () => [],
    restPatch: async () => {},
    restInsert: async (_table: string, row: Record<string, unknown>) => { inserted.push(row) },
    restRpc: async (name: string, body: Record<string, unknown>) => {
      rpcs.push([name, body])
      // @@@5856 kind 与成员名单改走 actor-aware 的 RPC 读(话题要按调用者判可见性),
      // 所以这两条读在任何发帖路径上都会发生 —— 桩子得答,否则测的是「名单读不到」而非本意。
      if (name === 'chat_facts') return [{ id: 'c1', kind: 'group', source_chat_id: null, group_prompt: null }]
      if (name === 'list_member_ids') return MEMBERS.map((user_id) => ({ user_id, role: 'member' }))
      return null
    },
    readHostSessionToken: async () => null,
    attachmentsEndpoint: attachmentsFake(uploads, commits),
    ...overrides,
  }
  return { deps, inserted, rpcs, uploads, commits }
}

describe('#2051 command-authored message delivery (S2b: spontaneous stable-id insert)', () => {
  test('transport failure never falls back to an unfenced outbox', async () => {
    const { deps, inserted } = makeDeps({
      restInsert: async () => { throw new RpcTransportError() },
    })
    await expect(
      callTool('message_send', { chat_id: 'c1', text: 'not queued' }, deps),
    ).rejects.toThrow(/transport failed/)
    expect(inserted).toEqual([])
    expect('enqueueOutbox' in deps).toBe(false)
  })

  // 旧「有界 5xx 重试 + 失败标记」住在 lease post helper 里,随 S2b 一起退役:
  // 直插失败就当轮 fail loud,一次尝试;补投靠调用方重试 + messages_client_dedup 的稳定幂等键。
  test('HTTP 5xx from the durable insert fails the turn loud — single attempt, no queueing', async () => {
    let attempts = 0
    const { deps } = makeDeps({
      restInsert: async () => {
        attempts += 1
        throw new RpcHttpError(500)
      },
    })
    await expect(
      callTool('message_send', { chat_id: 'c1', text: 'retry exhausted' }, deps),
    ).rejects.toThrow(/500/)
    expect(attempts).toBe(1)
  })

  // '%s output requires exact agent context before any durable message write' (message + file) 已删 ——
  // S2051 guard retired with the per-turn lease (S2b pull flip):发帖不再读 command context。
  // 'lost response retries the same stable message row and clears the failure marker' 已删 ——
  // transport 补投与 delivered 标记随 lease post helper 退役;重放 = 调用方重试同一稳定
  // client_message_id,由 messages_client_dedup 逐字段幂等去重(该键仍由下方用例锁住)。

  test('business validation failure remains explicit and is not queued', async () => {
    const { deps, inserted } = makeDeps({
      restGet: async (path: string) => path.includes('chat_members') ? [{ user_id: 'agent-1' }] : [],
    })
    await expect(
      callTool('message_send', { chat_id: 'c1', text: 'hi', to_user_ids: ['user:ghost'] }, deps),
    ).rejects.toThrow(/收件人不在本 chat/)
    expect(inserted).toEqual([])
  })

  // #5828：文件走 file_path，服务端自己读盘，测试造真文件。
  const proofPath = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'gugu-outbox-'))
    const full = join(dir, 'proof.txt')
    writeFileSync(full, 'proof')
    return full
  })()
  // #4191:gugu_widget 已裁撤,widget 行随之删除;file 走 message_send_file。
  test.each([
    ['message', 'message_send', { chat_id: 'c1', text: 'message', to_user_ids: ['user:ghost'] }],
    ['file', 'message_send_file', {
      chat_id: 'c1',
      file_name: 'proof.txt',
      file_path: proofPath,
      mime_type: 'text/plain',
      to_user_ids: ['user:ghost'],
    }],
  ])('%s output rejects non-member authority before durable or storage writes', async (_label, tool, args) => {
    const { deps, inserted, uploads, commits } = makeDeps({
      restGet: async (path: string) => path.includes('chat_members') ? [{ user_id: 'agent-1' }] : [],
    })
    await expect(callTool(tool, args, deps)).rejects.toThrow(/不在本 chat/)
    expect(inserted).toEqual([])
    expect(uploads).toEqual([])
    expect(commits).toEqual([])
  })

  test('member file output still uploads and posts exactly once (#7290: one commit, its stable message id)', async () => {
    const { deps, inserted, uploads, commits } = makeDeps({
      restGet: async (path: string) => path.includes('chat_members')
        ? [{ user_id: 'agent-1' }, { user_id: 'member-1' }]
        : [],
    })
    const receipt = JSON.parse(await callTool('message_send_file', {
      chat_id: 'c1',
      file_name: 'proof.txt',
      file_path: proofPath,
      mime_type: 'text/plain',
      to_user_ids: ['user:member-1'],
    }, deps))
    expect(receipt).toMatchObject({ status: 'sent', file_name: 'proof.txt' })
    expect(uploads).toHaveLength(1)
    expect(inserted, 'the message is the commit\'s, not a direct insert').toHaveLength(0)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({ chat_id: 'c1', sender_user_id: 'agent-1', to_user_ids: ['member-1'], file_name: 'proof.txt', content_type: 'text/plain' })
    expect(String(commits[0]!.message_id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(receipt.source_link).toBe(`gugu-chat://c1/${commits[0]!.message_id}`)
  })

  test.each([403, 409, 422])('DB HTTP %s from the durable insert is semantic/terminal — fails loud, single attempt', async (status) => {
    let attempts = 0
    const { deps } = makeDeps({
      restInsert: async () => {
        attempts += 1
        throw new RpcHttpError(status)
      },
    })
    await expect(
      callTool('message_send', { chat_id: 'c1', text: 'blocked' }, deps),
    ).rejects.toThrow(String(status))
    expect(attempts).toBe(1)
  })

  // 'wrong RPC row id is a semantic failure' 已删 —— 发帖不再经 RPC 往返 row id
  // (restInsert 用 Prefer: return=minimal,没有可判错的返回 id)。
})
