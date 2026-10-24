import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, test, vi } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { groupRulesVersion, memoryGroupRulesLedger } from '../../../../packages/core/src/local/agent/groupRulesDelivery'
import { registerGuguExtensionTools } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { registerGuguSessionTools, SESSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'
vi.hoisted(() => {
  process.env.GUGU_AGENT_ID = 'agent-1'
  process.env.GUGU_ACCESS_TOKEN = `x.${Buffer.from(JSON.stringify({ sub: 'owner-1' })).toString('base64url')}.x`
})
// @ts-expect-error — 注入式 MCP server 是无类型 .mjs；运行时 import 可用。
import { assertAgentMessageText, createGuguImServer as createGuguImServerImpl, callTool as callToolImpl, reconcileMentionExpression, resolveRecipientAddresses, restRpc as restRpcImpl, sendExtensionCardOf, groupDataFileOf, workspaceFileLink, TOOL_DEFS, IN_LIST_BATCH, serveToolsList } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'
import {
  dollarRunBoundaryFixtures,
  markdownStructureBoundaryFixtures,
} from '../lib/markdownMathDelimiterRunFixtures'
type Call = unknown[]
// 工作区条目 id 是 uuid(库里按主键查,文件服务的 /:id 也拿它拼),桩也用真 uuid。
const W_DOC = '0d000000-0000-4000-8000-000000000001'
const W_FILE = '0d000000-0000-4000-8000-000000000002'
const W_OTHER = '0d000000-0000-4000-8000-000000000003'
const W_NEW = '0d000000-0000-4000-8000-000000000004'
const TEST_CONTEXT = {
  supabaseUrl: '',
  anonKey: '',
  agentId: 'agent-1',
  threadRootId: null,
  guguHome: '/tmp/gugu-im-test',
  getAccessToken: async () => process.env.GUGU_ACCESS_TOKEN || '',
}
function splitTestDeps(deps: Record<string, unknown> = {}) {
  const { callSessionHost, ...injected } = deps
  const context = typeof callSessionHost === 'function'
    ? { ...TEST_CONTEXT, runHostAction: (action: object) => callSessionHost(action) }
    : TEST_CONTEXT
  return { context, injected }
}
function callTool(name: string, args: Record<string, unknown>, deps: Record<string, unknown> = {}) {
  const value = splitTestDeps(deps)
  return callToolImpl(value.context, name, args, value.injected)
}
// 宿主的计时(trackRequest)是必填的:测试里照产品同样传一个,只是不计。
const passThrough = <T,>(work: Promise<T>): Promise<T> => work
// tools/list 由组装 server 的宿主装(acp-engine-utils),这里照产品同样装一次。
function createGuguImServer(deps: Record<string, unknown> = {}) {
  const value = splitTestDeps(deps)
  const server = createGuguImServerImpl(() => value.context, { trackRequest: passThrough, ...value.injected })
  serveToolsList(server, () => value.context)
  return server
}
function restRpc(name: string, body: Record<string, unknown>, profile?: string) {
  return restRpcImpl(TEST_CONTEXT, name, body, profile)
}
// #5828：文件走 file_path，服务端自己读盘，所以测试要造真文件而不是编码串。
const fixtureRoot = mkdtempSync(join(tmpdir(), 'gugu-upload-'))
let fixtureSeq = 0
function fixtureFile(name: string, bytes: Buffer | string = 'gugu'): string {
  const dir = mkdtempSync(join(fixtureRoot, `f${fixtureSeq++}-`))
  const full = join(dir, name)
  writeFileSync(full, bytes)
  return full
}
function sparseFixture(name: string, size: number): string {
  const full = fixtureFile(name, '')
  truncateSync(full, size)
  return full
}

function harness(members: string[] = [], groupPrompt: string | null = null) {
  let currentGroupPrompt = groupPrompt
  const workspaceRows: Array<Record<string, unknown>> = [
    {
      id: W_DOC,
      chat_id: 'c1',
      kind: 'document',
      filename: 'brief.md',
      content_type: 'text/markdown',
      size_bytes: 5,
      pointer: null,
      inline_text: 'hello',
      source_message_ids: ['msg:m1'],
      created_by: 'owner-1',
      version: 1,
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
    },
    {
      id: W_FILE,
      chat_id: 'c1',
      kind: 'file',
      filename: 'deck.pdf',
      content_type: 'application/pdf',
      size_bytes: 123,
      pointer: 'c1/owner-1/uuid-deck.pdf',
      inline_text: null,
      source_message_ids: [],
      created_by: 'owner-1',
      version: 1,
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
    },
    {
      id: W_OTHER,
      chat_id: 'c2',
      kind: 'document',
      filename: 'other.md',
      content_type: 'text/markdown',
      size_bytes: 5,
      pointer: null,
      inline_text: 'other',
      source_message_ids: [],
      created_by: 'owner-1',
      version: 1,
      created_at: '2026-06-18T00:00:00.000Z',
      updated_at: '2026-06-18T00:00:00.000Z',
    },
  ]
  const calls: { inserts: Call[]; patches: Call[]; uploads: Call[]; signed: Call[]; removes: Call[]; rpcs: Call[]; openFiles: Call[] } = {
    inserts: [],
    patches: [],
    uploads: [],
    signed: [],
    removes: [],
    rpcs: [],
    openFiles: [],
  }
  let commitError: Error | null = null
  // 回答丢了(服务端已经发出去,回答没到):前 n 次 commit 照样记下那条消息,再抛网络错。
  let lostAnswers = 0
  const commitBodies: Array<Record<string, unknown>> = []
  let staged = 0
  const stagedBytes = new Map<string, Uint8Array>()
  const attachmentsFetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/functions/v1/attachments/upload')) {
      staged += 1
      const key = `staging/owner-1/00000000-0000-4000-8000-${String(staged).padStart(12, '0')}`
      return new Response(JSON.stringify({ staging_key: key, url: 'https://oss.test/', fields: { key }, max_bytes: 25 * 1024 * 1024 }))
    }
    if (url === 'https://oss.test/') {
      const form = init?.body as FormData
      const file = form.get('file') as File
      const bytes = new Uint8Array(await file.arrayBuffer())
      stagedBytes.set(String(form.get('key')), bytes)
      calls.uploads.push(['oss', String(form.get('key')), file.type, Buffer.from(bytes)])
      return new Response(null, { status: 204 })
    }
    if (url.endsWith('/functions/v1/attachments/commit')) {
      const args = JSON.parse(String(init?.body)) as Record<string, unknown>
      commitBodies.push(args)
      if (commitError) return new Response(JSON.stringify({ error: 'denied', message: commitError.message }), { status: 403 })
      const bytes = stagedBytes.get(String(args.staging_key)) ?? new Uint8Array()
      const type = String(args.content_type)
      const row = {
        id: args.message_id, chat_id: args.chat_id, sender_user_id: args.sender_user_id, to_user_ids: args.to_user_ids, thread_root_id: args.thread_root_id ?? null,
        content: `[附件] ${String(args.file_name)} (${type})\n[Size] ${bytes.length}\n[Kind] ${type.startsWith('image/') ? 'image' : 'file'}`,
        content_type: 'attachment', file_item_id: `item:${String(args.staging_key)}`, file_version: 1, file_blob_id: null,
      }
      // 服务端按消息 id 幂等:同一条重放,回同一行,不再多一条。
      if (!calls.inserts.some(([, existing]) => (existing as Record<string, unknown>).id === row.id)) calls.inserts.push(['messages', row])
      if (lostAnswers > 0) { lostAnswers -= 1; throw new TypeError('fetch failed') }
      return new Response(JSON.stringify({ message: row }))
    }
    return new Response(JSON.stringify({ error: 'invalid', message: `no fake for ${url}` }), { status: 404 })
  }) as typeof fetch

  const deps = {
    // 显式返回类型:用例里会整体替换 restGet,返回形状各不相同(#6492 去掉 workspace 行之后推断出的联合太窄)。
    restGet: async (path: string): Promise<Array<Record<string, unknown>>> => {
      if (path.includes('chat_members') && path.includes('user_id=eq.')) return [{ chat_id: 'c1', last_read_seq: 0 }]
      if (path.includes('chat_members')) return members.map((user_id) => ({ user_id, role: 'member', listen_mode: 'active' }))
      if (path.includes('chats?id=in')) return [{ id: 'c1', name: 'Group', kind: 'group', status: 'active' }]
      if (path.includes('chats?id=eq')) {
        const id = path.match(/chats\?id=eq\.([^&]+)/)?.[1] ?? 'c1'
        return [{ id, name: 'Group', kind: 'group', group_prompt: currentGroupPrompt }]
      }
      if (path.includes('users?id=eq')) return [{ gugu_number: 42, display_name: 'Agent', avatar: null, bio: null }]
      if (path.includes('messages_view')) return [{ id: 'm1', seq: 7, content: 'hello', content_type: 'text' }]
      return []
    },
    restInsert: async (table: string, row: Record<string, unknown>) => { calls.inserts.push([table, row]) },
    restPatch: async (path: string, body: Record<string, unknown>) => { calls.patches.push([path, body]) },
    restRpc: async (name: string, body: Record<string, unknown>, _profile?: string): Promise<unknown> => {
      calls.rpcs.push([name, body])
      // @@@5856 chat 的基本事实与成员名单改走**按 actor** 的 DEFINER RPC(MCP 用主人的 JWT,
      // 直连 REST 时 agent 在「主人不在的线」上开的话题一行都读不到)。桩照着服务端的形状答。
      if (name === 'chat_facts') {
        const id = String(body.p_chat_id ?? 'c1')
        return [{ id, name: 'Group', kind: 'group', source_chat_id: null, group_prompt: currentGroupPrompt }]
      }
      if (name === 'list_my_chats_as') {
        return [{ chat_id: 'c1', public_id: 101, kind: 'group', status: 'active', name: 'Group', role: 'member', listen_mode: 'active', last_message_at: null, last_message_preview: null }]
      }
      if (name === 'list_member_ids') {
        return members.map((user_id) => ({ user_id, role: 'member', listen_mode: 'active' }))
      }
      // #6492 workspace 走 *_as RPC:桩照服务端的形状答(按 p_as_user_id 判,created_by 写 agent 自己)。
      if (name === 'workspace_status_as') {
        const rows = workspaceRows.filter((row) => row.chat_id === body.p_chat_id)
        return [{
          total: rows.length,
          documents: rows.filter((row) => row.kind === 'document').length,
          files: rows.filter((row) => row.kind === 'file').length,
        }]
      }
      if (name === 'workspace_list_as') {
        // 照库里的形状答:筛选、排好序、按 offset/limit 切,只回元数据,每行带筛选后的总数。
        const needle = typeof body.p_name === 'string' ? body.p_name.toLowerCase() : ''
        const matched = workspaceRows.filter((row) => row.chat_id === body.p_chat_id
          && (!body.p_kind || row.kind === body.p_kind)
          && (!needle || (body.p_exact === true ? String(row.filename).toLowerCase() === needle : String(row.filename).toLowerCase().includes(needle))))
        const offset = Number(body.p_offset ?? 0)
        const page = body.p_limit == null ? matched.slice(offset) : matched.slice(offset, offset + Number(body.p_limit))
        return page.map(({ inline_text: _text, ...meta }) => ({ ...meta, total: matched.length }))
      }
      if (name === 'workspace_get_as' || name === 'workspace_delete_as') {
        const row = workspaceRows.find((item) => item.id === body.p_item_id)
        if (!row) throw new Error(`command RPC HTTP 400: workspace item not found: ${String(body.p_item_id)}`)
        return [row]
      }
      if (name === 'workspace_create_document_as' || name === 'workspace_create_file_as') {
        const file = name === 'workspace_create_file_as'
        return [{
          ...workspaceRows[0],
          id: W_NEW,
          chat_id: body.p_chat_id,
          kind: file ? 'file' : 'document',
          filename: file ? body.p_filename : body.p_title,
          pointer: file ? body.p_pointer : null,
          inline_text: file ? null : body.p_content,
          created_by: body.p_as_user_id,
          version: 1,
        }]
      }
      return []
    },
    // #7290 gugu-3:附件经 attachments 函数(core 的客户端)—— upload 给表单、表单传到 OSS、commit 发消息。uploads 记成
    // [桶, 暂存键, 类型, 字节](第 4 位是真正传上去的字节,#5828);commit 记进 inserts,正文照服务端那样由信封生成。
    attachmentsEndpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'anon', token: 'token', fetch: attachmentsFetch }),
    // 新式附件的签名链接:条目指回它那次上传的字节。
    attachmentUrls: async (refs: Array<{ item_id?: string; version?: number; message_id?: string }>) => ({
      urls: refs.map((ref) => ({ ...ref, message_id: ref.message_id ?? null, url: `https://oss.test/${String(ref.item_id).slice('item:'.length)}`, thumb_url: null, sha256: null, width: null, height: null, expires_at: '2999-01-01T00:00:00Z' })),
    }),
  }
  return {
    setGroupPrompt: (v: string | null) => { currentGroupPrompt = v }, failCommit: (error: Error) => { commitError = error }, loseCommitAnswers: (n: number) => { lostAnswers = n }, commitBodies, deps, calls }
}
async function connect(deps: Record<string, unknown>): Promise<Client> {
  const server = createGuguImServer(deps)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1.0.0' })
  await Promise.all([server.connect(st), client.connect(ct)])
  return client
}
function text(r: unknown): string {
  const c = (r as { content?: Array<{ text?: string }> }).content
  return c?.[0]?.text ?? ''
}
// @@@5856 chat_facts / list_member_ids / list_my_chats_as 是**读**,不是写:kind、成员名单与「我所在的会话」统一走
// SECURITY DEFINER RPC(带 p_as_user_id,见 chatFactsOf 的注释),所以「没有写 RPC」这类断言要把这些读排除掉。
function writeRpcs(rpcs: ReadonlyArray<readonly unknown[]>): unknown[][] {
  return rpcs.filter(([name]) => !['chat_facts', 'list_member_ids', 'list_my_chats_as'].includes(String(name))) as unknown[][]
}
function toolRequiresChatId(schema: Record<string, unknown> | null | undefined): boolean {
  if (!schema) return false
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  return Array.isArray(schema.required) && schema.required.includes('chat_id') && properties?.chat_id !== undefined
}
describe('the gugu MCP server requires an explicit chat target', () => {
  // @@@5856 名单改走按 actor 的 list_member_ids(裸读 chat_members 用的是主人的 JWT,agent 在
  // 「主人不在的那条线」上一行都读不到),所以「目标只来自 args」这条判据现在看 RPC 的 p_chat_id。
  async function membersTarget(explicitChatId: string) {
    const restGet = vi.fn(async (_path: string) => [])
    const restRpc = vi.fn(async (_name: string, _body: Record<string, unknown>) => [])
    await callTool('message_members', { chat_id: explicitChatId }, { restGet, restRpc })
    expect(restRpc).toHaveBeenCalledTimes(1)
    expect(restRpc.mock.calls[0][0]).toBe('list_member_ids')
    return String((restRpc.mock.calls[0][1] as Record<string, unknown>).p_chat_id)
  }
  test('explicit args.chat_id is the only target input', async () => {
    expect(await membersTarget('explicit-chat')).toBe('explicit-chat')
  })
  test('missing chat_id fails before reads and never consults session or turn state', async () => {
    const restGet = vi.fn(async (_path: string) => [])
    const restRpc = vi.fn(async (_name: string, _body: Record<string, unknown>) => [])
    await expect(callTool('message_members', {}, { restGet, restRpc }))
      .rejects.toThrow('chat_id is required; the gugu MCP server never infers a conversation target')
    expect(restGet).not.toHaveBeenCalled()
    expect(restRpc).not.toHaveBeenCalled()
  })
  test('explicit public_id resolves to the conversation UUID at the tool boundary', async () => {
    const restGet = vi.fn(async (path: string) => {
      if (path === 'chats?public_id=eq.211983&select=id,public_id') {
        return [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', public_id: 211983 }]
      }
      return []
    })
    const restRpc = vi.fn(async (_name: string, _body: Record<string, unknown>) => [])
    await callTool('message_members', { chat_id: '211983' }, { restGet, restRpc })
    expect(restGet).toHaveBeenNthCalledWith(1, 'chats?public_id=eq.211983&select=id,public_id')
    expect(restRpc).toHaveBeenNthCalledWith(1, 'list_member_ids', {
      p_chat_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      p_as_user_id: 'agent-1',
    })
  })
  test('lookup resolves a Gugu number through search_users and answers with a typed user: id', async () => {
    const bob = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const restRpc = vi.fn(async (name: string) => (name === 'search_users'
      ? [{ id: bob, display_name: 'Bob', type: 'human', gugu_number: 157330, agent_public: null }]
      : []))
    const restGet = vi.fn(async (path: string) => (path.startsWith('friendships?')
      ? [{ user_a_id: 'owner-1', user_b_id: bob }]
      : []))
    const out = await callTool('profile_lookup', { gugu_number: 157330 }, { restRpc, restGet })
    expect(restRpc).toHaveBeenCalledWith('search_users', { p_query: '157330' }, 'identity')
    expect(restGet).toHaveBeenCalledWith(`friendships?or=(user_a_id.eq.${bob},user_b_id.eq.${bob})&select=user_a_id,user_b_id`, 'identity')
    expect(JSON.parse(String(out))).toEqual({
      user_id: `user:${bob}`,
      display_name: 'Bob',
      type: 'human',
      gugu_number: 157330,
      agent_public: null,
      is_owner_contact: true,
    })
  })
  test('lookup of a number nobody visible holds fails loud instead of guessing', async () => {
    const restRpc = vi.fn(async () => [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', display_name: 'Almost', type: 'agent', gugu_number: 1573301, agent_public: true }])
    const restGet = vi.fn(async () => [])
    await expect(callTool('profile_lookup', { gugu_number: 157330 }, { restRpc, restGet }))
      .rejects.toThrow('no person or public agent with Gugu number 157330 is visible to you')
    expect(restGet).toHaveBeenCalledWith('users?id=eq.owner-1&gugu_number=eq.157330&select=id,display_name,type,gugu_number,agent_public', 'identity')
  })
  test('chat_id schema points agents at the delivery envelope chat', () => {
    const message = TOOL_DEFS.find((tool: { name: string }) => tool.name === 'message_send')
    expect(message?.schema?.shape?.chat_id?.description).toContain('chat= value from your gugu_delivery envelope')
    expect(message?.schema?.shape?.chat_id?.description).toContain('public_id')
    expect(message?.schema?.shape?.chat_id?.description).not.toContain('exposes conversation ids')
  })
  test('chat-scoped tools require chat_id', () => {
    const cases = [
      ['message_send', { text: 'x' }],
      ['message_send', { text: 'x', reply_to_message_id: 'msg:m1' }],
      ['message_history', {}],
      ['message_search', { query: 'x' }],
      ['message_members', {}],
      ['message_rules', {}],
    ] as const
    for (const [toolName, args] of cases) {
      const tool = TOOL_DEFS.find((candidate: { name: string }) => candidate.name === toolName)
      expect(tool?.schema.safeParse(args).success, `${toolName} accepted missing chat_id`).toBe(false)
      expect(tool?.schema.safeParse({ ...args, chat_id: 'c1' }).success, `${toolName} rejected explicit chat_id`).toBe(true)
    }
  })
  test('chat_id schema rejects empty and whitespace values for every chat tool', () => {
    const cases = [
      ['message_send', { text: 'x' }],
      ['message_send', { text: 'x', reply_to_message_id: 'msg:m1' }],
      ['message_history', {}],
      ['message_search', { query: 'x' }],
    ] as const
    for (const [toolName, args] of cases) {
      const tool = TOOL_DEFS.find((candidate: { name: string }) => candidate.name === toolName)
      expect(tool, `${toolName} schema is available`).toBeTruthy()
      for (const chatId of ['', '   ', '\t']) {
        expect(
          tool?.schema.safeParse({ ...args, chat_id: chatId }).success,
          `${toolName} schema accepted chat_id=${JSON.stringify(chatId)}`,
        ).toBe(false)
      }
      for (const chatId of ['c1', '211983']) {
        expect(
          tool?.schema.safeParse({ ...args, chat_id: chatId }).success,
          `${toolName} schema rejected chat_id=${chatId}`,
        ).toBe(true)
      }
    }
  })
  test('chat actions reject empty and whitespace chat_id through MCP before backend effects', async () => {
    const h = harness(['alice'])
    const restGet = vi.fn(h.deps.restGet)
    h.deps.restGet = restGet
    const client = await connect(h.deps)
    const cases = [
      ['message_send', { text: 'x' }],
      ['message_send', { text: 'x', reply_to_message_id: 'msg:m1' }],
      ['message_history', {}],
      ['message_search', { query: 'x' }],
    ] as const
    for (const chatId of ['', '   ', '\t']) {
      for (const [toolName, args] of cases) {
        const result = await client.callTool({ name: toolName, arguments: { ...args, chat_id: chatId } })
        expect(result.isError, `${toolName} accepted chat_id=${JSON.stringify(chatId)}`).toBe(true)
      }
    }
    expect(restGet).not.toHaveBeenCalled()
    expect(h.calls.inserts).toHaveLength(0)
    expect(h.calls.rpcs).toHaveLength(0)
    await client.close()
  })
  test('missing chat diagnostics only name real resolution inputs', async () => {
    const modulePath = fileURLToPath(new URL('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs', import.meta.url))
    function environmentVariableContract(sourceText: string) {
      const source = ts.createSourceFile(modulePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const readEnvironmentVariables = new Set<string>()
      const mentionedEnvironmentVariables = new Set<string>()
      const isWriteOnlyTarget = (node: ts.Node): boolean => {
        let current = node
        while (current.parent) {
          const parent = current.parent
          if (
            ts.isBinaryExpression(parent)
            && parent.left === current
            && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ) return true
          if (ts.isDeleteExpression(parent) && parent.expression === current) return true
          if (
            (ts.isParenthesizedExpression(parent) && parent.expression === current)
            || (ts.isArrayLiteralExpression(parent) && parent.elements.includes(current as ts.Expression))
            || (ts.isObjectLiteralExpression(parent) && parent.properties.includes(current as ts.ObjectLiteralElementLike))
            || (ts.isPropertyAssignment(parent) && parent.initializer === current)
            || (ts.isSpreadElement(parent) && parent.expression === current)
            || (ts.isSpreadAssignment(parent) && parent.expression === current)
          ) {
            current = parent
            continue
          }
          return false
        }
        return false
      }
      const visit = (node: ts.Node): void => {
        const environmentVariable = (
          ts.isPropertyAccessExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'process'
          && node.expression.name.text === 'env'
        ) ? node.name.text : (
          ts.isElementAccessExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && ts.isIdentifier(node.expression.expression)
          && node.expression.expression.text === 'process'
          && node.expression.name.text === 'env'
          && ts.isStringLiteral(node.argumentExpression)
        ) ? node.argumentExpression.text : null
        if (environmentVariable && !isWriteOnlyTarget(node)) readEnvironmentVariables.add(environmentVariable)
        if (
          ts.isNewExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === 'Error'
        ) {
          for (const argument of node.arguments ?? []) {
            for (const match of argument.getText(source).matchAll(/\bGUGU_[A-Z0-9_]+\b/g)) {
              mentionedEnvironmentVariables.add(match[0])
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      return { mentionedEnvironmentVariables, readEnvironmentVariables }
    }
    const actual = environmentVariableContract(readFileSync(modulePath, 'utf8'))
    expect([...actual.mentionedEnvironmentVariables].sort()).toEqual(
      [...actual.mentionedEnvironmentVariables].filter((name) => actual.readEnvironmentVariables.has(name)).sort(),
    )
    const writeOnly = environmentVariableContract(
      `
        process.env.GUGU_WRITE_ONLY = 'x'
        ;[process.env.GUGU_ARRAY_WRITE] = ['x']
        ;({ value: process.env.GUGU_OBJECT_WRITE } = { value: 'x' })
        delete process.env.GUGU_DELETED
        throw new Error('set GUGU_WRITE_ONLY, GUGU_ARRAY_WRITE, GUGU_OBJECT_WRITE, or GUGU_DELETED')
      `,
    )
    expect([...writeOnly.readEnvironmentVariables]).toEqual([])
    expect([...writeOnly.mentionedEnvironmentVariables].sort()).toEqual([
      'GUGU_ARRAY_WRITE',
      'GUGU_DELETED',
      'GUGU_OBJECT_WRITE',
      'GUGU_WRITE_ONLY',
    ])
    const realRead = environmentVariableContract(
      `process.env.GUGU_READ_WRITE += 'x'; const value = process.env.GUGU_READ; throw new Error('set GUGU_READ or GUGU_READ_WRITE')`,
    )
    expect([...realRead.readEnvironmentVariables].sort()).toEqual(['GUGU_READ', 'GUGU_READ_WRITE'])
    const contextWithoutChat = TEST_CONTEXT
    const injected = {
      restGet: vi.fn(async () => []),
      restRpc: vi.fn(async (name: string) => (name === 'chat_facts' ? [{ kind: 'group' }] : [])),
    }
    await expect(callToolImpl(contextWithoutChat, 'message_members', {}, injected))
      .rejects.toThrow('chat_id is required; the gugu MCP server never infers a conversation target')
    expect(injected.restGet).not.toHaveBeenCalled()
  })
})
describe('gugu 原子工具 MCP server（#1060 SDK 迁移 → #4191 原子化）', () => {
  test('grant abort reaches an in-flight backend fetch', async () => {
    const grant = new AbortController()
    let started!: () => void
    const fetchStarted = new Promise<void>((resolve) => { started = resolve })
    let fetchSignal: AbortSignal | undefined
    const client = await connect({
      signal: grant.signal,
      fetch: async (_input: unknown, init?: RequestInit) => {
        fetchSignal = init?.signal ?? undefined
        started()
        return new Promise<Response>((_, reject) => fetchSignal?.addEventListener(
          'abort', () => reject(fetchSignal?.reason), { once: true },
        ))
      },
    })
    const calling = client.callTool({ name: 'profile_whoami', arguments: {} })
    await fetchStarted
    grant.abort()
    const result = await calling
    expect(fetchSignal?.aborted).toBe(true)
    expect(result.isError).toBe(true)
    await client.close()
  })
  test('#4562 calling the retired message_send_local is an unknown-tool error, loudly', async () => {
    const client = await connect(harness().deps)
    const callText = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const outcome = await client
        .callTool({ name, arguments: args })
        .then((result) => ({ kind: 'result' as const, result }), (error) => ({ kind: 'error' as const, error }))
      if (outcome.kind === 'error') {
        return outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      }
      expect((outcome.result as { isError?: boolean }).isError, `${name} 应当失败`).toBe(true)
      return text(outcome.result)
    }
    const retired = await callText('message_send_local', { to_user_ids: ['user:x'], text: 'hi' })
    console.log('[#4562] retired-tool verbatim error:', retired)
    expect(retired).toMatch(/not found|unknown tool/i)
    expect(retired).toContain('message_send_local')
    const retiredBadArgs = await callText('message_send_local', { nonsense: 42 })
    console.log('[#4562] retired-tool with bad args:', retiredBadArgs)
    expect(retiredBadArgs).toMatch(/not found|unknown tool/i)
    expect(retiredBadArgs).toContain('message_send_local')
    // message_reply 并入 message_send(回复 = 带 reply_to_message_id 的一次发送):旧名同样是响亮的未知工具。
    const retiredReply = await callText('message_reply', { chat_id: 'c1', text: 'hi', reply_to_message_id: 'msg:m1' })
    expect(retiredReply).toMatch(/not found|unknown tool/i)
    expect(retiredReply).toContain('message_reply')
    const liveBadArgs = await callText('message_send', { nonsense: 42 })
    console.log('[#4562] live-tool with bad args:', liveBadArgs)
    expect(liveBadArgs).not.toMatch(/not found|unknown tool/i)
    await client.close()
  })
  test('tools/list 暴露 23 个原子工具;胖工具与 action 参数已退役(#4191;#4562 删 message_send_local;#5856 加 topic_;#6492 加 group_;#6698 加 group_update;message_reply 并入 message_send;群文件夹的工具搬进群文件夹 App,workspace_* 一组整个删掉)', async () => {
    const client = await connect(harness().deps)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'activity_chat_list', 'contact_friend', 'forum_read', 'forum_reply', 'group_add_agent', 'group_announcement_delete', 'group_announcement_post', 'group_announcement_update', 'group_avatar_set', 'group_create', 'group_flood_undo', 'group_info', 'group_join_decide', 'group_join_requests', 'group_leave', 'group_list', 'group_remove_member', 'group_set_role', 'group_update', 'message_conversations', 'message_download_file', 'message_history', 'message_invitations', 'message_invite', 'message_members',
      'message_rules', 'message_search', 'message_send', 'message_send_as_owner', 'message_send_file', 'message_send_file_as_owner',
      'owner_friends_list', 'profile_lookup', 'profile_update', 'profile_whoami', 'session_peers',
      'topic_invite', 'topic_list', 'topic_members', 'topic_open',
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object')
      expect(tool.inputSchema.oneOf, tool.name).toBeUndefined()
      expect(tool.inputSchema.anyOf, tool.name).toBeUndefined()
      expect((tool.inputSchema.properties as Record<string, unknown> | undefined)?.action, tool.name).toBeUndefined()
    }
    const contactFriend = TOOL_DEFS.find((def: { name: string }) => def.name === 'contact_friend')
    expect(contactFriend?.schema?.shape?.chat_id, 'contact_friend resolves its chat through the social-group RPC').toBeUndefined()
    const sendDescription = tools.find((tool) => tool.name === 'message_send')?.description ?? ''
    expect(sendDescription).toContain('reply_to_message_id')
    expect(sendDescription).not.toContain('message_reply')
    expect(sendDescription).toContain('session_message')
    expect(sendDescription).not.toContain('message_send_local')
    const fileDescription = tools.find((tool) => tool.name === 'message_send_file')?.description ?? ''
    expect(fileDescription).toContain('delivery tool')
    // The folder is the App's now: the native tool that delivers points at it, so an agent asked for a kept file finds it.
    expect(fileDescription).toContain('workspace__create in the catalog')
    await client.close()
  })
  test('session_peers groups UUID and display aliases under one identity in registry order', async () => {
    const hostPeers = [
      { identity: { users: { id: '11111111-1111-4111-8111-111111111111', gugu_number: 1001, display_name: 'Codex 1' } }, sessionId: 'conversation-a', title: 'Review delivery routing' },
      { identity: { users: { id: '22222222-2222-4222-8222-222222222222', gugu_number: 1002, display_name: 'Claude 1' } }, sessionId: 'conversation-b', title: 'Update docs' },
    ]
    const memberIds = hostPeers.map((row) => row.identity.users.id)
    const h = harness(memberIds)
    const restGet = h.deps.restGet
    h.deps.restGet = async (path: string) => path.startsWith('users?id=in')
      ? hostPeers.map((row) => row.identity.users)
      : restGet(path)
    const client = await connect({ ...h.deps, callSessionHost: async () => hostPeers })
    const rows = JSON.parse(text(await client.callTool({ name: 'session_peers', arguments: {} }))).items as typeof hostPeers
    expect(rows.map((row) => row.identity.users.id)).toEqual(memberIds.map((id) => `user:${id}`))
    const members = JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1' } }))).items as Array<{ user_id: string }>
    // 同一批身份、同一种 user: 写法;顺序各按各的(名录按最近活动,成员按名字)。
    expect(rows.map((row) => row.identity.users.id).sort()).toEqual(members.map((member) => member.user_id).sort())
    expect(rows[0].identity.users.display_name).toBe('Codex 1')
    expect(rows[0].title).toBe('Review delivery routing')
    expect(rows[0].sessionId).toBe('conversation-a')
    expect((rows[0] as Record<string, unknown>).user_id).toBeUndefined()
    await client.close()
  })
  // #5947 名录是全机的,调用者自己那一行也在里面 —— 与 message_members 同一判据标出来,别把读者当第三方呈现给他自己。
  test('session_peers marks the caller\'s own row with is_self — the same criterion message_members uses', async () => {
    const SELF = '44444444-4444-4444-8444-444444444444'
    const OTHER = '55555555-5555-4555-8555-555555555555'
    const hostPeers = [
      { identity: { users: { id: OTHER, gugu_number: null, display_name: 'Codex 6' } }, sessionId: 'conversation-other', title: 'Codex 6' },
      { identity: { users: { id: SELF, gugu_number: null, display_name: 'Codex 7' } }, sessionId: 'conversation-self', title: 'Codex 7' },
    ]
    const peersAs = async (context: Record<string, unknown>, host: unknown = hostPeers) => {
      const rows = JSON.parse(await callToolImpl({ ...TEST_CONTEXT, ...context, runHostAction: async () => host }, 'session_peers', {})).items as Array<{ identity: { users: { id: string } }; is_self?: unknown }>
      return rows.map((row) => [row.identity.users.id, row.is_self])
    }
    expect(await peersAs({ agentId: SELF })).toEqual([[`user:${OTHER}`, false], [`user:${SELF}`, true]])
    // 对照:调用者不在名录里 ⇒ 每一行都明确是 false,不是缺键
    expect(await peersAs({ agentId: '66666666-6666-4666-8666-666666666666' })).toEqual([[`user:${OTHER}`, false], [`user:${SELF}`, false]])
    // 宿主回了不是名录的东西 ⇒ 具名报错,不是一个裸 TypeError
    await expect(peersAs({ agentId: SELF }, { peers: hostPeers })).rejects.toThrow(/non-directory result/)
  })
  // spec im-mcp 列表约定:一台机器上可能有上百条会话,名录按窗口给、能按项目 / 名字 / 状态 / 置顶筛。
  test('session_peers windows the host directory and filters by project, name, status and pinned', async () => {
    const peer = (n: number, extra: Record<string, unknown>) => ({
      identity: { users: { id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, gugu_number: null, display_name: `Codex ${n}` } },
      sessionId: `conversation-${n}`,
      title: `Session ${n}`,
      project: 'gugu',
      status: 'idle',
      detail: 'done',
      pinned: false,
      last_active_at: null,
      ...extra,
    })
    const host = [
      ...Array.from({ length: 45 }, (_, i) => peer(i + 1, {})),
      peer(46, { project: 'gugu-website', title: 'Deploy dashboard', status: 'needs_user', detail: 'approval' }),
      peer(47, { project: 'gugu-website', title: 'Dashboard copy', pinned: true }),
    ]
    const peers = async (args: Record<string, unknown>) =>
      JSON.parse(await callToolImpl({ ...TEST_CONTEXT, runHostAction: async () => host }, 'session_peers', args)) as {
        total: number; rows: string | null; next: string | null; items: Array<{ title: string }>
      }
    const first = await peers({})
    expect(first).toMatchObject({ total: 47, rows: '1-20', next: '21-40' })
    expect((await peers({ rows: '41-60' })).items.map((row) => row.title))
      .toEqual(['Session 41', 'Session 42', 'Session 43', 'Session 44', 'Session 45', 'Deploy dashboard', 'Dashboard copy'])
    expect((await peers({ project: 'WEBSITE', name: 'dashboard' })).items.map((row) => row.title))
      .toEqual(['Deploy dashboard', 'Dashboard copy'])
    expect((await peers({ status: 'approval' })).items.map((row) => row.title)).toEqual(['Deploy dashboard'])
    expect((await peers({ status: 'needs_user' })).total).toBe(1)
    expect((await peers({ pinned: true })).items.map((row) => row.title)).toEqual(['Dashboard copy'])
    // name 也匹配联系人名(display_name)
    expect((await peers({ name: 'codex 12' })).items.map((row) => row.title)).toEqual(['Session 12'])
  })
  const CHILD_USER_ID = '33333333-3333-4333-8333-333333333333'
  const childPeer = {
    identity: { users: { id: CHILD_USER_ID, gugu_number: 1003, display_name: '观甲一' } },
    sessionId: 'child-conversation',
  }
  function peersHarness() {
    const h = harness([CHILD_USER_ID])
    const restGet = h.deps.restGet
    h.deps.restGet = async (path: string) => path.startsWith('users?id=in')
      ? [childPeer.identity.users]
      : restGet(path)
    return h
  }
  test('message_send resolves a session: recipient and stores the bare identity UUID', async () => {
    const h = peersHarness()
    const client = await connect({ ...h.deps, callSessionHost: async () => [childPeer] })
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: '行动开始', to_user_ids: ['session:child-conversation'] },
    })
    expect(text(result)).toMatch(/^sent/)
    expect(h.calls.inserts).toHaveLength(1)
    const row = h.calls.inserts[0][1] as Record<string, unknown>
    for (const stored of row.to_user_ids as string[]) {
      expect(stored, 'stored recipient must be a bare identity UUID, never a typed address').toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    }
    expect(row.to_user_ids).toEqual([CHILD_USER_ID])
    await client.close()
  })
  test('message_send still stores a bare UUID for the user: form, and both forms reach the same row', async () => {
    const h = peersHarness()
    const client = await connect({ ...h.deps, callSessionHost: async () => [childPeer] })
    await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: '行动开始', to_user_ids: [`user:${CHILD_USER_ID}`] },
    })
    expect((h.calls.inserts[0][1] as Record<string, unknown>).to_user_ids).toEqual([CHILD_USER_ID])
    await client.close()
  })
  test('message_send fails loud when a session: recipient is not addressable on this machine', async () => {
    const h = peersHarness()
    const client = await connect({ ...h.deps, callSessionHost: async () => [] })
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: '行动开始', to_user_ids: ['session:child-conversation'] },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/not an addressable session on this machine/)
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  describe('#4566 to_user_ids 解析边界', () => {
    const hostWith = (rows: unknown) => ({ context: { runHostAction: async () => rows } })
    test('session: resolves to the bare identity UUID', async () => {
      await expect(resolveRecipientAddresses(['session:child-conversation'], hostWith([childPeer])))
        .resolves.toEqual([CHILD_USER_ID])
    })
    test('a non-UUID identity from the host fails loud instead of reaching the column', async () => {
      const typedFromHost = [{ ...childPeer, identity: { users: { ...childPeer.identity.users, id: `user:${CHILD_USER_ID}` } } }]
      await expect(resolveRecipientAddresses(['session:child-conversation'], hostWith(typedFromHost)))
        .rejects.toThrow(/non-UUID identity/)
    })
    test('user: entries and an empty list are handed through without asking the host', async () => {
      let asked = 0
      const counting = { context: { runHostAction: async () => { asked += 1; return [childPeer] } } }
      await expect(resolveRecipientAddresses([CHILD_USER_ID], counting)).resolves.toEqual([CHILD_USER_ID])
      await expect(resolveRecipientAddresses(null, counting)).resolves.toBeNull()
      expect(asked).toBe(0)
    })
  })
  test('message_send rejects a bare id in to_user_ids, as before', async () => {
    const h = peersHarness()
    const client = await connect({ ...h.deps, callSessionHost: async () => [childPeer] })
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: '行动开始', to_user_ids: [CHILD_USER_ID] },
    })
    expect(result.isError).toBe(true)
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  describe('#5048 gugu:<号> 短址', () => {
    function numberHarness() {
      const h = peersHarness()
      const rpcs: Array<[string, Record<string, unknown>]> = []
      const deps = {
        ...h.deps,
        restRpc: async (name: string, body: Record<string, unknown>, profile?: string) => {
          rpcs.push([name, body])
          if (name === 'search_users' && body.p_query === '1003') {
            return [
              { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', display_name: '1003 号房', type: 'human', gugu_number: 91003 },
              { id: CHILD_USER_ID, display_name: '观甲一', type: 'agent', gugu_number: 1003, agent_public: true },
            ]
          }
          // ❌ 不许在这里 return [] 兜底:chat_facts / list_member_ids 也走 restRpc,
          // 一刀切回空等于「这条 chat 不存在、一个成员都没有」,整组用例会以「收件人不在成员里」失败。
          return h.deps.restRpc(name, body, profile)
        },
      }
      return { ...h, deps, rpcs }
    }
    test('message_send resolves gugu:<号> through search_users and stores the bare UUID', async () => {
      const h = numberHarness()
      const client = await connect(h.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: '行动开始', to_user_ids: ['gugu:1003'] },
      })
      expect(text(result)).toMatch(/^sent/)
      expect(h.rpcs.filter(([name]) => name === 'search_users')).toEqual([['search_users', { p_query: '1003' }]])
      expect(h.calls.inserts).toHaveLength(1)
      const row = h.calls.inserts[0][1] as Record<string, unknown>
      expect(row.to_user_ids).toEqual([CHILD_USER_ID])
      await client.close()
    })
    test('an unknown 咕咕号 fails loud before any insert, naming the number', async () => {
      const h = numberHarness()
      const client = await connect(h.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: '行动开始', to_user_ids: ['gugu:4242'] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/no person or public agent with Gugu number 4242/)
      expect(h.calls.inserts).toHaveLength(0)
      await client.close()
    })
    test('a bare number is rejected by name, pointing at gugu:<number>', async () => {
      const h = numberHarness()
      const client = await connect(h.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: '行动开始', to_user_ids: ['1003'] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/to_user_ids\[0\].*bare value "1003".*gugu:<number>/)
      expect(h.rpcs.filter(([name]) => name === 'search_users')).toHaveLength(0)
      expect(h.calls.inserts).toHaveLength(0)
      await client.close()
    })
    test('the owner\'s own 咕咕号 resolves through the caller\'s own identity row when search_users hides self', async () => {
      const OWNER = '55555555-5555-4555-8555-555555555555'
      const ownerToken = `x.${Buffer.from(JSON.stringify({ sub: OWNER })).toString('base64url')}.x`
      const h = harness([OWNER, 'alice'])
      const gets: string[] = []
      const origGet = h.deps.restGet
      const injected = {
        ...h.deps,
        // search_users 故意回空(这条用例测的就是「查不到自己」时的兜底);
        // 其余 RPC(chat_facts / list_member_ids)必须落回基座桩,❌ 不能一刀切回空。
        restRpc: async (name: string, body: Record<string, unknown>, profile?: string) => (
          name === 'search_users' ? [] : h.deps.restRpc(name, body, profile)
        ),
        restGet: async (path: string) => {
          gets.push(path)
          if (path.startsWith(`users?id=eq.${OWNER}&gugu_number=eq.7&`)) {
            return [{ id: OWNER, display_name: '老板', type: 'human', gugu_number: 7, agent_public: null }]
          }
          if (path.startsWith('users?id=eq.')) return []
          return origGet(path)
        },
      }
      const server = createGuguImServerImpl(() => ({ ...TEST_CONTEXT, getAccessToken: async () => ownerToken }), { trackRequest: passThrough, ...injected })
      const [ct, st] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'test', version: '1.0.0' })
      await Promise.all([server.connect(st), client.connect(ct)])
      const sent = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: '收到', to_user_ids: ['gugu:7'] } })
      expect(text(sent)).toMatch(/^sent/)
      expect((h.calls.inserts[0][1] as Record<string, unknown>).to_user_ids).toEqual([OWNER])
      expect(gets.filter((path) => path.includes('gugu_number=eq.7'))).toEqual([
        `users?id=eq.${OWNER}&gugu_number=eq.7&select=id,display_name,type,gugu_number,agent_public`,
      ])
      const miss = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: '收到', to_user_ids: ['gugu:8'] } })
      expect(miss.isError).toBe(true)
      expect(text(miss)).toMatch(/Gugu number 8/)
      expect(h.calls.inserts).toHaveLength(1)
      await client.close()
    })
    test('profile_lookup takes the typed address too', async () => {
      const h = numberHarness()
      const out = await callTool('profile_lookup', { gugu_number: 'gugu:1003' }, { restRpc: h.deps.restRpc, restGet: async () => [] })
      expect(JSON.parse(String(out))).toMatchObject({ user_id: `user:${CHILD_USER_ID}`, gugu_number: 1003, display_name: '观甲一' })
      const client = await connect(h.deps)
      const viaSchema = await client.callTool({ name: 'profile_lookup', arguments: { gugu_number: 'gugu:1003' } })
      expect(JSON.parse(text(viaSchema))).toMatchObject({ user_id: `user:${CHILD_USER_ID}` })
      await client.close()
    })
    test('profile_lookup accepts the canonical user address', async () => {
      const h = numberHarness()
      const out = await callTool(
        'profile_lookup',
        { gugu_number: `user:${CHILD_USER_ID}` },
        {
          restRpc: h.deps.restRpc,
          restGet: async (path: string) => path.startsWith(`users?id=eq.${CHILD_USER_ID}`)
            ? [{ id: CHILD_USER_ID, display_name: '观甲一', type: 'agent', gugu_number: 1003, agent_public: true }]
            : [],
        },
      )
      expect(JSON.parse(String(out))).toMatchObject({ user_id: `user:${CHILD_USER_ID}`, gugu_number: 1003 })
    })
    test('profile_lookup rejects an unknown canonical user address loudly', async () => {
      const h = numberHarness()
      await expect(callTool(
        'profile_lookup',
        { gugu_number: `user:${CHILD_USER_ID}` },
        { restRpc: h.deps.restRpc, restGet: async () => [] },
      )).rejects.toThrow(`no person or agent with user address user:${CHILD_USER_ID} is visible to you`)
    })
  })
  test('session_peers fails loud when host identity resolution is ambiguous', async () => {
    const client = await connect({ ...harness().deps, callSessionHost: async () => { throw new Error('local peers identity lookup: ambiguous identity.users.id') } })
    const result = await client.callTool({ name: 'session_peers', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/ambiguous identity\.users\.id/)
    await client.close()
  })
  test('schema 校验：message_send 缺 text / 未知工具名 → 拒绝', async () => {
    const client = await connect(harness(['alice']).deps)
    const reject = async (name: string, args: Record<string, unknown>) => {
      try { return (await client.callTool({ name, arguments: args })).isError === true } catch { return true }
    }
    expect(await reject('message_send', { chat_id: 'c1' })).toBe(true) // 缺 text
    expect(await reject('message_nope', { chat_id: 'c1' })).toBe(true) // 原子化后没有 action 可猜:错名字整调用拒绝
    await client.close()
  })
  test('message_send rejects harness SendMessage shape with a corrective route', async () => {
    const client = await connect(harness(['alice']).deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: { to: 'researcher', message: 'hello' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('harness SendMessage shape')
    expect(text(result)).toContain('session_message')
    await client.close()
  })
  test('message_send keeps missing-field errors actionable', async () => {
    const client = await connect(harness(['alice']).deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('text')
    await client.close()
  })
  test('message_send does not read or consume the agent inbox', async () => {
    const h = harness(['alice'])
    const unreadRow = {
      id: 'm-unread', seq: 5, content: '收件箱里的触发消息', sender_user_id: 'owner-1',
      sender_display_name: '老板', sender_type: 'human', to_user_ids: ['agent-1'], is_whisper: false,
      reply_to_sender_user_id: null, listen_mode: 'active', chat_kind: 'dm', thread_root_id: null,
    }
    let pulls = 0
    // @@@5856 只截收件箱读(任何 pull_agent_* RPC);kind 与成员名单是发帖路径必经的**读**,交回底座桩
    // (❌ 不许在这里 return [] 兜底 —— 空名单现在会 fail-loud 说「读不到」,测的就不是本意了)。
    const baseRestRpc = h.deps.restRpc as (name: string, body: Record<string, unknown>, profile?: string) => Promise<unknown>
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => {
      if (name.startsWith('pull_agent_')) {
        pulls += 1
        return [unreadRow]
      }
      return baseRestRpc(name, body, profile)
    }
    const client = await connect(h.deps)
    const result = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: '首次直接回帖' } })
    expect(result.isError).not.toBe(true)
    expect(h.calls.inserts).toHaveLength(1)
    expect(pulls).toBe(0)
    await client.close()
  })
  test('message_send（成员合法）→ insert messages.text', async () => {
    const h = harness(['alice'])
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
    expect(text(r)).toMatch(/^sent/)
    expect(h.calls.inserts).toHaveLength(1)
    expect(h.calls.inserts[0][0]).toBe('messages')
    expect((h.calls.inserts[0][1] as Record<string, unknown>).content_type).toBe('text')
    await client.close()
  })
  // @@@5856 名单读不到时必须说「读不到」,❌ 不许当空集(会把它说成「这些人不是成员」,与事实相反)、
  // ❌ 也不许当全集,更 ❌ 不许直接 .map 一个 null 崩成 TypeError(restRpc 对 void/空 body 回 null)。
  test.each([
    { name: 'restRpc 回 null(void/空 body)', rows: null },
    { name: '读到零行(我自己就在里面,零行只可能是读不到)', rows: [] as unknown[] },
  ])('成员名单 $name 时 message_send fail-loud 说读不到,而不是说「不是成员」', async ({ rows }) => {
    const h = harness(['alice'])
    const baseRestRpc = h.deps.restRpc as (name: string, body: Record<string, unknown>, profile?: string) => Promise<unknown>
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => (
      name === 'list_member_ids' ? rows : baseRestRpc(name, body, profile)
    )
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('读不到 chat(c1)的成员名单')
    expect(text(r)).not.toContain('不在本 chat')
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  test('message_send cross-conversation send posts straight into the addressed chat', async () => {
    const h = harness(['alice'])
    const sourceRestGet = h.deps.restGet
    const sourceRestRpc = h.deps.restRpc
    h.deps.restGet = async (path: string) => {
      if (path.startsWith('users?id=in')) return [{ id: 'alice', display_name: 'Alice', type: 'human' }]
      return sourceRestGet(path)
    }
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => {
      if (name === 'chat_facts' && body.p_chat_id === 'c2') return [{ id: 'c2', kind: 'group', source_chat_id: null, group_prompt: null }]
      if (name === 'list_member_ids' && body.p_chat_id === 'c2') {
        return [{ user_id: 'agent-1', role: 'member' }, { user_id: 'alice', role: 'member' }]
      }
      return sourceRestRpc(name, body, profile)
    }
    const client = await connect(h.deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c2', text: 'cross-chat', to_user_ids: ['user:alice'] },
    })
    expect(text(result)).toMatch(/^sent/)
    expect(writeRpcs(h.calls.rpcs)).toEqual([])
    expect(h.calls.inserts).toHaveLength(1)
    expect(h.calls.inserts[0][0]).toBe('messages')
    expect((h.calls.inserts[0][1] as Record<string, unknown>)).toMatchObject({ chat_id: 'c2', content: '@Alice cross-chat' })
    await client.close()
  })
  test('contact_friend reuses the exact social group and posts through the message_send path', async () => {
    const friendId = '11111111-1111-4111-8111-111111111111'
    const h = harness(['agent-1', friendId])
    // @@@5856 kind 与成员名单现在也走 restRpc(chat_facts / list_member_ids),所以这里不能整个顶掉
    // 底座桩,只截 request_agent_friend_contact 这一个名字,其余交回去。
    const baseRestRpc = h.deps.restRpc as (name: string, body: Record<string, unknown>, profile?: string) => Promise<unknown>
    const rpc = vi.fn(async (name: string, body: Record<string, unknown>, profile?: string) => (
      name === 'request_agent_friend_contact'
        ? [{ chat_id: 'social-group-1', name: 'Agent、Bob', created: false, status: 'already_member' }]
        : baseRestRpc(name, body, profile)
    ))
    h.deps.restRpc = rpc
    const originalRestGet = h.deps.restGet
    h.deps.restGet = async (path: string) => {
      // @@@5856 kind / 成员 / 群规都改走按 actor 的 chat_facts / list_member_ids(桩在下面的 restRpc)。
      // A newly created social group has no prompt, so its first message passes the shared rules-read gate.
      // If social groups gain a template prompt later, the first contact will intentionally be refused once.
      if (path.startsWith('users?id=in.(')) {
        return [
          { id: 'owner-1', display_name: 'Owner', type: 'human' },
          { id: friendId, display_name: 'Bob', type: 'human' },
        ]
      }
      return originalRestGet(path)
    }

    const result = JSON.parse(await callTool('contact_friend', {
      friend_user_id: `user:${friendId}`,
      text: '请看这份进展',
    }, h.deps))

    expect(rpc.mock.calls.filter(([name]) => name === 'request_agent_friend_contact')).toHaveLength(1)
    expect(rpc).toHaveBeenCalledWith('request_agent_friend_contact', {
      p_agent_user_id: 'agent-1',
      p_friend_user_id: friendId,
      p_message: '请看这份进展',
    })
    expect(result).toMatchObject({ chat_id: 'social-group-1', name: 'Agent、Bob', created: false })
    expect(result.message_id).toMatch(/^msg:/)
    expect(h.calls.inserts).toHaveLength(1)
    expect(h.calls.inserts[0]).toMatchObject([
      'messages',
      {
        chat_id: 'social-group-1',
        sender_user_id: 'agent-1',
        content: '@Bob 请看这份进展',
        content_type: 'text',
        to_user_ids: [friendId],
        thread_root_id: null,
      },
    ])
  })
  test('contact_friend pending consent never sends a group message', async () => {
    const friendId = '11111111-1111-4111-8111-111111111111'
    const h = harness(['agent-1'])
    h.deps.restRpc = vi.fn(async () => ({ chat_id: 'waiting-group', status: 'pending', invitation_id: 'invite-1' }))
    const result = JSON.parse(await callTool('contact_friend', { friend_user_id: `user:${friendId}`, text: '请一起讨论' }, h.deps))
    expect(result).toMatchObject({ status: 'pending', message_id: null, invitation_id: 'invite-1' })
    expect(h.calls.inserts).toHaveLength(0)
  })
  test('message_invite preserves the typed recipient and reports pending without sending messages', async () => {
    const target = '11111111-1111-4111-8111-111111111111'
    const h = harness(['agent-1'])
    const baseRpc = h.deps.restRpc
    const rpc = vi.fn(async (name: string, body: Record<string, unknown>, profile?: string) => name === 'request_group_invitation_as'
      ? { status: 'pending', chat_id: 'c1', invitation_id: 'invite-1', invitee_user_id: target }
      : baseRpc(name, body, profile))
    h.deps.restRpc = rpc
    const result = JSON.parse(await callTool('message_invite', { chat_id: 'c1', to_user_ids: [`user:${target}`], text: '请协助评审' }, h.deps))
    expect(rpc).toHaveBeenCalledWith('request_group_invitation_as', {
      p_chat_id: 'c1', p_as_user_id: 'agent-1', p_invitee_user_id: target, p_message: '请协助评审',
    })
    expect(result).toMatchObject({ status: 'pending', invitee_user_id: `user:${target}` })
    expect(h.calls.inserts).toHaveLength(0)
  })
  test('message_invite does not substitute recipients or hide permission failures', async () => {
    const h = harness(['agent-1'])
    await expect(callTool('message_invite', { chat_id: 'c1', to_user_ids: [], text: '请加入' }, h.deps)).rejects.toThrow(/exactly one/)
    const rpc = h.deps.restRpc
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => {
      if (name === 'request_group_invitation_as') throw new Error('Group does not allow this member to invite')
      return rpc(name, body, profile)
    }
    await expect(callTool('message_invite', { chat_id: 'c1', to_user_ids: ['user:someone'], text: '请加入' }, h.deps)).rejects.toThrow(/does not allow/)
    expect(h.calls.inserts).toHaveLength(0)
  })
  test('message_invitations queries only the current Agent invitation history', async () => {
    const h = harness()
    const rpc = vi.fn(async () => [{ id: 'inv-1', status: 'rejected' }])
    h.deps.restRpc = rpc
    const result = JSON.parse(await callTool('message_invitations', {}, h.deps))
    expect(rpc).toHaveBeenCalledWith('list_group_invitations_as', { p_as_user_id: 'agent-1', p_sent: true, p_include_decided: true })
    expect(result).toEqual({ total: 1, rows: '1-1', next: null, items: [{ id: 'inv-1', status: 'rejected' }] })
  })
  test('message_send validator follows renderer markdown/math boundaries', () => {
    expect(() => assertAgentMessageText('Windows path: C:\\Users\\research\\notes.txt')).not.toThrow()
    expect(() => assertAgentMessageText('Windows path with escape-shaped names: C:\\new\\notes.txt')).not.toThrow()
    expect(() => assertAgentMessageText('Unix path: /tmp/research/notes.txt')).not.toThrow()
    expect(() => assertAgentMessageText('Subscription: US$12/month')).not.toThrow()
    // 两个价格之间夹着中文:不是公式(单美元照 pandoc 认),❌ 当成「公式里有 CJK」拒掉。
    expect(() => assertAgentMessageText('清单：背包 $29.99、车灯 $9.99、水壶 $12.50')).not.toThrow()
    expect(() => assertAgentMessageText('escaped dollar fraction: \\$1/3')).not.toThrow()
    expect(() => assertAgentMessageText('columns\twith a real tab')).not.toThrow()
    expect(() => assertAgentMessageText('begin A/B review')).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Windows path with spaces: C:\Program Files\Gugu`)).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Windows path with one tab: C:\Program	Files\new\notes.txt`)).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Later spaced component: C:\Root\Program Files\new\notes.txt`)).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Multiple structured components: C:\Root\Program Files\new\Research Notes\final.txt`)).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Quoted Windows path: "C:\Program Files\new\notes.txt"`)).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Regex example: \d+`)).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Unknown backslash prose: \Gugu remains literal`)).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Unknown control-like prose: \notation remains literal`)).not.toThrow()
    expect(() => assertAgentMessageText('norm \\(\\rVert x \\rVert\\)')).not.toThrow()
    expect(() => assertAgentMessageText(String.raw`Delimited math: \(x\neq 0\)`)).not.toThrow()
    expect(() => assertAgentMessageText('examples: `x\\neq 0`\n```tex\n\\theta, \\frac{1}{2}\n```')).not.toThrow()
    expect(() => assertAgentMessageText('Line1\\nNext')).toThrow(/字面|真实换行/)
    expect(() => assertAgentMessageText('Line1\\nnext step')).toThrow(/字面|真实换行/)
    expect(() => assertAgentMessageText('x\\neq 0')).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText(String.raw`Embedded drive token abcC:\Docs\neq 0`)).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText(
      String.raw`Windows path: C:\Program Files\Gugu, then x\neq 0`,
    )).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText(
      String.raw`Windows path: C:\Gugu then x\neq 0`,
    )).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText(
      String.raw`Windows path: C:\Docs  then\neq 0`,
    )).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText(
      String.raw`Windows path: C:\Docs		then\neq 0`,
    )).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText(
      String.raw`Later spaced path C:\Root\Program Files\new\notes.txt then x\neq 0`,
    )).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText('broken math: \\(\u0009heta\\)')).toThrow(/TeX|LaTeX|转义|破损/)
    expect(() => assertAgentMessageText('broken \\\\(\\operatorname{Min}(R)\\\\)')).toThrow(/TeX|LaTeX|分隔符/)
    expect(() => assertAgentMessageText('broken: S^1=mathbb R/2pimathbb Z')).toThrow(/TeX|LaTeX|转义|破损/)
    expect(() => assertAgentMessageText('broken: \\operatorname{Min}(R) outside math')).toThrow(/TeX|LaTeX|分隔符/)
  })
  test.each(dollarRunBoundaryFixtures)('message_send dollar-run parity: $name', ({ markdown, validator }) => {
    const assertion = expect(() => assertAgentMessageText(markdown))
    if (validator === 'allow') assertion.not.toThrow()
    else assertion.toThrow(/TeX|LaTeX|分隔符/)
  })
  test.each(markdownStructureBoundaryFixtures)('message_send markdown-structure parity: $name', ({ markdown, validator }) => {
    const assertion = expect(() => assertAgentMessageText(markdown))
    if (validator === 'allow') assertion.not.toThrow()
    else assertion.toThrow(/TeX|LaTeX|分隔符/)
  })
  test('message_send 在入库前拒绝正文字面换行转义，代码区原样保留', async () => {
    for (const escapedText of ['第一行\\n第二行', '推导完成\\nTheorem 成立']) {
      const blocked = harness(['alice'])
      const client = await connect(blocked.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: escapedText, to_user_ids: ['user:alice'] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/字面.*\\n|真实换行/)
      expect(blocked.calls.inserts).toHaveLength(0)
      expect(blocked.calls.rpcs).toHaveLength(0)
      await client.close()
    }
    const allowed = harness(['alice'])
    const client = await connect(allowed.deps)
    const codeText = '正文说明：`\\n` 是字面量。\n```ts\nconst escaped = "\\n"\n```'
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: codeText, to_user_ids: ['user:alice'] },
    })
    expect(result.isError).not.toBe(true)
    expect((allowed.calls.inserts[0][1] as Record<string, unknown>).content).toBe(codeText)
    await client.close()
  })
  test('message_send 在入库前拒绝 LaTeX 分隔符外的 TeX command', async () => {
    for (const rawMath of [
      '证明：\\operatorname{Min}(R)=(x),(y)',
      '由 (xy)=(x)\\cap(y) 且 x\\neq 0',
      'x\\neq 0',
    ]) {
      const blocked = harness(['alice'])
      const client = await connect(blocked.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: rawMath, to_user_ids: ['user:alice'] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/TeX|LaTeX|分隔符/)
      expect(blocked.calls.inserts).toHaveLength(0)
      expect(blocked.calls.rpcs).toHaveLength(0)
      await client.close()
    }
    const allowed = harness(['alice'])
    const client = await connect(allowed.deps)
    const delimited = '已证明：\\(\\operatorname{Min}(R)=(x),(y)\\)\n\\[(xy)=(x)\\cap(y)\\]'
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: delimited, to_user_ids: ['user:alice'] },
    })
    expect(result.isError).not.toBe(true)
    expect((allowed.calls.inserts[0][1] as Record<string, unknown>).content).toBe(delimited)
    await client.close()
  })
  test('message_send 在入库前拒绝已被参数解码破坏的 TeX 残片', async () => {
    const decodedKnownCommands = [
      String.raw`"\neq 0"`,
      String.raw`"\nabla f"`,
      String.raw`"\nu"`,
      String.raw`"\bar{x}"`,
      String.raw`"\tau"`,
      String.raw`"\tfrac{1}{2}"`,
    ].map((json) => JSON.parse(json) as string)
    for (const corruptedMath of [
      '假设：S^1=mathbb R/2pimathbb Z',
      '微分：d\u0009heta=f(\u0009heta)d\u0009heta',
      '比例：\u000crac{1}{2}',
      '分隔符内也损坏：\\(\u0009heta\\)',
      ...decodedKnownCommands,
    ]) {
      const blocked = harness(['alice'])
      const client = await connect(blocked.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: corruptedMath, to_user_ids: ['user:alice'] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/TeX|LaTeX|转义|破损/)
      expect(blocked.calls.inserts).toHaveLength(0)
      expect(blocked.calls.rpcs).toHaveLength(0)
      await client.close()
    }
    for (const allowedText of [
      'Ordinary prose line one\nnext paragraph remains readable.',
      String.raw`Vocabulary prose: neq nabla nu bar tau tfrac; regex \d+ remains literal.`,
      String.raw`Windows path: C:\Program Files\Gugu\notes.txt`,
      String.raw`合法公式：\(x\neq 0, \nabla f, \nu, \bar{x}, \tau, \tfrac{1}{2}\)`,
    ]) {
      expect(() => assertAgentMessageText(allowedText)).not.toThrow()
    }
    const allowed = harness(['alice'])
    const client = await connect(allowed.deps)
    const codeText = '损坏示例：`mathbb R`。\n```text\nd heta, frac{1}{2}\n```'
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: codeText, to_user_ids: ['user:alice'] },
    })
    expect(result.isError).not.toBe(true)
    expect((allowed.calls.inserts[0][1] as Record<string, unknown>).content).toBe(codeText)
    await client.close()
  })
  test('message_send 拒绝会触发 KaTeX strict warning 的公式内 CJK 正文', async () => {
    const blocked = harness(['alice'])
    const client = await connect(blocked.deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: {
        chat_id: 'c1',
        text: '错误混装：\\(f(\\theta)=调和且闭\\)',
        to_user_ids: ['user:alice'],
      },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/KaTeX|LaTeX|公式|正文/)
    expect(blocked.calls.inserts).toHaveLength(0)
    expect(blocked.calls.rpcs).toHaveLength(0)
    await client.close()
    const allowed = harness(['alice'])
    const allowedClient = await connect(allowed.deps)
    const cleanText = '调和且闭的条件是 \\(f(\\theta)=c\\)，且 \\([d\\theta]\\in H^1(S^1;\\mathbb R)\\)。'
    const allowedResult = await allowedClient.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: cleanText, to_user_ids: ['user:alice'] },
    })
    expect(allowedResult.isError).not.toBe(true)
    expect((allowed.calls.inserts[0][1] as Record<string, unknown>).content).toBe(cleanText)
    await allowedClient.close()
  })
  test('message_send accepts JSON-string arrays but rejects raw strings', async () => {
    const h = harness(['alice'])
    const client = await connect(h.deps)
    const serialized = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: '["user:alice"]' } })
    expect(text(serialized)).toMatch(/^sent/)
    expect((h.calls.inserts[0][1] as Record<string, unknown>).to_user_ids).toEqual(['alice'])
    const raw = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: 'alice' } })
    expect(raw.isError).toBe(true)
    expect(text(raw)).toContain('to_user_ids')
    expect(h.calls.inserts).toHaveLength(1)
    for (const value of ['', '   ']) {
      const empty = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: value } })
      expect(empty.isError).toBe(true)
      expect(text(empty)).toContain('to_user_ids')
    }
    for (const value of [[' '], ['\t'], ['alice', '   ']]) {
      const invalidItem = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: value } })
      expect(invalidItem.isError).toBe(true)
      expect(text(invalidItem)).toContain('to_user_ids')
    }
    expect(h.calls.inserts).toHaveLength(1)
    await client.close()
  })
  test('#849 仍生效：非成员收件人 → isError、不投递', async () => {
    const h = harness(['alice'])
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:ghost'] } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/不在本 chat/)
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  test('reconcileMentionExpression 纯函数', () => {
    const members = [
      { id: 'u-jia', display_name: '分析甲' },
      { id: 'u-fen', display_name: '分析' }, // 短名是长名前缀:尾部边界断言防误吃
      { id: 'u-yi', display_name: '执行乙' },
    ]
    expect(reconcileMentionExpression(members, '标题列好了 @分析甲 请校对,抄送 @执行乙', ['u-jia', 'u-yi']))
      .toEqual({ content: '标题列好了 @分析甲 请校对,抄送 @执行乙', mismatches: [] })
    expect(reconcileMentionExpression(members, '请校对结构', ['u-jia']).content).toBe('@分析甲 请校对结构')
    expect(reconcileMentionExpression(members, '@执行乙 交给你', []).mismatches).toEqual(['执行乙'])
    expect(reconcileMentionExpression(members, '@分析甲 看看', ['u-jia']).mismatches).toEqual([])
    expect(reconcileMentionExpression(members, '联系 a@执行乙.com 即可', []).mismatches).toEqual([])
    expect(reconcileMentionExpression(members, '联系 a@执行乙 即可', []).mismatches).toEqual(['执行乙'])
    expect(reconcileMentionExpression(members, '你好@执行乙 交给你', []).mismatches).toEqual(['执行乙'])
    expect(reconcileMentionExpression(members, '@执行乙 收到', [], ['u-yi']).mismatches).toEqual([])
    expect(reconcileMentionExpression(members, '大家看下', ['*']).content).toBe('@all 大家看下')
    expect(reconcileMentionExpression(members, '@all 大家看下', ['*']).content).toBe('@all 大家看下')
    expect(reconcileMentionExpression(members, '联系 a@b.com 即可', []).mismatches).toEqual([])
  })
  describe('#2437 unaddressed agent bare-name gate', () => {
    const directory = [
      { id: 'agent-long', display_name: '分析甲', type: 'agent' },
      { id: 'agent-short', display_name: '分析', type: 'agent' },
      { id: 'agent-ascii', display_name: 'Ada', type: 'agent' },
      { id: 'agent-nfc', display_name: 'Amélie', type: 'agent' },
      { id: 'agent-single', display_name: '甲', type: 'agent' },
      { id: 'human-exec', display_name: '执行乙', type: 'human' },
      { id: 'human-long', display_name: '分析结果', type: 'human' },
    ]
    function addressedHarness() {
      const h = harness(['agent-1', ...directory.map((member) => member.id)])
      const restGet = h.deps.restGet
      h.deps.restGet = async (path: string) => {
        if (path.startsWith('users?id=in.')) return directory
        return restGet(path)
      }
      return h
    }
    test.each([
      {
        name: 'adjacent CJK prose and long name precedence',
        text: '分析甲你看下',
        expectedName: '分析甲',
        absentName: '分析、',
      },
      {
        name: 'ASCII token boundary',
        text: 'Ada, please continue',
        expectedName: 'Ada',
        absentName: '分析',
      },
      {
        name: 'NFC-equivalent decomposed text',
        text: 'Ame\u0301lie please continue',
        expectedName: 'Amélie',
        absentName: 'Ada',
      },
    ])('$name rejects before message insertion', async ({ text: message, expectedName, absentName }) => {
      const h = addressedHarness()
      const client = await connect(h.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: message, to_user_ids: [] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(expectedName)
      expect(text(result)).not.toContain(absentName)
      expect(h.calls.inserts).toHaveLength(0)
      expect(writeRpcs(h.calls.rpcs)).toEqual([])
      await client.close()
    })
    test('reports multiple agent names and ids in deterministic order', async () => {
      const h = addressedHarness()
      const client = await connect(h.deps)
      const result = await client.callTool({
        name: 'message_send',
        arguments: { chat_id: 'c1', text: 'Ada, 分析甲你看下', to_user_ids: [] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('正文叫了 Ada、分析甲')
      expect(text(result)).toContain('agent-ascii、agent-long')
      expect(h.calls.inserts).toHaveLength(0)
      expect(writeRpcs(h.calls.rpcs)).toEqual([])
      await client.close()
    })
    test.each([
      {
        name: 'explicit mention',
        tool: 'message_send',
        args: { chat_id: 'c1', text: '@分析甲 你看下', to_user_ids: ['user:agent-long'] },
      },
      {
        name: 'reply identity',
        tool: 'message_send',
        args: { chat_id: 'c1', text: '分析甲，收到', reply_to_message_id: 'msg:m-peer', to_user_ids: ['user:agent-long'] },
      },
      {
        name: 'another explicit recipient',
        tool: 'message_send',
        args: { chat_id: 'c1', text: '分析甲，供参考', to_user_ids: ['user:human-exec'] },
      },
      {
        name: 'human bare name',
        tool: 'message_send',
        args: { chat_id: 'c1', text: '执行乙，请看', to_user_ids: [] },
      },
      {
        name: 'long human name claims an agent short-name prefix',
        tool: 'message_send',
        args: { chat_id: 'c1', text: '分析结果很好', to_user_ids: [] },
      },
      {
        name: 'single-code-point agent name',
        tool: 'message_send',
        args: { chat_id: 'c1', text: '甲，请看', to_user_ids: [] },
      },
      {
        name: 'ASCII name inside a larger word',
        tool: 'message_send',
        args: { chat_id: 'c1', text: 'xAdaY remains one token', to_user_ids: [] },
      },
    ])('$name remains allowed', async ({ tool, args }) => {
      const h = addressedHarness()
      const client = await connect(h.deps)
      const result = await client.callTool({ name: tool, arguments: args })
      expect(result.isError).not.toBe(true)
      expect(h.calls.inserts).toHaveLength(1)
      await client.close()
    })
  })
  test('message_history/message_search 按 agent 身份走 DEFINER RPC:thread 范围、严格 seq 翻页', async () => {
    // 隐藏聊天记录对 agent 生效:不再用主人的 JWT 直读 messages_view(判的是主人的入群时间界),
    // 改走 message_history_as / message_search_as,p_as_user_id = 本 agent。
    const h = harness()
    const rpcs: Array<[string, Record<string, unknown>]> = []
    const restRpc = h.deps.restRpc
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => {
      if (name === 'message_history_as' || name === 'message_search_as') {
        rpcs.push([name, body])
        return [{ id: 'm1', seq: 7, content: 'hello', content_type: 'text' }]
      }
      return restRpc(name, body, profile)
    }
    const paths: string[] = []
    const restGet = h.deps.restGet
    h.deps.restGet = async (path: string) => { paths.push(path); return restGet(path) }
    const client = await connect(h.deps)
    const history = JSON.parse(text(await client.callTool({
      name: 'message_history',
      arguments: { chat_id: 'c1', thread_root_id: 'msg:thread-1', before_seq: 42, limit: 12 },
    }))) as Array<{ seq?: number }>
    const search = JSON.parse(text(await client.callTool({
      name: 'message_search',
      arguments: { chat_id: 'c1', query: 'hi', before_seq: 42, limit: 13 },
    }))) as Array<{ seq?: number }>
    expect(history).toEqual([expect.objectContaining({ seq: 7 })])
    expect(search).toEqual([expect.objectContaining({ seq: 7 })])
    expect(rpcs).toEqual([
      ['message_history_as', { p_chat_id: 'c1', p_as_user_id: 'agent-1', p_thread_root_id: 'thread-1', p_before_seq: 42, p_limit: 12 }],
      ['message_search_as', { p_chat_id: 'c1', p_query: 'hi', p_as_user_id: 'agent-1', p_before_seq: 42, p_limit: 13 }],
    ])
    // 主线历史:thread 为 null(= 只看主线),不是「不限 thread」。
    await client.callTool({ name: 'message_history', arguments: { chat_id: 'c1' } })
    expect(rpcs[2]).toEqual(['message_history_as', { p_chat_id: 'c1', p_as_user_id: 'agent-1', p_thread_root_id: null, p_before_seq: null, p_limit: 20 }])
    // 主人凭证的 messages_view 直读一条都不许再有。
    expect(paths.filter((path) => path.startsWith('messages_view'))).toEqual([])
    const { tools } = await client.listTools()
    for (const name of ['message_send', 'message_history', 'message_search']) {
      expect(toolRequiresChatId(tools.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown>), name).toBe(true)
    }
    await client.close()
  })
  test.each(['dm', 'ai'])('%s direct reply derives its recipient from the same-chat source and unique peer', async (kind) => {
    const h = harness(['agent-1', 'owner-1'])
    const restGet = h.deps.restGet
    const restRpc = h.deps.restRpc
    h.deps.restGet = async (path: string) => {
      if (path.startsWith('messages?id=eq.source-message&chat_id=eq.c1')) {
        return [{ chat_id: 'c1', sender_user_id: 'owner-1' }]
      }
      return restGet(path)
    }
    // @@@5856 kind 改从 chat_facts 这条按 actor 的 RPC 读(见 chatFactsOf 的注释)。
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => (
      name === 'chat_facts' ? [{ id: 'c1', kind, source_chat_id: null, group_prompt: null }] : restRpc(name, body, profile)
    )
    const client = await connect(h.deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: {
        chat_id: 'c1',
        reply_to_message_id: 'msg:source-message',
        text: 'ordinary reply',
      },
    })
    expect(result.isError).not.toBe(true)
    expect(h.calls.inserts).toHaveLength(1)
    expect(h.calls.inserts[0]?.[1]).toMatchObject({
      chat_id: 'c1',
      reply_to_message_id: 'source-message',
      to_user_ids: null,
    })
    await client.close()
  })
  test('group reply requires explicit recipients even when a source message exists', async () => {
    const h = harness(['agent-1', 'owner-1'])
    const restRpc = h.deps.restRpc
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => (
      name === 'chat_facts' ? [{ id: 'c1', kind: 'group', source_chat_id: null, group_prompt: null }] : restRpc(name, body, profile)
    )
    const client = await connect(h.deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', reply_to_message_id: 'msg:source-message', text: 'group reply' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('group chat requires explicit to_user_ids')
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  test('group: the same unaddressed send goes through without reply_to_message_id (the reply rule keys on it)', async () => {
    const h = harness(['agent-1', 'owner-1'])
    const restRpc = h.deps.restRpc
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => (
      name === 'chat_facts' ? [{ id: 'c1', kind: 'group', source_chat_id: null, group_prompt: null }] : restRpc(name, body, profile)
    )
    const client = await connect(h.deps)
    const result = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'group note' } })
    expect(result.isError).not.toBe(true)
    expect(h.calls.inserts).toHaveLength(1)
    expect(h.calls.inserts[0]?.[1]).toMatchObject({ chat_id: 'c1', reply_to_message_id: null })
    await client.close()
  })
  test.each([
    {
      name: 'source outside the chat',
      members: ['agent-1', 'owner-1'],
      source: [],
      error: 'must belong to this chat and its unique peer',
    },
    {
      name: 'non-unique peer membership',
      members: ['agent-1', 'owner-1', 'other-1'],
      source: [{ chat_id: 'c1', sender_user_id: 'owner-1' }],
      error: 'requires the current agent and one unique peer',
    },
  ])('exact DM reply fails before insertion for $name', async ({ members, source, error }) => {
    const h = harness(members)
    const restGet = h.deps.restGet
    const restRpc = h.deps.restRpc
    h.deps.restGet = async (path: string) => {
      if (path.startsWith('messages?id=eq.source-message&chat_id=eq.c1')) return source
      return restGet(path)
    }
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => (
      name === 'chat_facts' ? [{ id: 'c1', kind: 'dm', source_chat_id: null, group_prompt: null }] : restRpc(name, body, profile)
    )
    const client = await connect(h.deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: {
        chat_id: 'c1',
        reply_to_message_id: 'msg:source-message',
        text: 'ordinary reply',
      },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(error)
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  test('agent DM reply also validates its same-chat source and unique peer', async () => {
    const h = harness(['agent-1', 'owner-1', 'other-1'])
    const restGet = h.deps.restGet
    const restRpc = h.deps.restRpc
    h.deps.restGet = async (path: string) => {
      if (path.startsWith('messages?id=eq.source-message&chat_id=eq.c1')) return []
      return restGet(path)
    }
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => (
      name === 'chat_facts' ? [{ id: 'c1', kind: 'ai', source_chat_id: null, group_prompt: null }] : restRpc(name, body, profile)
    )
    const client = await connect(h.deps)
    const result = await client.callTool({
      name: 'message_send',
      arguments: {
        chat_id: 'c1',
        reply_to_message_id: 'msg:source-message',
        text: 'ordinary reply',
      },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires the current agent and one unique peer')
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  test('message_members / message_conversations / message_rules', async () => {
    const client = await connect(harness(['alice', 'bob'], 'be nice').deps)
    const members = JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1' } })))
    expect(members.items).toHaveLength(2)
    // 不带筛选时 total 就是人数(人和 agent 都算):只要人数,取一条就够。
    expect(JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1', rows: '1' } })))).toMatchObject({ total: 2, rows: '1-1', next: '2-2' })
    expect(JSON.parse(text(await client.callTool({ name: 'message_conversations', arguments: {} }))).items).toHaveLength(1)
    expect(JSON.parse(text(await client.callTool({ name: 'message_rules', arguments: { chat_id: 'c1' } }))).group_prompt).toBe('be nice')
    await client.close()
  })
  test('message_rules returns a one-time join history hint without gating the first send', async () => {
    const h = harness(['alice', 'bob'])
    // @@@5856 同上:只截 get_agent_join_context,kind / 成员名单交回底座桩。
    const baseRestRpc = h.deps.restRpc as (name: string, body: Record<string, unknown>, profile?: string) => Promise<unknown>
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string): Promise<unknown> => {
      h.calls.rpcs.push([name, body])
      if (name === 'get_agent_join_context') {
        return {
          joined_at: '2026-09-09T00:00:00Z',
          skipped_before_join: 3,
          before_seq: 4,
          first_pull: true,
        }
      }
      return baseRestRpc(name, body, profile)
    }
    const client = await connect(h.deps)
    const first = JSON.parse(text(await client.callTool({ name: 'message_rules', arguments: { chat_id: 'c1' } })))
    expect(first.join_context).toMatchObject({
      joined_at: '2026-09-09T00:00:00Z',
      skipped_before_join: 3,
      before_seq: 4,
    })
    expect(first.join_context.message_history.chat_id).toBe('c1')
    const second = JSON.parse(text(await client.callTool({ name: 'message_rules', arguments: { chat_id: 'c1' } })))
    expect(second.join_context).toBeUndefined()
    const sent = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: 'first reply without history' },
    })
    expect(sent.isError).not.toBe(true)
    await client.close()
  })
  test('profile_whoami（identity）/ profile_update（PATCH）', async () => {
    const h = harness()
    const client = await connect(h.deps)
    expect(JSON.parse(text(await client.callTool({ name: 'profile_whoami', arguments: {} }))).display_name).toBe('Agent')
    const u = await client.callTool({ name: 'profile_update', arguments: { bio: 'new bio' } })
    expect(text(u)).toMatch(/profile updated/)
    expect(h.calls.patches[0][1]).toEqual({ bio: 'new bio' })
    await client.close()
  })
  test('profile_whoami 带主人、所在的群与每个群里的角色/监听档;群按 agent 自己的成员行读(list_my_chats_as),❌ 直读 chat_members', async () => {
    const h = harness()
    // 主人退了 g-1 这个群、agent 还在:用主人令牌直读 chat_members 看不到它(读 RLS 按主人判),只有按 agent 判的 RPC 列得出来。
    const chats = [
      { chat_id: 'g-1', public_id: 201, kind: 'group', status: 'active', name: 'Owner left', role: 'member', listen_mode: 'active', last_message_at: null, last_message_preview: 'hi' },
      { chat_id: 'g-2', public_id: 202, kind: 'group', status: 'paused', name: 'Paused', role: 'admin', listen_mode: 'passive', last_message_at: null, last_message_preview: null },
      { chat_id: 'dm-1', public_id: 203, kind: 'dm', status: 'active', name: null, role: 'member', listen_mode: 'active', last_message_at: null, last_message_preview: null },
      { chat_id: 't-1', public_id: 204, kind: 'topic', status: 'active', name: 'A topic', role: 'member', listen_mode: 'active', last_message_at: null, last_message_preview: null },
    ]
    const reads: string[] = []
    const restGet = async (path: string) => {
      reads.push(path)
      if (path.startsWith('users?id=eq.owner-1&')) return [{ id: 'owner-1', display_name: 'Owner', gugu_number: 7 }]
      if (path.startsWith('users?id=eq.agent-1&')) return [{ gugu_number: 42, display_name: 'Agent', avatar: null, bio: null, owner_user_id: 'owner-1' }]
      // 置顶是主人自己的状态:只读主人自己那几行里置顶的(与界面 setChatPinned 写的是同一列)。
      if (path === 'chat_members?user_id=eq.owner-1&is_pinned=is.true&select=chat_id') return [{ chat_id: 'g-2' }]
      // #84 message_conversations 也列主人与好友的私聊(好友表是主人自己的);这里主人没有好友私聊,见 guguOwnerFriendDm84。
      if (path.startsWith('friendships?')) return []
      throw new Error(`unexpected direct read: ${path}`)
    }
    const rpcs: unknown[][] = []
    const restRpc = async (name: string, body: Record<string, unknown>) => {
      rpcs.push([name, body])
      if (name === 'list_my_chats_as') return body.p_as_user_id === 'agent-1' ? chats : []
      throw new Error(`unexpected rpc: ${name}`)
    }
    const client = await connect({ ...h.deps, restGet, restRpc })
    const me = JSON.parse(text(await client.callTool({ name: 'profile_whoami', arguments: {} })))
    expect(me).toEqual({
      user_id: 'user:agent-1',
      gugu_number: 42,
      display_name: 'Agent',
      avatar: null,
      bio: null,
      owner: { user_id: 'user:owner-1', display_name: 'Owner', gugu_number: 7 },
      groups: [
        { chat_id: 'g-1', public_id: 201, name: 'Owner left', status: 'active', role: 'member', listen_mode: 'active' },
        { chat_id: 'g-2', public_id: 202, name: 'Paused', status: 'paused', role: 'admin', listen_mode: 'passive' },
      ],
    })
    expect(rpcs).toEqual([['list_my_chats_as', { p_as_user_id: 'agent-1' }]])
    // message_conversations 与它同源:同一条 RPC,输出不多出 role / listen_mode;多一格主人的置顶。
    const conversations = JSON.parse(text(await client.callTool({ name: 'message_conversations', arguments: {} }))).items
    expect(conversations.map((row: { id: string }) => row.id)).toEqual(['g-1', 'g-2', 'dm-1', 't-1'])
    expect(conversations[0]).toEqual({ id: 'g-1', public_id: 201, kind: 'group', status: 'active', name: 'Owner left', pinned: false, last_message_at: null, last_message_preview: 'hi' })
    expect(conversations.map((row: { pinned: boolean }) => row.pinned)).toEqual([false, true, false, false])
    // agent 自己在哪些会话里仍只按 RPC 判;直读的只有主人自己的置顶那几行。
    expect(reads.filter((path) => path.includes('chat_members') || path.startsWith('chats')))
      .toEqual(['chat_members?user_id=eq.owner-1&is_pinned=is.true&select=chat_id'])
    const pinnedOnly = JSON.parse(text(await client.callTool({ name: 'message_conversations', arguments: { pinned: true } })))
    expect(pinnedOnly.items.map((row: { id: string }) => row.id)).toEqual(['g-2'])
    const topics = JSON.parse(text(await client.callTool({ name: 'message_conversations', arguments: { kind: 'topic' } })))
    expect(topics.items.map((row: { id: string }) => row.id)).toEqual(['t-1'])
    await client.close()
  })
  test('owner_friends_list joins friendships, human profiles, and owner remarks without private fields', async () => {
    const aliceId = '11111111-1111-4111-8111-111111111111'
    const legacyAgentId = '22222222-2222-4222-8222-222222222222'
    const zoeId = '33333333-3333-4333-8333-333333333333'
    const restGet = vi.fn(async (path: string) => {
      if (path.startsWith('friendships?')) {
        return [
          { user_a_id: 'owner-1', user_b_id: aliceId },
          { user_a_id: legacyAgentId, user_b_id: 'owner-1' },
          { user_a_id: 'owner-1', user_b_id: zoeId },
        ]
      }
      if (path.startsWith('users?id=in.(')) {
        return [
          { id: zoeId, display_name: 'Zoe', type: 'human', gugu_number: 9, avatar: 'zoe.png', bio: null, email: 'hidden@example.com', desired_status: 'online' },
          { id: legacyAgentId, display_name: 'Legacy Agent', type: 'agent', gugu_number: 10, avatar: null, bio: null },
          { id: aliceId, display_name: 'Alice', type: 'human', gugu_number: null, avatar: null, bio: 'A' },
        ]
      }
      if (path.startsWith('contact_overrides?')) {
        return [{ contact_user_id: zoeId, alias: '老周' }]
      }
      // 联系人置顶 = 主人和他那条私聊置顶。
      if (path === 'chat_members?user_id=eq.owner-1&is_pinned=is.true&select=chat_id') return [{ chat_id: 'dm-zoe' }, { chat_id: 'g-1' }]
      if (path === 'chats?id=in.(dm-zoe,g-1)&kind=eq.dm&select=id') return [{ id: 'dm-zoe' }]
      // 先筛到私聊,只读私聊里主人以外的那个人。g-1 是个群(Alice 也在里面),群置顶不是联系人置顶 ⇒ 根本不读它。
      if (path === 'chat_members?chat_id=in.(dm-zoe)&user_id=neq.owner-1&select=chat_id,user_id') {
        return [{ chat_id: 'dm-zoe', user_id: zoeId }]
      }
      throw new Error(`unexpected restGet path: ${path}`)
    })

    const rows = JSON.parse(await callTool('owner_friends_list', {}, { restGet })).items

    expect(restGet).toHaveBeenNthCalledWith(
      1,
      'friendships?or=(user_a_id.eq.owner-1,user_b_id.eq.owner-1)&select=user_a_id,user_b_id',
      'identity',
    )
    expect(restGet).toHaveBeenNthCalledWith(
      2,
      `users?id=in.(${aliceId},${legacyAgentId},${zoeId})&select=id,display_name,type,gugu_number,avatar,bio`,
      'identity',
    )
    expect(restGet).toHaveBeenNthCalledWith(
      3,
      'contact_overrides?owner_user_id=eq.owner-1&select=contact_user_id,alias',
      'identity',
    )
    expect(rows).toEqual([
      {
        user_id: `user:${aliceId}`,
        display_name: 'Alice',
        owner_remark: null,
        gugu_number: null,
        avatar: null,
        bio: 'A',
        pinned: false,
      },
      {
        user_id: `user:${zoeId}`,
        display_name: 'Zoe',
        owner_remark: '老周',
        gugu_number: 9,
        avatar: 'zoe.png',
        bio: null,
        pinned: true,
      },
    ])
    // 按备注名也找得到
    expect(JSON.parse(await callTool('owner_friends_list', { name: '老周' }, { restGet })).items.map((row: { display_name: string }) => row.display_name)).toEqual(['Zoe'])
    expect(JSON.stringify(rows)).not.toMatch(/email|online_status|desired_status/)
  })
  test('退役的胖工具名(gugu_message/gugu_conv/…/gugu_thread)调用 fail loud 且不写消息/命令', async () => {
    const h = harness()
    const client = await connect(h.deps)
    for (const retiredName of [
      'gugu_message', 'gugu_conv', 'gugu_profile', 'gugu_peers', 'gugu_file', 'gugu_workspace',
      'gugu_ask', 'gugu_widget', 'gugu_thread',
    ]) {
      const retired = await client.callTool({ name: retiredName, arguments: { action: 'send', chat_id: 'c1', text: 'topic' } })
      expect(retired.isError, retiredName).toBe(true)
    }
    expect(h.calls.inserts).toHaveLength(0)
    expect(h.calls.rpcs).toHaveLength(0)
    await client.close()
  })
  // 摩擦单 F40:app_install { chat_id, data } 建群里的数据文件 —— 以 agent 本人建,判据和上传同一个;同名已有就留着用。
  test('groupDataFileOf: makes the data file as the agent, keeps one already there, refuses a .json that is not an object', async () => {
    const h = harness()
    const made = await groupDataFileOf(TEST_CONTEXT, { chatId: 'c1', name: 'friday.vote.json', content: { question: 'Friday?', votes: {} } }, h.deps)
    const body = h.calls.rpcs.find(([name]) => name === 'workspace_create_document_as')?.[1] as Record<string, unknown>
    expect(body).toMatchObject({ p_chat_id: 'c1', p_title: 'friday.vote.json', p_content_type: 'application/json', p_as_user_id: 'agent-1' })
    expect(JSON.parse(String(body.p_content))).toEqual({ question: 'Friday?', votes: {} })
    expect(made).toMatchObject({ item: { id: W_NEW }, link: `[friday.vote.json](gugu-file://${W_NEW})`, reused: false })
    // A reinstall after a fix: brief.md is already there under that name — kept, nothing made.
    const creates = h.calls.rpcs.filter(([name]) => name === 'workspace_create_document_as').length
    const kept = await groupDataFileOf(TEST_CONTEXT, { chatId: 'c1', name: 'brief.md', content: 'new text' }, h.deps)
    expect(kept).toMatchObject({ item: { id: W_DOC }, reused: true })
    expect(h.calls.rpcs.filter(([name]) => name === 'workspace_create_document_as')).toHaveLength(creates)
    // An App's data file is at the top (子文件夹): looked for there only, by its name as the database keeps names (p_exact).
    expect(h.calls.rpcs.filter(([name]) => name === 'workspace_list_as').at(-1)?.[1]).toMatchObject({ p_folder: '', p_name: 'brief.md', p_exact: true })
    expect(await groupDataFileOf(TEST_CONTEXT, { chatId: 'c1', name: 'Brief.MD', content: 'new text' }, h.deps)).toMatchObject({ item: { id: W_DOC }, reused: true })
    expect(h.calls.rpcs.filter(([name]) => name === 'workspace_create_document_as')).toHaveLength(creates)
    await expect(groupDataFileOf(TEST_CONTEXT, { chatId: 'c1', name: 'list.vote.json', content: [1, 2] }, h.deps))
      .rejects.toThrow('the data file list.vote.json was not made: a JSON file lives as an object at the top ({...}); this one is not')
  })
  // 摩擦单 F102(S20):数据已经在群里(B 上传的 catalog.json)—— 用那个文件本身,以 agent 本人读;❌ 另建一份、❌ 抄进包。
  test('groupDataFileOf { itemId }: the file already in the group, read as the agent, nothing made — another chat\'s or a stored file refused', async () => {
    const h = harness()
    const there = await groupDataFileOf(TEST_CONTEXT, { chatId: 'c1', itemId: W_DOC }, h.deps)
    expect(there).toMatchObject({ item: { id: W_DOC, filename: 'brief.md' }, link: `[brief.md](gugu-file://${W_DOC})`, reused: true })
    expect(h.calls.rpcs.find(([name]) => name === 'workspace_get_as')?.[1]).toMatchObject({ p_item_id: W_DOC, p_as_user_id: 'agent-1' })
    expect(h.calls.rpcs.filter(([name]) => name === 'workspace_create_document_as')).toHaveLength(0)
    await expect(groupDataFileOf(TEST_CONTEXT, { chatId: 'c1', itemId: W_OTHER }, h.deps)).rejects.toThrow(`data.item_id ${W_OTHER} is a file of another chat, not c1`)
    await expect(groupDataFileOf(TEST_CONTEXT, { chatId: 'c1', itemId: W_FILE }, h.deps)).rejects.toThrow('(deck.pdf) is a stored file, not a document an App opens')
  })
  // 摩擦单 F10:名字里的方括号会提前截断 markdown 链接文字 —— 转义掉,链接仍是一整条。
  test('workspaceFileLink escapes brackets in the name', () => {
    expect(workspaceFileLink({ filename: 'a]b[c.md', chat_id: 'c1', id: W_DOC })).toBe(String.raw`[a\]b\[c.md](gugu-file://` + `${W_DOC})`)
  })
  // 摩擦单 F15(L7-d):app_pack { chat_id } 打完包就以卡片发进群 —— 走的就是 message_send_file 这条路,以 agent 本人发。
  // F31(L5 S1 第三轮):同一版本带 chat_id 再装一次,又发了一张卡。一张卡是一个 App 的一个版本:群里已有同名(<id>-<版本>)
  // 的卡就不再发,答那条消息;同版本字节却不同(改了 App 没升版本)也不发,并说出来;升了版本照常发。id 一律裸的(工具层编码一次)。
  test('sendExtensionCardOf: sends a card once per version — same version again answers the first card, a new version sends', async () => {
    const h = harness()
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const deps = {
      ...h.deps,
      // The group's messages as the harness stored them: the newest first, like the query asks.
      restGet: async (path: string): Promise<Array<Record<string, unknown>>> => path.startsWith('messages?chat_id=eq.c1&content_type=eq.attachment')
        ? h.calls.inserts.map(([, row]) => row as Record<string, unknown>).filter((row) => row.content_type === 'attachment').reverse()
        : h.deps.restGet(path),
      // A card's bytes, as the signed link serves them back.
      fetch: async (url: string) => {
        const upload = h.calls.uploads.find(([, objectPath]) => url.endsWith(String(objectPath)))
        return new Response(upload ? new Uint8Array(upload[3] as Uint8Array) : null, { status: upload ? 200 : 404 })
      },
    }
    const send = (fileName: string, bytes: string) =>
      sendExtensionCardOf(TEST_CONTEXT, { chatId: 'c1', filePath: fixtureFile(fileName, bytes), fileName, sha256: sha(bytes) }, deps)

    const first = await send('dinner-vote-1.0.0.guguext', 'v1-bytes')
    const row = h.calls.inserts[0][1] as Record<string, unknown>
    expect(first).toEqual({ messageId: String(row.id), alreadyThere: false, differs: false })
    // The card is drawn from the archive type, which the .guguext name gives — the same thing the chat's install reads.
    expect(h.calls.uploads[0][2]).toBe('application/vnd.gugu.extension+zip')
    expect(String(row.content)).toContain('[附件] dinner-vote-1.0.0.guguext (application/vnd.gugu.extension+zip)')

    // Same version, same bytes: nothing sent, the first card answered.
    expect(await send('dinner-vote-1.0.0.guguext', 'v1-bytes')).toEqual({ messageId: String(row.id), alreadyThere: true, differs: false })
    // Same version, other bytes (the App changed, its version did not): still nothing sent — and said.
    expect(await send('dinner-vote-1.0.0.guguext', 'v1-edited')).toEqual({ messageId: String(row.id), alreadyThere: true, differs: true })
    // Its bytes cannot be read back: answered as there, contents unknown — never a second card on a guess.
    const unreadable = await sendExtensionCardOf(
      TEST_CONTEXT,
      { chatId: 'c1', filePath: fixtureFile('again.guguext', 'v1-bytes'), fileName: 'dinner-vote-1.0.0.guguext', sha256: sha('v1-bytes') },
      { ...deps, fetch: async () => new Response(null, { status: 503 }) },
    )
    expect(unreadable).toEqual({ messageId: String(row.id), alreadyThere: true, differs: null })
    expect(h.calls.inserts).toHaveLength(1)
    expect(h.calls.uploads).toHaveLength(1)

    // A new version is a new card.
    const upgraded = await send('dinner-vote-1.1.0.guguext', 'v2-bytes')
    expect(h.calls.inserts).toHaveLength(2)
    expect(upgraded).toEqual({ messageId: String((h.calls.inserts[1][1] as Record<string, unknown>).id), alreadyThere: false, differs: false })
  })
  test('message_send_file → 字节经 attachments/upload 传到 OSS,commit 以 agent 本人发附件消息(#7290)', async () => {
    const h = harness()
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_send_file', arguments: { chat_id: 'c1', file_name: 'a b.png', file_path: fixtureFile('src.png', Buffer.from([1, 2, 3])), mime_type: 'image/png' } })
    expect(JSON.parse(text(r))).toMatchObject({ status: 'sent', file_name: 'a b.png', source_link: expect.stringMatching(/^gugu-chat:\/\/c1\//) })
    expect(h.calls.uploads[0][0]).toBe('oss')
    const row = h.calls.inserts[0][1] as Record<string, unknown>
    expect(row).toMatchObject({ content_type: 'attachment', chat_id: 'c1', sender_user_id: 'agent-1', file_item_id: `item:${String(h.calls.uploads[0][1])}` })
    expect(String(row.content)).toContain('[附件] a b.png')
    await client.close()
  })
  // 「PNG 有时渲染有时不渲染」:agent 这次带没带 mime_type 不该决定它是图还是文件卡片。
  test.each([
    ['不带 mime_type', undefined],
    ['大写 mime_type', 'Image/PNG'],
    ['泛二进制 mime_type', 'application/octet-stream'],
  ])('message_send_file → .png %s 仍记成 image/png 图片', async (_label, mimeType) => {
    const h = harness()
    const client = await connect(h.deps)
    const args: Record<string, unknown> = { chat_id: 'c1', file_path: fixtureFile('chart.PNG', Buffer.from([1, 2, 3])) }
    if (mimeType) args.mime_type = mimeType
    const r = await client.callTool({ name: 'message_send_file', arguments: args })
    expect(JSON.parse(text(r)).status).toBe('sent')
    expect(h.calls.uploads[0][2]).toBe('image/png')
    const content = String((h.calls.inserts[0][1] as Record<string, unknown>).content)
    expect(content).toContain('[附件] chart.PNG (image/png)')
    expect(content).toContain('[Kind] image')
    await client.close()
  })
  // #5828 的判据：传上去的字节必须和盘上那个文件逐字节相同。
  // 旧实现把内容当 content_base64 参数收，调用方（模型）要逐 token 复制那串编码，
  // 漂一次后面全部错位——实测 16 KB 的 HTML 毁掉 60%，而且两侧都不报错。
  test('message_send_file → 上传的字节与盘上文件逐字节相同', async () => {
    const h = harness()
    const client = await connect(h.deps)
    const payload = Buffer.concat([
      Buffer.from('咕咕 #5828 字节保真\n', 'utf8'),
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)), // 全部 256 个字节值，含 0x00 与控制字符
    ])
    const src = fixtureFile('payload.bin', payload)
    const r = await client.callTool({
      name: 'message_send_file',
      arguments: { chat_id: 'c1', file_path: src, mime_type: 'application/octet-stream' },
    })
    expect(JSON.parse(text(r)).status).toBe('sent')
    const sent = h.calls.uploads[0][3] as Buffer
    expect(Buffer.isBuffer(sent)).toBe(true)
    expect(sent.equals(payload)).toBe(true)
    expect(sent.equals(readFileSync(src))).toBe(true)
    const row = h.calls.inserts[0][1] as Record<string, unknown>
    expect(String(row.content)).toContain(`[Size] ${payload.length}`)
    await client.close()
  })
  // 中文名分两处，别混：**用户看到的附件名**保留中文；**存储对象键**必须消成 ASCII——
  // Supabase Storage 对非 ASCII 的 key 直接 400 InvalidKey（#5828 对着本地栈实测过）。
  test('message_send_file → 附件名保留中文(存的名字是服务端按内容起的,不再由这里拼)', async () => {
    const h = harness()
    const client = await connect(h.deps)
    const src = fixtureFile('咕咕的资本叙事与竞品地图.html', '<p>x</p>')
    const r = await client.callTool({
      name: 'message_send_file',
      arguments: { chat_id: 'c1', file_path: src, mime_type: 'text/html' },
    })
    expect(JSON.parse(text(r)).status).toBe('sent')
    // 不给 file_name，就用盘上那个名字——用户看到的是中文原文
    const row = h.calls.inserts[0][1] as Record<string, unknown>
    expect(String(row.content)).toContain('[附件] 咕咕的资本叙事与竞品地图.html')
    await client.close()
  })
  test.each([
    ['缺 file_path', {}, /file_path/],
    ['相对路径', { file_path: 'relative/report.html' }, /must be absolute/],
    ['文件不存在', { file_path: '/nonexistent-5828/report.html' }, /cannot read/],
  ])('message_send_file 拒绝 %s，且不上传、不插消息', async (_label, extra, pattern) => {
    const h = harness()
    const err = await callTool('message_send_file', { chat_id: 'c1', ...extra }, h.deps)
      .then(() => null, (e: unknown) => e)
    expect(String((err as Error)?.message ?? err)).toMatch(pattern)
    expect(h.calls.uploads).toHaveLength(0)
    expect(h.calls.inserts).toHaveLength(0)
  })
  test.each([
    ['3 字节', 3],
    ['0 字节', 0],
  ])('message_send_file 尺寸按盘上真实文件算（%s）', async (_label, size) => {
    const h = harness()
    const client = await connect(h.deps)
    const args: Record<string, unknown> = {
      chat_id: 'c1',
      file_name: 'report.pdf',
      file_path: fixtureFile('report.pdf', Buffer.alloc(size)),
      mime_type: 'application/pdf',
    }
    const result = await client.callTool({ name: 'message_send_file', arguments: args })
    expect(result.isError).not.toBe(true)
    const row = h.calls.inserts[0][1] as Record<string, unknown>
    // 新式信封:[附件] / [Size] / [Kind] 三行(没有 [URL],字节由消息指着的条目给)。
    expect(String(row.content).split('\n')).toHaveLength(3)
    expect(String(row.content)).toContain(`[Size] ${size}`)
    expect(row.file_item_id).toBe(`item:${String(h.calls.uploads[0][1])}`)
    await client.close()
  })
  test('message_send_file → commit 被拒:报错原话,没有消息(没提交的上传在服务端过期回收,这里不清)', async () => {
    const h = harness()
    h.failCommit(new Error('the group only lets admins send files'))
    const client = await connect(h.deps)
    const result = await client.callTool({
      name: 'message_send_file',
      arguments: { chat_id: 'c1', file_name: 'report.pdf', file_path: fixtureFile('report.pdf') },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the group only lets admins send files')
    expect(h.calls.uploads).toHaveLength(1)
    expect(h.calls.inserts).toHaveLength(0)
    await client.close()
  })
  test('名字只是标签(B5b):message_send_file 按盘上文件定类型,图照样是图', async () => {
    const h = harness()
    await callTool('message_send_file', { chat_id: 'c1', file_path: fixtureFile('chart.png', Buffer.from([1, 2, 3])), file_name: '销售图 v2.0' }, h.deps)
    expect(h.calls.uploads[0][2]).toBe('image/png')
    expect(String((h.calls.inserts[0][1] as Record<string, unknown>).content)).toContain('[附件] 销售图 v2.0 (image/png)')
  })

  test('message_send_file:回答丢了 ⇒ 同一次上传、同一个消息 id 重放,只出一条消息;服务端明确拒的(4xx)不重放', async () => {
    const h = harness()
    h.loseCommitAnswers(1)
    const sent = await callTool('message_send_file', { chat_id: 'c1', file_path: fixtureFile('lost.png', Buffer.from([1, 2, 3])) }, h.deps)
    expect(h.commitBodies).toHaveLength(2)
    expect(h.commitBodies[1]).toEqual(h.commitBodies[0])
    expect(h.calls.inserts).toHaveLength(1)
    expect(JSON.parse(sent)).toMatchObject({ status: 'sent', message_id: `msg:${String(h.commitBodies[0]!.message_id)}`, source_link: `gugu-chat://c1/${String(h.commitBodies[0]!.message_id)}` })
    const refused = harness()
    refused.failCommit(new Error('the group only lets admins send files'))
    await expect(callTool('message_send_file', { chat_id: 'c1', file_path: fixtureFile('no.png', Buffer.from([1])) }, refused.deps)).rejects.toThrow(/only lets admins/)
    expect(refused.commitBodies).toHaveLength(1)
  })

  test('file tools reject payloads above their backend object limits before upload', async () => {
    const h = harness()
    const chatResult = await callTool('message_send_file', {
      chat_id: 'c1',
      file_name: 'too-large.bin',
      file_path: sparseFixture('too-large.bin', (25 * 1024 * 1024) + 1),
    }, h.deps)
      .then(() => null, (error: unknown) => error)
    expect(chatResult).toEqual(expect.objectContaining({ message: expect.stringContaining('26214400 bytes') }))
    expect(h.calls.uploads).toHaveLength(0)
  })
  // #1244 thread 归属由会话决定:message_send 没有 thread_root_id 这个参数。写类不认识的键直接拒、点名报回去,
  // ❌ 静默删掉照发(那样模型以为自己指定了 thread)。
  test.each([
    ['send', { chat_id: 'c1', text: 'hi', thread_root_id: 'msg:OTHER-THREAD' }],
    ['reply', { chat_id: 'c1', text: 'ok', reply_to_message_id: 'msg:m1', to_user_ids: ['user:alice'], thread_root_id: 'msg:OTHER-THREAD' }],
  ])('%s: thread_root_id is not a parameter — refused by name, nothing written (#1244)', async (_, args) => {
    const h = harness(['alice'])
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_send', arguments: args })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/不认识的参数 thread_root_id;合法参数:chat_id、to_user_ids、reply_to_message_id、whisper、text/)
    expect(h.calls.inserts).toHaveLength(0)
  })
})
describe('restRpc void/空 body 容忍 (#1216)', () => {
  const withFetch = async (impl: () => unknown, fn: () => Promise<void>) => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => impl()) as unknown as typeof fetch
    try { await fn() } finally { globalThis.fetch = orig }
  }
  test('204/空 body → null（不在空 body 上 JSON.parse）', async () => {
    await withFetch(() => ({ ok: true, status: 204, text: async () => '', json: async () => { throw new Error('不应调用 json()') } }), async () => {
      await expect(restRpc('retired_probe', {})).resolves.toBeNull()
    })
  })
  test('非空 body → 正常解析', async () => {
    await withFetch(() => ({ ok: true, status: 200, text: async () => '{"x":1}' }), async () => {
      await expect(restRpc('some_rpc', {})).resolves.toEqual({ x: 1 })
    })
  })
  test('!ok → 抛错（含 status）', async () => {
    await withFetch(() => ({ ok: false, status: 403, text: async () => 'denied' }), async () => {
      await expect(restRpc('x', {})).rejects.toThrow(/403/)
    })
  })
})
type DirectoryRow = { user_id: string; display_name: string; type: string | null; gugu_number: number | null; is_self: boolean }
describe('message_members = 可寻址名录(spec ⑨)', () => {
  function directoryHarness() {
    const h = harness(['agent-1', 'codex-8-id', 'owner-1'])
    const orig = h.deps.restGet
    h.deps.restGet = async (p: string) => {
      if (p.startsWith('users?id=in')) {
        return [
          { id: 'agent-1', display_name: 'Codex 1', type: 'agent', gugu_number: 1001 },
          { id: 'codex-8-id', display_name: 'Codex 8', type: 'agent', gugu_number: 1008 },
          { id: 'owner-1', display_name: '老板', type: 'human', gugu_number: 7 },
        ]
      }
      return orig(p)
    }
    return h
  }
  test('成员名单带 display_name / type / 咕咕号 → 可按名字反查 user_id', async () => {
    const client = await connect(directoryHarness().deps)
    const rows = JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1' } }))).items as DirectoryRow[]
    const byName = new Map(rows.map((r) => [r.display_name, r]))
    expect(byName.get('Codex 8')?.user_id).toBe('user:codex-8-id')
    expect(byName.get('Codex 8')?.type).toBe('agent')
    expect(byName.get('Codex 8')?.gugu_number).toBe(1008)
    expect(byName.get('老板')?.type).toBe('human')
    await client.close()
  })
  test('标出 is_self,agent 不会把自己当收件人', async () => {
    const client = await connect(directoryHarness().deps)
    const rows = JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1' } }))).items as DirectoryRow[]
    expect(rows.find((r) => r.user_id === 'user:agent-1')?.is_self).toBe(true)
    expect(rows.find((r) => r.user_id === 'user:codex-8-id')?.is_self).toBe(false)
    await client.close()
  })
  // 状态两种来源写在行上:跑在这台机器上的读宿主按 agent 的状态流;其余只有云端 presence,是它的宿主发布的副本。
  test('agent 行带运行状态:本机的读宿主,其余读云端并写明来源、时刻与那台宿主在不在线;可按类型与状态筛', async () => {
    const h = directoryHarness()
    const baseRpc = h.deps.restRpc
    const presenceAsked: unknown[] = []
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string): Promise<unknown> => {
      if (name === 'get_agent_presence_batch') {
        presenceAsked.push(body.p_agent_user_ids)
        return {
          results: {
            'codex-8-id': {
              status: 'presence',
              // 宿主刚退出的样子:agent 行刚写过(derived_status 还说在线),设备行已经离线 ⇒ host_online 看设备行。
              presence: { agent_status: 'needs_user', agent_status_detail: 'approval', updated_at: '2026-09-26T10:00:00.000Z', derived_status: 'online', device_status: 'offline' },
            },
          },
        }
      }
      return baseRpc(name, body, profile)
    }
    const hostAsked: unknown[] = []
    const client = await connect({
      ...h.deps,
      callSessionHost: async (action: unknown) => {
        hostAsked.push(action)
        return [{ agentUserId: 'agent-1', status: 'working', detail: 'running' }]
      },
    })
    const members = async (args: Record<string, unknown>) =>
      JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1', ...args } }))) as {
        total: number; items: Array<Record<string, unknown>>
      }
    const all = await members({})
    const byName = new Map(all.items.map((row) => [row.display_name, row]))
    expect(byName.get('Codex 1')).toMatchObject({ status: 'working', detail: 'running', status_from: 'this_machine' })
    expect(byName.get('Codex 1')).not.toHaveProperty('status_at')
    expect(byName.get('Codex 8')).toMatchObject({
      status: 'needs_user', detail: 'approval', status_from: 'cloud', status_at: '2026-09-26T10:00:00.000Z', host_online: false,
    })
    expect(byName.get('老板')).not.toHaveProperty('status')
    // 本机有读数的不再去问云端
    expect(hostAsked[0]).toEqual({ action: 'agent-status', agentUserIds: ['agent-1', 'codex-8-id'] })
    expect(presenceAsked[0]).toEqual(['codex-8-id'])
    // 按名字排:翻页有确定的顺序
    expect(all.items.findIndex((row) => row.display_name === 'Codex 1')).toBeLessThan(all.items.findIndex((row) => row.display_name === 'Codex 8'))

    expect((await members({ status: 'approval' })).items.map((row) => row.display_name)).toEqual(['Codex 8'])
    expect((await members({ status: 'working' })).items.map((row) => row.display_name)).toEqual(['Codex 1'])
    expect((await members({ type: 'human' })).items.map((row) => row.display_name)).toEqual(['老板'])
    expect((await members({ type: 'agent' })).total).toBe(2)
    await client.close()
  })
  // host_online 只看设备行(#5912 的在线唯一来源):agent 行久没写过(derived_status 离线)而设备在线,那台机器就是在线。
  test('云端行的 host_online 跟设备行走,不跟 agent 行的 last_seen 走', async () => {
    const h = directoryHarness()
    const baseRpc = h.deps.restRpc
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string): Promise<unknown> => {
      if (name === 'get_agent_presence_batch') {
        return { results: { 'codex-8-id': { status: 'presence', presence: {
          agent_status: null, agent_status_detail: null, updated_at: '2026-09-26T10:00:00.000Z', derived_status: 'offline', device_status: 'online',
        } } } }
      }
      return baseRpc(name, body, profile)
    }
    const client = await connect({ ...h.deps, callSessionHost: async () => [] })
    const rows = JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1' } }))).items as Array<Record<string, unknown>>
    expect(rows.find((row) => row.display_name === 'Codex 8')).toMatchObject({ status_from: 'cloud', host_online: true })
    await client.close()
  })
  // 状态是名录的附加信息:读不到时名录照给(寻址靠它),原因写在返回里,❌ 整张失败,也 ❌ 悄悄当没有。
  test('状态读不到时名录照给,返回里写明哪一路读不到;写错的状态词即使一个都筛不中也响亮地拒', async () => {
    const h = directoryHarness()
    const baseRpc = h.deps.restRpc
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string): Promise<unknown> => {
      if (name === 'get_agent_presence_batch') throw new Error('command RPC HTTP 503')
      return baseRpc(name, body, profile)
    }
    const client = await connect({ ...h.deps, callSessionHost: async () => { throw new Error('host bridge closed') } })
    const out = JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1' } })))
    expect(out.total).toBe(3)
    expect(out.items.map((row: DirectoryRow) => row.display_name).sort()).toEqual(['Codex 1', 'Codex 8', '老板'])
    expect(out.status_unavailable).toContain('this machine: host bridge closed')
    expect(out.status_unavailable).toContain('cloud presence: command RPC HTTP 503')
    for (const row of out.items) expect(row).not.toHaveProperty('status')

    const typo = await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1', name: 'nobody', status: 'ready' } })
    expect(typo.isError).toBe(true)
    expect(text(typo)).toContain('status must be one of idle, working')
    await client.close()
  })
  test('空群零额外查询(不打 identity)', async () => {
    const h = harness([])
    const paths: string[] = []
    const orig = h.deps.restGet
    h.deps.restGet = async (p: string) => { paths.push(p); return orig(p) }
    const client = await connect(h.deps)
    expect(JSON.parse(text(await client.callTool({ name: 'message_members', arguments: { chat_id: 'c1' } })))).toEqual({ total: 0, rows: null, next: null, items: [] })
    expect(paths.some((p) => p.startsWith('users?id=in'))).toBe(false)
    await client.close()
  })
})
// 一条 URL 里带的 id 有上限(共享测试库实测 80 个 UUID 通、100 个 502 Bad Gateway)⇒ 大群、好友多的主人都要按批读。
describe('id 列表不整张拼进一条 URL:每条读 ≤ IN_LIST_BATCH 个 id', () => {
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  // 取 `<column>=in.(…)` 括号里的 id(不用正则:括号与点都要转义,抄错了判据就读错对象)。
  const idsIn = (path: string, column: string) => {
    const head = `${column}=in.(`
    const start = path.indexOf(head)
    if (start < 0) return []
    const from = start + head.length
    return path.slice(from, path.indexOf(')', from)).split(',').filter(Boolean).map(decodeURIComponent)
  }
  const big = Array.from({ length: 120 }, (_, i) => uid(i + 1))

  test('判据本身会红:一条带 120 个 id 的读超过上限', () => {
    expect(IN_LIST_BATCH).toBeLessThan(80)
    expect(idsIn(`users?id=in.(${big.join(',')})&select=id`, 'id').length).toBeGreaterThan(IN_LIST_BATCH)
  })

  function bigGroup() {
    const h = harness(big)
    const userReads: string[] = []
    const orig = h.deps.restGet
    h.deps.restGet = async (path: string) => {
      if (path.startsWith('users?id=in.(')) {
        userReads.push(path)
        return idsIn(path, 'id').map((id) => ({ id, display_name: `Member ${id.slice(-3)}`, type: 'human', gugu_number: null }))
      }
      return orig(path)
    }
    return { h, userReads }
  }

  test('message_members:120 人的群按批读身份,total 是全部人数', async () => {
    const { h, userReads } = bigGroup()
    const out = JSON.parse(await callTool('message_members', { chat_id: 'c1', rows: '1' }, h.deps))
    expect(out.total).toBe(120)
    expect(userReads).toHaveLength(Math.ceil(120 / IN_LIST_BATCH))
    for (const path of userReads) expect(idsIn(path, 'id').length).toBeLessThanOrEqual(IN_LIST_BATCH)
    expect(new Set(userReads.flatMap((path) => idsIn(path, 'id')))).toEqual(new Set(big))
  })

  test('message_send:在 120 人的群里点名,核 @ 用的成员身份也按批读', async () => {
    const { h, userReads } = bigGroup()
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: [`user:${big[0]}`] } })
    expect(text(r)).toMatch(/^sent/)
    expect(userReads.length).toBeGreaterThan(1)
    for (const path of userReads) expect(idsIn(path, 'id').length).toBeLessThanOrEqual(IN_LIST_BATCH)
    await client.close()
  })

  test('owner_friends_list:120 个好友按批读身份;置顶那一路每条 URL 也只带一批 id', async () => {
    const pinnedDms = Array.from({ length: 60 }, (_, i) => `dm-${i}`)
    const reads: string[] = []
    const restGet = vi.fn(async (path: string) => {
      reads.push(path)
      if (path.startsWith('friendships?')) return big.map((id) => ({ user_a_id: 'owner-1', user_b_id: id }))
      if (path.startsWith('users?id=in.(')) {
        return idsIn(path, 'id').map((id) => ({ id, display_name: `Friend ${id.slice(-3)}`, type: 'human', gugu_number: null, avatar: null, bio: null }))
      }
      if (path.startsWith('contact_overrides?')) return []
      if (path === 'chat_members?user_id=eq.owner-1&is_pinned=is.true&select=chat_id') return pinnedDms.map((chat_id) => ({ chat_id }))
      if (path.startsWith('chats?id=in.(')) return idsIn(path, 'id').map((id) => ({ id }))
      if (path.startsWith('chat_members?chat_id=in.(')) {
        return idsIn(path, 'chat_id').map((chatId) => ({ chat_id: chatId, user_id: big[Number(chatId.slice(3))] }))
      }
      throw new Error(`unexpected restGet path: ${path}`)
    })
    const out = JSON.parse(await callTool('owner_friends_list', { rows: '1-200' }, { restGet }))
    expect(out.total).toBe(120)
    expect(out.items.filter((row: { pinned: boolean }) => row.pinned)).toHaveLength(60)
    for (const path of reads.filter((p) => p.includes('=in.('))) {
      const column = path.startsWith('chat_members') ? 'chat_id' : 'id'
      expect(idsIn(path, column).length, path.slice(0, 40)).toBeLessThanOrEqual(IN_LIST_BATCH)
      expect(path.match(/=in\./g)).toHaveLength(1)
    }
    expect(reads.filter((p) => p.startsWith('users?id=in.('))).toHaveLength(Math.ceil(120 / IN_LIST_BATCH))
  })
})
describe('MCP 工具对外声明的入参 schema', () => {
  const MESSAGE_REFERENCE_FIELDS = new Set([
    'reply_to_message_id',
    'source_message_id',
    'source_message_ids',
    'thread_root_id',
  ])
  function isAgentOwnedMessageIdField(field: string): boolean {
    const normalized = field.toLowerCase()
    if (MESSAGE_REFERENCE_FIELDS.has(normalized)) return false
    if (normalized === 'message_id') return true
    if (/^(?:client|request|idempotency|deduplication)(?:_|$).*(?:id|key)$/.test(normalized)) return true
    return /^(?:outgoing|sent|own|self)_message_id$/.test(normalized)
  }
  function findAgentOwnedMessageIdFields(schema: unknown, path: string[] = []): string[] {
    if (!schema || typeof schema !== 'object') return []
    const record = schema as Record<string, unknown>
    const found: string[] = []
    const properties = record.properties
    if (properties && typeof properties === 'object') {
      for (const [field, child] of Object.entries(properties as Record<string, unknown>)) {
        const childPath = [...path, field]
        if (isAgentOwnedMessageIdField(field)) found.push(childPath.join('.'))
        found.push(...findAgentOwnedMessageIdFields(child, childPath))
      }
    }
    for (const key of ['items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf']) {
      const child = record[key]
      if (Array.isArray(child)) {
        for (const entry of child) found.push(...findAgentOwnedMessageIdFields(entry, path))
      } else {
        found.push(...findAgentOwnedMessageIdFields(child, path))
      }
    }
    return found
  }
  test('all MCP input schemas forbid agent-owned message identifiers while allowing source references', async () => {
    const server = createGuguImServer({})
    registerGuguSessionTools(server, undefined, passThrough)
    registerGuguExtensionTools(server, undefined, passThrough)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'message-id-schema-probe', version: '1' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const { tools } = await client.listTools()
    const violations = tools.flatMap((tool) =>
      findAgentOwnedMessageIdFields(tool.inputSchema)
        // This is an existing admission record to decide, rather than a caller-created message ID.
        .filter((field) => !(tool.name === 'group_join_decide' && field === 'request_id'))
        .map((field) => `${tool.name}.${field}`),
    )
    expect(violations).toEqual([])
    const reply = tools.find((tool) => tool.name === 'message_send')
    expect(findAgentOwnedMessageIdFields(reply?.inputSchema)).toEqual([])
    expect((reply?.inputSchema as { properties?: Record<string, unknown> }).properties?.reply_to_message_id).toBeTruthy()
    await client.close()
  })
  test('chat 工具的对外 schema 都显式要求 chat_id', async () => {
    const server = createGuguImServer({})
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'schema-probe', version: '1' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const { tools } = await client.listTools()
    for (const name of ['message_send', 'message_history', 'message_search', 'message_members', 'message_rules', 'message_send_file']) {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool, `${name} 在工具表里`).toBeTruthy()
      expect(toolRequiresChatId(tool?.inputSchema as Record<string, unknown>), name).toBe(true)
    }
    await client.close()
  })
  test('route provenance names the delivery envelope, without restating the discipline', async () => {
    const server = createGuguImServer({})
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'route-provenance-probe', version: '1' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const tools = (await client.listTools()).tools
    const send = tools.find((tool) => tool.name === 'message_send')
    expect(JSON.stringify(send?.inputSchema ?? {})).toContain('gugu_delivery envelope')
    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toContain('Answer on the channel')
      expect(JSON.stringify(tool.inputSchema ?? {}), tool.name).not.toContain('Answer on the channel')
    }
    await client.close()
  })
  test('provider-neutral message tool metadata contract', async () => {
    const server = createGuguImServer({})
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'metadata-probe', version: '1' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const tools = (await client.listTools()).tools
    const send = tools.find((tool) => tool.name === 'message_send')
    expect(send?.description).toBeTruthy()
    expect(send?.description).toContain('reply_to_message_id')
    expect(send?.description).toContain('session_message')
    expect(send?.description).toContain('multiple distinct calls')
    // #6192:harness 的名字装饰不在工具描述里 —— 它由会话自述块按这一家的能力声明渲染。
    expect(send?.description).not.toMatch(/mcp__|gugu_<tool>/)
    const history = tools.find((tool) => tool.name === 'message_history')
    expect(history?.description).toContain('main timeline')
    expect((history?.inputSchema as { properties?: Record<string, unknown> })?.properties?.thread_root_id).toBeTruthy()
    expect(history?.description).not.toContain('session-bound thread_root_id')
    for (const def of TOOL_DEFS as Array<{ name: string; description: string }>) {
      expect(def.description, def.name).not.toMatch(/exactly once|only tool|must reply|must send|immediately|first call|never guess|never assume|obligatory|rejected once|send separate|at least one|必须回复|立即回复|只能调用|必须发送/i)
    }
    const schema = send?.inputSchema as Record<string, unknown>
    expect(schema.oneOf).toBeUndefined()
    expect(schema.anyOf).toBeUndefined()
    expect([...(schema.required as string[])].sort()).toEqual(['chat_id', 'text'])
    const properties = schema.properties as Record<string, Record<string, unknown>>
    expect(properties.action).toBeUndefined()
    expect(properties.chat_id).toBeTruthy()
    const recipientSchema = properties.to_user_ids as Record<string, unknown>
    const recipientItems = recipientSchema.items as Record<string, unknown>
    expect(recipientSchema.type).toBe('array')
    expect(String(recipientSchema.description)).toContain('multiple recipients')
    expect(recipientItems).toMatchObject({ type: 'string' })
    // 上下文工程第一批 P5:地址三种写法在数组外层说一次,元素上不再重复。
    expect(String(recipientSchema.description)).toContain('user:<uuid>')
    expect(String(recipientSchema.description)).toContain('session:<id>')
    expect(String(recipientSchema.description)).toContain('gugu:<number>')
    expect(recipientItems.description).toBeUndefined()
    const sessionMessage = SESSION_TOOL_DEFS.find((tool) => tool.name === 'session_message')
    expect(sessionMessage?.description).toContain('gugu:<number>')
    expect(sessionMessage?.schema.safeParse({ to: ['gugu:8'], text: 'x' }).success).toBe(true)
    expect(sessionMessage?.schema.safeParse({ to: ['8'], text: 'x' }).success).toBe(false)
    const lookup = tools.find((tool) => tool.name === 'profile_lookup')
    const lookupNumber = (lookup?.inputSchema as { properties?: Record<string, Record<string, unknown>> })?.properties?.gugu_number
    expect(String(lookupNumber?.description)).toContain('gugu:8')
    expect(String(lookupNumber?.description)).toContain('user:<uuid>')
    expect(JSON.stringify(lookupNumber)).toContain('gugu:')
    expect(JSON.stringify(lookupNumber)).toContain('user:')
    const reply = tools.find((tool) => tool.name === 'message_send')
    const replyProperties = (reply?.inputSchema as { properties?: Record<string, Record<string, unknown>> })?.properties
    expect(replyProperties?.reply_to_message_id?.description).toContain('source message this replies to')
    const sendDef = TOOL_DEFS.find((tool: { name: string }) => tool.name === 'message_send')
    const replyDef = TOOL_DEFS.find((tool: { name: string }) => tool.name === 'message_send')
    const historyDef = TOOL_DEFS.find((tool: { name: string }) => tool.name === 'message_history')
    const searchDef = TOOL_DEFS.find((tool: { name: string }) => tool.name === 'message_search')
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: ['user:u1', 'user:u2'] }).success).toBe(true)
    expect(replyDef?.schema.safeParse({ chat_id: 'c1', text: 'x', reply_to_message_id: 'msg:m1' }).success).toBe(true)
    expect(historyDef?.schema.safeParse({ chat_id: 'c1' }).success).toBe(true)
    expect(searchDef?.schema.safeParse({ chat_id: 'c1', query: 'x' }).success).toBe(true)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: '["u1"]' }).success).toBe(true)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: 'u1' }).success).toBe(false)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: '' }).success).toBe(false)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: '   ' }).success).toBe(false)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: '[bad]' }).success).toBe(false)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: [1] }).success).toBe(false)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: [' '] }).success).toBe(false)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: ['\t'] }).success).toBe(false)
    expect(sendDef?.schema.safeParse({ chat_id: 'c1', text: 'x', to_user_ids: ['user:u1', ' '] }).success).toBe(false)
    await client.close()
  })
  describe('#3643 message_send 未读群规即拒', () => {
    test('有群规且未读 ⇒ 拒绝、打出规矩原文、且一个字节都没落库', async () => {
      const h = harness(['alice'], '本群规矩：先给检索式再给结论。')
      const client = await connect(h.deps)
      const r = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('本群规矩：先给检索式再给结论。')
      expect(h.calls.inserts).toHaveLength(0)
      await client.close()
    })
    test('被拒之后重发即通过 —— 拒的同时已记为已读,不死循环', async () => {
      const h = harness(['alice'], '规矩A')
      const client = await connect(h.deps)
      await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
      const again = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
      expect(text(again)).toMatch(/^sent/)
      expect(h.calls.inserts).toHaveLength(1)
      await client.close()
    })
    test('先主动 message_rules 再发 ⇒ 一次都不被拒（快路径:规矩在开口前就到位）', async () => {
      const h = harness(['alice'], '规矩A')
      const client = await connect(h.deps)
      await client.callTool({ name: 'message_rules', arguments: { chat_id: 'c1' } })
      const r = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
      expect(text(r)).toMatch(/^sent/)
      await client.close()
    })
    test('群规中途改了 ⇒ 再拒一次（否则 agent 会按一份已作废的规矩行事）', async () => {
      const h = harness(['alice'], '规矩A')
      const client = await connect(h.deps)
      await client.callTool({ name: 'message_rules', arguments: { chat_id: 'c1' } })
      const ok = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'a', to_user_ids: ['user:alice'] } })
      expect(text(ok)).toMatch(/^sent/)
      h.setGroupPrompt('规矩B（改过了）')
      const blocked = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'b', to_user_ids: ['user:alice'] } })
      expect(blocked.isError).toBe(true)
      expect(text(blocked)).toContain('规矩B（改过了）')
      await client.close()
    })
    test('#3641 message_send_file 同样过闸:未见过群规 ⇒ 拒,且一个字节都没上传', async () => {
      const h = harness(['alice'], '附件先说明用途')
      const client = await connect(h.deps)
      const args = { chat_id: 'c1', file_path: fixtureFile('a.txt', 'x'), mime_type: 'text/plain' }
      const blocked = await client.callTool({ name: 'message_send_file', arguments: args })
      expect(blocked.isError).toBe(true)
      expect(text(blocked)).toContain('附件先说明用途')
      expect(h.calls.uploads).toHaveLength(0)
      expect(h.calls.inserts).toHaveLength(0)
      // 正对照:拒过一次即记为已读,重发通过。
      expect(JSON.parse(text(await client.callTool({ name: 'message_send_file', arguments: args }))).status).toBe('sent')
      await client.close()
    })
    test('#3641 投递已送达当前版本(落盘记录)⇒ 第一次发言就放行;记录的是旧版本 ⇒ 照拒', async () => {
      const ledger = memoryGroupRulesLedger()
      await ledger.write('agent-1', 'c1', { version: groupRulesVersion('规矩A'), contextKey: 'conv:s1' })
      const h = harness(['alice'], '规矩A')
      const client = await connect({ ...h.deps, groupRulesLedger: ledger })
      const ok = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
      expect(text(ok)).toMatch(/^sent/)
      h.setGroupPrompt('规矩B')
      const blocked = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'b', to_user_ids: ['user:alice'] } })
      expect(blocked.isError).toBe(true)
      expect(text(blocked)).toContain('规矩B')
      await client.close()
    })
    test('#3641 话题没立规矩 ⇒ 沿用来源群的规矩过闸', async () => {
      const h = harness(['alice'], null)
      const facts: Record<string, Record<string, unknown>> = {
        t1: { id: 't1', kind: 'topic', source_chat_id: 'g1', group_prompt: null },
        g1: { id: 'g1', kind: 'group', source_chat_id: null, group_prompt: '群里的规矩' },
      }
      const restRpc = h.deps.restRpc
      const client = await connect({
        ...h.deps,
        restRpc: async (name: string, body: Record<string, unknown>, profile?: string) =>
          name === 'chat_facts' && facts[String(body.p_chat_id)] ? [facts[String(body.p_chat_id)]] : restRpc(name, body, profile),
      })
      const blocked = await client.callTool({ name: 'message_send', arguments: { chat_id: 't1', text: 'hi' } })
      expect(blocked.isError).toBe(true)
      expect(text(blocked)).toContain('群里的规矩')
      await client.close()
    })
    test('无群规 ⇒ 一次都不拒（非目标合取项必须保持绿）', async () => {
      const h = harness(['alice'], null)
      const client = await connect(h.deps)
      const r = await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] } })
      expect(text(r)).toMatch(/^sent/)
      await client.close()
    })
  })
})
describe('#3805 运行时分叉:IM 工具注册照旧,执行一律拒', () => {
  async function connectWith(context: Record<string, unknown>): Promise<Client> {
    const server = createGuguImServerImpl(() => context, { trackRequest: passThrough })
    serveToolsList(server, () => context)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'fork-test', version: '1.0.0' })
    await Promise.all([server.connect(st), client.connect(ct)])
    return client
  }
  const forkContext = { ...TEST_CONTEXT, forkOf: 'Codex 3' }
  test('工具清单与来源一字不差 —— 前缀不变,继承来的上下文才还能命中缓存', async () => {
    const plain = await connectWith({ ...TEST_CONTEXT })
    const fork = await connectWith(forkContext)
    const listOf = async (c: Client) => JSON.stringify((await c.listTools()).tools)
    expect(await listOf(fork)).toBe(await listOf(plain))
    await plain.close()
    await fork.close()
  })
  test('每一个 IM 工具都拒,并说清分叉自谁', async () => {
    for (const def of TOOL_DEFS as Array<{ name: string }>) {
      await expect(
        callToolImpl(forkContext, def.name, {}, {}),
        `${def.name} 必须被拒`,
      ).rejects.toThrow(/运行时分叉[\s\S]*Codex 3|Codex 3[\s\S]*运行时分叉/)
    }
  })
  test('端到端:真 transport 上、参数完全合法的一次发送也照拒', async () => {
    const client = await connectWith(forkContext)
    const r = await client.callTool({
      name: 'message_send',
      arguments: { chat_id: 'c1', text: 'hi', to_user_ids: ['user:alice'] },
    })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('Codex 3')
    expect(text(r)).toContain('运行时分叉')
    await client.close()
  })
  test('反例:不是分叉就不该被这条闸拦(否则整个 IM 面被误伤也照样绿)', async () => {
    await expect(callToolImpl({ ...TEST_CONTEXT }, 'message_conversations', {}, {})).rejects.not.toThrow(
      /运行时分叉/,
    )
  })
  test('来源没有显示名时不编名字,话仍然说得完整', async () => {
    await expect(
      callToolImpl({ ...TEST_CONTEXT, forkOf: '' }, 'message_send', {}, {}),
    ).rejects.toThrow(/来源会话/)
  })
})

// #6835 悄悄话 = `whisper` 标志 + 只点一个人的 to_user_ids,只在主线里说。
// 写入走同一条插入路径,行上是 is_whisper + 那一个收件人;地址解析与非成员检查就是普通发送那一套。
describe('message_send whisper (#6835)', () => {
  async function send(h: ReturnType<typeof harness>, args: Record<string, unknown>, context: Record<string, unknown> = TEST_CONTEXT) {
    const server = createGuguImServerImpl(() => context, { trackRequest: passThrough, ...h.deps })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(st), client.connect(ct)])
    try {
      return await client.callTool({ name: 'message_send', arguments: { chat_id: 'c1', text: 'psst', ...args } })
    } finally {
      await client.close()
    }
  }
  function asChat(h: ReturnType<typeof harness>, kind: string, topicMembers?: string[]) {
    const baseRestRpc = h.deps.restRpc
    h.deps.restRpc = async (name: string, body: Record<string, unknown>, profile?: string) => {
      if (name === 'chat_facts' && body.p_chat_id === 'c1') {
        return [{ id: 'c1', name: 'Chat', kind, source_chat_id: kind === 'topic' ? 'g1' : null, group_prompt: null }]
      }
      if (name === 'list_member_ids' && body.p_chat_id === 'c1' && topicMembers) return topicMembers.map((user_id) => ({ user_id }))
      return baseRestRpc(name, body, profile)
    }
  }

  test('writes one is_whisper row to that member only, on the main line', async () => {
    const h = harness(['agent-1', 'alice', 'bob'])
    const r = await send(h, { whisper: true, to_user_ids: ['user:alice'] })
    expect(text(r)).toMatch(/^sent/)
    expect(h.calls.inserts).toHaveLength(1)
    expect(h.calls.inserts[0][1]).toMatchObject({ is_whisper: true, to_user_ids: ['alice'], thread_root_id: null, reply_to_message_id: null })
  })

  test('an ordinary send carries no whisper flag', async () => {
    const h = harness(['agent-1', 'alice'])
    await send(h, { to_user_ids: ['user:alice'] })
    expect(h.calls.inserts[0][1]).not.toHaveProperty('is_whisper')
  })

  // 回别人悄悄话的那一句,agent 天然会挂在原消息下(实机:新起的 agent 这样回,被拒后整轮放弃,对方什么也没收到)。
  // 回复预览本来就按读的人可见性给,挂着不漏任何东西。
  test('a whisper may reply to a message', async () => {
    const h = harness(['agent-1', 'alice'])
    const r = await send(h, { whisper: true, to_user_ids: ['user:alice'], reply_to_message_id: 'msg:m1' })
    expect(text(r)).toMatch(/^replied/)
    expect(h.calls.inserts[0][1]).toMatchObject({ is_whisper: true, to_user_ids: ['alice'], reply_to_message_id: 'm1' })
  })

  // 私聊里不另拦:两个人的私聊漏不出去,判据只在库里一处(gugu-supabase #84 不按 chat 种类拦)。
  test('does not forbid a whisper in a DM on its own', async () => {
    const h = harness(['agent-1', 'alice'])
    asChat(h, 'dm')
    const r = await send(h, { whisper: true, to_user_ids: ['user:alice'] })
    expect(text(r)).toMatch(/^sent/)
    expect(h.calls.inserts[0][1]).toMatchObject({ is_whisper: true, to_user_ids: ['alice'] })
  })

  // 普通发送的非成员检查(#849)对悄悄话照样生效 —— 这是所有发送的规矩,不是悄悄话另加的。
  test('the ordinary non-member check still applies to a whisper', async () => {
    const h = harness(['agent-1', 'alice'])
    const r = await send(h, { whisper: true, to_user_ids: ['user:carol'] })
    expect(text(r)).toMatch(/收件人不在本 chat（c1）成员里/)
    expect(h.calls.inserts).toHaveLength(0)
  })

  // 悄悄话合不合法(正好一人、不是自己、本 chat 成员)由库的写入口判(gugu-supabase #84);
  // 工具 ❌ 另判一份,只把库的原话交给模型。
  test.each([
    ['to itself', { to_user_ids: ['user:agent-1'] }, 'group', 'A whisper cannot be sent to yourself'],
    ['to two people', { to_user_ids: ['user:alice', 'user:bob'] }, 'group', 'A whisper goes to exactly one person: to_user_ids holds 2 recipients'],
    ['in a topic, to a source-group member outside the topic', { to_user_ids: ['user:bob'] }, 'topic', 'A whisper goes to a member of this chat: bob is not a member of c1'],
  ])('hands the database’s refusal of a whisper %s to the agent word for word', async (_, args, kind, refusal) => {
    const h = harness(['agent-1', 'alice', 'bob'])
    asChat(h, kind, kind === 'topic' ? ['agent-1', 'alice'] : undefined)
    const attempts: unknown[] = []
    h.deps.restInsert = async (_table: string, row: Record<string, unknown>) => {
      attempts.push(row)
      throw new Error(`INSERT messages → 400 ${JSON.stringify({ code: '23514', details: null, hint: null, message: refusal })}`)
    }
    const r = await send(h, { whisper: true, ...args })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(refusal)
    expect(attempts).toEqual([expect.objectContaining({ is_whisper: true })])
  })

  // 会话绑在 thread 上时,悄悄话 ❌ 一声不响落到主线 —— 说清楚只能发在主线,什么也不写。
  test('refuses a whisper from a session bound to a thread instead of moving it to the main line', async () => {
    const h = harness(['agent-1', 'alice'])
    const r = await send(h, { whisper: true, to_user_ids: ['user:alice'] }, { ...TEST_CONTEXT, threadRootId: 'thread-1' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/悄悄话只能发在主线.*thread=thread-1/)
    expect(h.calls.inserts).toHaveLength(0)
  })
})

// #6840 写类工具不认识的键直接拒、点名报回去,并列出合法参数 —— 多余的键被静默删掉时,模型以为说了的话没生效
// (实机:老会话照旧传改了名的 whisper_to,悄悄话发成了公开消息)。读类工具不动。
describe('write tools refuse unknown keys (#6840)', () => {
  test('a write tool names the unknown key and lists its legal parameters, and does nothing', async () => {
    const h = harness(['agent-1', 'alice'])
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_invite', arguments: { chat_id: 'c1', to_user_ids: ['user:alice'], text: 'join us', force: true } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/不认识的参数 force;合法参数:chat_id、to_user_ids、text/)
    expect(h.calls.rpcs.map(([name]) => name)).not.toContain('request_group_invitation_as')
  })

  test('a read tool still ignores a key it does not know', async () => {
    const h = harness(['agent-1', 'alice'])
    const client = await connect(h.deps)
    const r = await client.callTool({ name: 'message_history', arguments: { chat_id: 'c1', newest_first: true } })
    expect(r.isError).toBeFalsy()
  })

  test('tools/list advertises every write tool as closed (additionalProperties: false)', async () => {
    const h = harness(['agent-1'])
    const client = await connect(h.deps)
    const { tools } = await client.listTools()
    const writers = (TOOL_DEFS as Array<{ name: string; writer?: boolean }>).filter((def) => def.writer).map((def) => def.name)
    // Includes both delegated text and attachment writers; workspace writers live in the folder App.
    expect(writers).toHaveLength(21)
    for (const name of writers) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema, name).toMatchObject({ additionalProperties: false })
    }
  })

  test('tools/list does not repeat the JSON Schema dialect URL on every tool (上下文工程第一批 P4)', async () => {
    const h = harness(['agent-1'])
    const client = await connect(h.deps)
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.filter((tool) => '$schema' in tool.inputSchema).map((tool) => tool.name)).toEqual([])
  })

  test('a shared parameter sentence is said once across tools/list (上下文工程第一批 P5)', async () => {
    const h = harness(['agent-1'])
    const client = await connect(h.deps)
    const said = JSON.stringify((await client.listTools()).tools.map((tool) => tool.inputSchema))
    for (const sentence of [
      'the chat= value from your gugu_delivery envelope',
      'Visible escaped line breaks and malformed math',
      'Only messages with seq below this value',
    ]) {
      expect(said.split(sentence).length - 1, sentence).toBe(1)
    }
    // The array around a recipient states the address forms; the element no longer repeats them.
    expect(said).not.toContain('"gugu:<number>\\", \\"user:<uuid>\\" or \\"session:<id>\\".')
  })
})
