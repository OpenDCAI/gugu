import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDesktopGuguMcpHost,
  setSessionExtensionCatalog,
  type DesktopGuguMcpHost,
  type GuguMcpContext,
} from '../../../../apps/desktop/electron/acp-engine-utils'
import { GUGU_LISTED_TOOLS, registerGuguCatalogTools, type CatalogTool } from '../../../../apps/desktop/electron/mcp/gugu-catalog-tools'
import type { AppSearchHit } from '../../../../apps/desktop/electron/mcp/gugu-app-search-tool'
import { GUIDE_TOPICS } from '../../../../apps/desktop/electron/mcp/gugu-guide-tool'
import { PROJECT_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-project-tool'
import { LIBRARY_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-library-tool'
import { SESSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'
import { SCHEDULE_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-schedule-tool'
import { EXTENSION_TOOL_DEFS, setExtensionCheckAvailable } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
// @ts-expect-error -- the MCP tool implementation is an untyped ESM module.
import { createGuguImServer, serveToolsList, TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

// #6614 渐进披露:原生 tools/list 只列 GUGU_LISTED_TOOLS,其余经 catalog_*。判的是三件事 ——
// 列与不列恰好分开、目录里的定义与原来广告的一字不差、经 catalog_call 与按原名调是同一条路。

const hosts: DesktopGuguMcpHost[] = []
const clients: Client[] = []
// F14: a desktop host, which runs app_check — every app_* tool is registered.
beforeEach(() => setExtensionCheckAvailable(true))
afterEach(async () => {
  setExtensionCheckAvailable(false)
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
})

async function connectTo(context: GuguMcpContext): Promise<Client> {
  const host = createDesktopGuguMcpHost()
  hosts.push(host)
  await host.start()
  const grant = await host.grant('catalog', context)
  const client = new Client({ name: 'catalog-probe', version: '1' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  }))
  return client
}

const text = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? '').join('')

const social = (extra: Partial<Extract<GuguMcpContext, { kind: 'social' }>> = {}): GuguMcpContext => ({
  kind: 'social',
  expectedOwnerUserId: 'owner-1',
  subjectId: 'agent-1',
  supabaseUrl: 'https://supabase.example',
  anonKey: 'anon-key',
  agentId: 'agent-1',
  threadRootId: null,
  guguHome: '/tmp/gugu-catalog-test',
  getAccessToken: async () => 'token',
  ...extra,
})

/** A catalog row is `{ call, about }`; the tool name is the part of `call` before its parameter list (P6). */
const nameOfCall = (call: string): string => call.slice(0, call.indexOf('('))

const catalogNames = async (client: Client): Promise<string[]> =>
  (JSON.parse(text(await client.callTool({ name: 'catalog_list', arguments: {} }))) as { items: Array<{ call: string }> })
    .items.map((item) => nameOfCall(item.call))

describe('catalog_*: 渐进披露 (#6614)', () => {
  it('原生清单与目录恰好分开,合起来就是注册的全部工具', async () => {
    const client = await connectTo(social({ runSessionAction: async () => ({}), runExtensionAction: async () => ({}) }))
    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    const catalog = await catalogNames(client)
    const registered = [
      ...TOOL_DEFS.map((def: { name: string }) => def.name),
      ...SESSION_TOOL_DEFS.map((def) => def.name),
      ...PROJECT_TOOL_DEFS.map((def) => def.name),
      ...LIBRARY_TOOL_DEFS.map((def) => def.name),
      ...SCHEDULE_TOOL_DEFS.map((def) => def.name),
      ...EXTENSION_TOOL_DEFS.map((def) => def.name),
      'guide_topics', 'guide_read', 'catalog_list', 'catalog_describe', 'catalog_call', 'app_search',
    ]
    for (const name of listed) expect(GUGU_LISTED_TOOLS.has(name), name).toBe(true)
    for (const name of catalog) expect(GUGU_LISTED_TOOLS.has(name), name).toBe(false)
    expect(new Set([...listed, ...catalog])).toEqual(new Set(registered))
    expect(listed.length + catalog.length).toBe(registered.length)
    // 阳控:一个确定的冷门工具不在清单里、在目录里;一个确定的常用工具反之。
    expect(listed).not.toContain('session_stop')
    expect(catalog).toContain('session_stop')
    expect(listed).not.toContain('group_create')
    expect(catalog).toContain('group_create')
    expect(listed).not.toContain('project_add_device')
    expect(catalog).toContain('project_add_device')
    for (const { name } of LIBRARY_TOOL_DEFS) {
      expect(listed).not.toContain(name)
      expect(catalog).toContain(name)
    }
    expect(listed).toContain('message_send')
    expect(listed).toContain('message_send_as_owner')
    expect(listed).toContain('message_send_file_as_owner')
  })

  // L5 S1 复跑:29 次调用里 2 次 catalog_describe 只是为了知道参数名。每行带上调用签名,list 完就能 call。
  it('catalog_list 每行带参数签名:必填在前,可选带 ?,与 catalog_describe 的 schema 对得上', async () => {
    const client = await connectTo(social({ runSessionAction: async () => ({}), runExtensionAction: async () => ({}) }))
    const items = (JSON.parse(text(await client.callTool({ name: 'catalog_list', arguments: { rows: '1-200' } }))) as {
      items: Array<{ call: string; about: string }>
    }).items
    // P6: a row is exactly { call, about } — `call` already starts with the name, so no separate `name` copy.
    expect(items.filter((row) => Object.keys(row).sort().join() !== 'about,call')).toEqual([])
    const rows = items.map((row) => ({ ...row, name: nameOfCall(row.call) }))
    expect(rows.find((row) => row.name === 'app_check')?.call).toBe('app_check(tab_kind, item_id?, chat_id?, file_path?, steps?, phone?, page?)')
    expect(rows.find((row) => row.name === 'app_pack')?.call).toBe('app_pack(source_dir, output_path?, chat_id?)')
    // 改父子关系只在目录里(主清单 0 字节,owner 2026-10-02):行上就有它要的两个参数。
    const setParent = rows.find((row) => row.name === 'session_set_parent')
    expect(setParent?.call).toBe('session_set_parent(session_id, parent_session_id)')
    process.stdout.write(`[catalog-row] session_set_parent ${JSON.stringify(setParent).length} chars ${JSON.stringify(setParent)}\n`)
    // 10-19: a short enum is written in the row.
    expect(rows.find((row) => row.name === 'topic_members')?.call).toBe('topic_members(chat_id, rows?, name?, type?: human|agent, status?)')
    // 判据:每一行的签名都由 describe 出来的 schema 推得出 —— describe 给的就是 call 要的;写出来的 enum 就是 schema 里的那几个值。
    expect(rows.length).toBeGreaterThan(8)
    for (const row of rows) {
      const described = JSON.parse(text(await client.callTool({ name: 'catalog_describe', arguments: { tool: row.name } }))) as {
        inputSchema: { properties?: Record<string, { enum?: unknown[] }>; required?: string[] }
      }
      const required = described.inputSchema.required ?? []
      const properties = described.inputSchema.properties ?? {}
      const keys = Object.keys(properties)
      const expected = [...keys.filter((key) => required.includes(key)), ...keys.filter((key) => !required.includes(key)).map((key) => `${key}?`)]
      const params = row.call.slice(row.name.length + 1, -1).split(', ').filter(Boolean)
      expect(params.map((param) => param.split(': ')[0]), row.name).toEqual(expected)
      for (const param of params.filter((one) => one.includes(': '))) {
        const [key, values] = param.split(': ')
        expect(values.split('|'), `${row.name}.${key}`).toEqual(properties[key!.replace(/\?$/, '')]?.enum)
      }
    }
  })

  it('catalog_* 与 guide_* 的定义字节不随 grant 变', async () => {
    const pick = async (context: GuguMcpContext) => JSON.stringify((await (await connectTo(context)).listTools()).tools
      .filter((tool) => tool.name.startsWith('catalog_') || tool.name.startsWith('guide_')))
    const a = await pick(social({ runSessionAction: async () => ({}) }))
    const b = await pick({ kind: 'session-only', expectedOwnerUserId: 'owner-2', subjectId: 's-2', runSessionAction: async () => ({}) })
    expect(a).toContain('catalog_call')
    expect(b).toBe(a)
  })

  it('"delete project" finds folder detachment and exposes preservation in the catalog summary', async () => {
    const client = await connectTo(social({ runSessionAction: async () => ({}) }))
    const { items } = JSON.parse(text(await client.callTool({
      name: 'catalog_list', arguments: { name: 'delete project' },
    }))) as { items: Array<{ call: string; about: string }> }

    expect(items.map((item) => nameOfCall(item.call))).toEqual(['project_remove_folder'])
    expect(items[0]!.about).toMatch(/detach.*folders.*remove a project/i)
    expect(items[0]!.about).toMatch(/files, sessions and history.*never deleted/i)
    // The summary cannot promise unconditional deletion: the full definition keeps the visibility condition and undo.
    const definition = JSON.parse(text(await client.callTool({
      name: 'catalog_describe', arguments: { tool: 'project_remove_folder' },
    }))) as { description: string }
    expect(definition.description).toContain('only without folders or unarchived sessions')
    expect(definition.description).toContain('Returns undo')
  })

  it('catalog_describe 给出的定义与不做披露时 tools/list 广告的一字不差(含宽注册的消息写入工具)', async () => {
    const bare = createGuguImServer(() => social(), { trackRequest: <T,>(work: Promise<T>) => work })
    serveToolsList(bare, () => social())
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const reference = new Client({ name: 'reference', version: '1' })
    clients.push(reference)
    await Promise.all([bare.connect(serverTransport), reference.connect(clientTransport)])
    const advertised = (await reference.listTools()).tools

    const client = await connectTo(social())
    for (const name of ['topic_invite', 'group_list', 'message_invitations']) {
      const described = JSON.parse(text(await client.callTool({ name: 'catalog_describe', arguments: { tool: name } })))
      expect(described, name).toEqual(advertised.find((tool) => tool.name === name))
    }
    // topic_invite 注册的是宽 schema;目录里必须是它的真 schema,不是一个无字段的 object。
    const invite = JSON.parse(text(await client.callTool({ name: 'catalog_describe', arguments: { tool: 'topic_invite' } })))
    expect(invite.inputSchema.required).toContain('chat_id')
  })

  it('catalog_call 与按原名 tools/call 走同一条路:结果、分派、错误都相同', async () => {
    const seen: unknown[] = []
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runSessionAction: async (action) => {
        seen.push(action)
        if ((action as { action: string }).action === 'stop') throw new Error('stop failed')
        return { deleted: true }
      },
    })
    const both = async (tool: string, args: Record<string, unknown>) => [
      await client.callTool({ name: tool, arguments: args }),
      await client.callTool({ name: 'catalog_call', arguments: { tool, args } }),
    ]
    for (const [tool, args] of [
      ['session_archive', { session_id: 'session:child' }],
      ['session_stop', { session_id: 'session:child' }],
      // typed id 的边界在注册回调里:裸 id 两条路都当场拒。
      ['session_stop', { session_id: 'child' }],
    ] as const) {
      const [native, viaCatalog] = await both(tool, args)
      expect(viaCatalog, `${tool} ${JSON.stringify(args)}`).toEqual(native)
    }
    expect(seen).toEqual([
      { action: 'archive', session_id: 'child' }, { action: 'archive', session_id: 'child' },
      { action: 'stop', session_id: 'child' }, { action: 'stop', session_id: 'child' },
    ])

    // args 也收 JSON 字符串(harness 桥常这样序列化)。
    const asString = await client.callTool({ name: 'catalog_call', arguments: { tool: 'session_archive', args: '{"session_id":"session:x"}' } })
    expect(asString.isError ?? false, text(asString)).toBe(false)
    expect(seen.at(-1)).toEqual({ action: 'archive', session_id: 'x' })

    // 按注册时的 schema 校验:多带字段被拒并点名,不进分派器。
    const before = seen.length
    const stray = await client.callTool({ name: 'catalog_call', arguments: { tool: 'session_stop', args: { session_id: 'session:x', bogus: 1 } } })
    expect(stray.isError).toBe(true)
    expect(text(stray)).toContain('bogus')
    expect(seen.length).toBe(before)

    const unknown = await client.callTool({ name: 'catalog_call', arguments: { tool: 'no_such_tool', args: {} } })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('catalog_list')
    expect(text(unknown)).not.toContain('one of your own tools')
  })

  // #6634 问题 14 W-21: Claude, having installed through catalog_call, sent catalog_list / catalog_call through it too and got
  // 「no tool named catalog_list in the catalog; catalog_list shows what is there」— true, and no help.
  it('经 catalog 找一个原生列出的工具:告诉它那是它自己的工具,直接调', async () => {
    const client = await connectTo({ kind: 'session-only', expectedOwnerUserId: 'owner-1', subjectId: 'agent-1', runSessionAction: async () => ({}) })
    for (const tool of ['catalog_list', 'catalog_call', 'catalog_describe', 'message_send']) {
      expect(GUGU_LISTED_TOOLS.has(tool)).toBe(true)
      for (const via of ['catalog_call', 'catalog_describe'] as const) {
        const result = await client.callTool({ name: via, arguments: via === 'catalog_call' ? { tool, args: {} } : { tool } })
        expect(result.isError, `${via} ${tool}`).toBe(true)
        expect(text(result)).toContain(`${tool} is one of your own tools, not a catalog entry: call it directly`)
      }
    }
  })

  it('鉴权与原生一致:缺那一半分派器的 grant、运行时分叉,经 catalog_call 得到同一句拒绝', async () => {
    const extensionOnly = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runExtensionAction: async () => ({ installed: [] }),
    })
    const nativeRefusal = await extensionOnly.callTool({ name: 'session_stop', arguments: { session_id: 'session:x' } })
    expect(text(nativeRefusal)).toContain('session_stop is unavailable for this grant')
    expect(await extensionOnly.callTool({ name: 'catalog_call', arguments: { tool: 'session_stop', args: { session_id: 'session:x' } } }))
      .toEqual(nativeRefusal)

    const fork = await connectTo(social({ forkOf: 'Claude 1' }))
    const nativeFork = await fork.callTool({ name: 'group_list', arguments: {} })
    expect(nativeFork.isError).toBe(true)
    expect(text(nativeFork)).toContain('运行时分叉')
    expect(await fork.callTool({ name: 'catalog_call', arguments: { tool: 'group_list', args: {} } })).toEqual(nativeFork)
  })

  it('listed: false 的条目不进不带 name 的 catalog_list,带 name 时照列并标 native;按名 describe / call 照样找得到', async () => {
    const entry = (name: string, listed?: false): CatalogTool => ({
      name, description: `${name}.`, inputSchema: { type: 'object' }, ...(listed === false ? { listed } : {}),
      run: async () => ({ content: [{ type: 'text', text: `ran ${name}` }] }),
    })
    const server = new McpServer({ name: 'catalog-listed', version: '1' })
    registerGuguCatalogTools(server, () => [entry('ext-a__probe', false), entry('ext-b__probe')])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'catalog-probe', version: '1' })
    clients.push(client)
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    expect(await catalogNames(client)).toEqual(['ext-b__probe'])
    const listed = async (name: string) => (JSON.parse(text(await client.callTool({ name: 'catalog_list', arguments: { name } }))) as { items: unknown[] }).items
    expect(await listed('probe')).toEqual([{ call: 'ext-a__probe()', about: 'ext-a__probe.', native: true }, { call: 'ext-b__probe()', about: 'ext-b__probe.' }])
    expect(await listed('  ')).toEqual([{ call: 'ext-b__probe()', about: 'ext-b__probe.' }])
    expect(JSON.parse(text(await client.callTool({ name: 'catalog_describe', arguments: { tool: 'ext-a__probe' } }))).name).toBe('ext-a__probe')
    expect(text(await client.callTool({ name: 'catalog_call', arguments: { tool: 'ext-a__probe', args: {} } }))).toBe('ran ext-a__probe')
  })

  // 全能搜索 A/B 10-19: the row said only `mode?`, and an agent guessed `text` before using crawl or map.
  it('a short enum is written in the row; a long one, or one with a value the row\'s syntax uses, is not', async () => {
    const tool: CatalogTool = {
      name: 'ext__fetch', description: 'Fetch.', run: async () => ({ content: [] }),
      inputSchema: { type: 'object', required: ['level'], properties: {
        level: { type: 'string', enum: ['low', 'high'] },
        mode: { type: 'string', enum: ['crawl', 'map'] },
        provider: { type: 'string', enum: ['firecrawl', 'tavily', 'brave', 'exa', 'kagi'] },
        long: { type: 'string', enum: ['everything_at_once', 'nothing_at_all_ever'] },
        odd: { type: 'string', enum: ['a|b', 'c'] },
        url: { type: 'string' },
      } },
    }
    const server = new McpServer({ name: 'catalog-enum', version: '1' })
    registerGuguCatalogTools(server, () => [tool])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'catalog-probe', version: '1' })
    clients.push(client)
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const rows = (JSON.parse(text(await client.callTool({ name: 'catalog_list', arguments: { name: 'ext__fetch' } }))) as { items: { call: string }[] }).items
    expect(rows.map((row) => row.call)).toEqual(['ext__fetch(level: low|high, mode?: crawl|map, provider?, long?, odd?, url?)'])
  })

  it('#6634 问题 16 no tool named 带上此刻被排除在目录外的程序与原因;没有被排除的就只是原来那句', async () => {
    const entry: CatalogTool = {
      name: 'ext-b__probe', description: 'probe.', inputSchema: { type: 'object' },
      run: async () => ({ content: [{ type: 'text', text: 'ran' }] }),
    }
    const connectWith = async (leftOut: string[]) => {
      const server = new McpServer({ name: 'catalog-left-out', version: '1' })
      registerGuguCatalogTools(server, () => [entry], () => leftOut)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'catalog-probe', version: '1' })
      clients.push(client)
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      return client
    }
    const reason = 'extension todo-panel, program todos: [ { "expected": "array", "path": [ "tools" ] } ]'
    const withOne = await connectWith([reason])
    for (const [name, args] of [['catalog_call', { tool: 'todo-panel-todos__add_todo', args: {} }], ['catalog_describe', { tool: 'todo-panel-todos__add_todo' }]] as const) {
      const result = await withOne.callTool({ name, arguments: args })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('no tool named todo-panel-todos__add_todo in the catalog; catalog_list shows what is there')
      expect(text(result)).toContain(`Left out of the catalog right now: ${reason}`)
    }
    const none = await (await connectWith([])).callTool({ name: 'catalog_call', arguments: { tool: 'nope', args: {} } })
    expect(text(none)).toMatch(/no tool named nope in the catalog; catalog_list shows what is there$/)
  })

  it('#6634 问题 16 真宿主上:任务页会话的 no tool named 带上扩展目录报的排除原因,侧边聊天(分叉)不带扩展也就不带', async () => {
    // The installed Apps this session cannot use, and why: the same states app_search shows (10-19).
    const manifest = { id: 'todo-panel', name: 'Todos', version: '1.0.0', contributes: { tabs: [] } } as unknown as AppSearchHit['manifest']
    const reason = 'Todos (todo-panel): program todos: did not start: spawn node ENOENT'
    setSessionExtensionCatalog({
      tools: async () => [],
      apps: async () => ({ apps: [
        { manifest, version: '1.0.0', state: 'unavailable', next: 'program todos: did not start: spawn node ENOENT' },
        { manifest: { ...manifest, id: 'notes', name: 'Notes' }, version: '1.0.0', state: 'on' },
      ] }),
      skills: async () => [],
    })
    try {
      const session = await connectTo(social({ grantKey: 'taskpage:conv-1' }))
      expect(text(await session.callTool({ name: 'catalog_call', arguments: { tool: 'todo-panel-todos__x', args: {} } })))
        .toContain(`Left out of the catalog right now: ${reason}`)
      const fork = await connectTo(social({ grantKey: 'taskpage:conv-1', forkOf: 'Claude 1' }))
      expect(text(await fork.callTool({ name: 'catalog_call', arguments: { tool: 'todo-panel-todos__x', args: {} } })))
        .not.toContain('Left out of the catalog')
    } finally {
      setSessionExtensionCatalog(null)
    }
  })

  // 10-19 mac1: one App's program never answered, and every catalog call waited on it — the platform's own tools too.
  it('an App program that never answers holds up neither the platform\'s tools nor another App\'s: a lookup asks only who owns the name', async () => {
    const asked: (string | undefined)[] = []
    const other: CatalogTool = {
      name: 'other-app__probe', description: 'probe.', inputSchema: { type: 'object' },
      run: async () => ({ content: [{ type: 'text', text: 'ran other-app__probe' }] }),
    }
    // Every App is asked unless the name is other-app's: then only other-app is, and it answers at once.
    setSessionExtensionCatalog({
      tools: async (_grantKey, _agent, name) => {
        asked.push(name)
        return name?.startsWith('other-app__') ? [other] : new Promise<CatalogTool[]>(() => {})
      },
      apps: async () => ({ apps: [] }),
      skills: async () => [],
    })
    try {
      const session = await connectTo(social({ grantKey: 'taskpage:conv-1' }))
      expect(JSON.parse(text(await session.callTool({ name: 'catalog_describe', arguments: { tool: 'group_list' } }))).name).toBe('group_list')
      expect(text(await session.callTool({ name: 'catalog_call', arguments: { tool: 'other-app__probe', args: {} } }))).toBe('ran other-app__probe')
      expect(asked).toEqual(['other-app__probe'])
    } finally {
      setSessionExtensionCatalog(null)
    }
  }, 30_000)

  it('arguments wrapped in a second args: said as such, the tool not run; a tool whose own parameter is args still gets it', async () => {
    const ran: unknown[] = []
    const entry = (name: string, properties: Record<string, object>): CatalogTool => ({
      name, description: `${name}.`, inputSchema: { type: 'object', properties },
      run: async (args) => { ran.push(args); return { content: [{ type: 'text', text: `ran ${name}` }] } },
    })
    const server = new McpServer({ name: 'catalog-wrapped', version: '1' })
    registerGuguCatalogTools(server, () => [entry('folder__create', { chat_id: {}, content: {} }), entry('runner__exec', { args: {} })])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'catalog-probe', version: '1' })
    clients.push(client)
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const call = (tool: string, args: unknown) => client.callTool({ name: 'catalog_call', arguments: { tool, args } })
    const said = 'folder__create\'s arguments came wrapped in a second args: put them straight in args — catalog_call({ tool: "folder__create", args: { … } })'
    // Both shapes seen: the arguments alone in a second args, and the whole call (tool and args) put inside args.
    for (const args of [{ args: { chat_id: '1', content: 'x' } }, { tool: 'folder__create', args: { chat_id: '1', content: 'x' } }]) {
      const result = await call('folder__create', args)
      expect(result.isError).toBe(true)
      expect(text(result)).toBe(said)
    }
    expect(ran).toEqual([])
    // Not wrapped, or a string args, or a tool whose own parameter is called args: run as before.
    expect(text(await call('folder__create', { chat_id: '1', content: 'x' }))).toBe('ran folder__create')
    expect(text(await call('folder__create', { chat_id: '1', args: 'x' }))).toBe('ran folder__create')
    expect(text(await call('runner__exec', { args: { n: 1 } }))).toBe('ran runner__exec')
    expect(ran).toEqual([{ chat_id: '1', content: 'x' }, { chat_id: '1', args: 'x' }, { args: { n: 1 } }])
  })

  it('#6387 an App\'s skill is a catalog_list row of its own, before the tools: name, App, first sentence, the SKILL.md to read', async () => {
    const tool: CatalogTool = {
      name: 'choukatai__board', description: 'Read a card table. More.', inputSchema: { type: 'object', required: ['board'], properties: { board: {} } },
      run: async () => ({ content: [{ type: 'text', text: 'ran' }] }),
    }
    const skill = { extensionId: 'choukatai', name: 'choukatai', description: 'Work a card table. When woken about one.', dir: '/apps/choukatai/skills/choukatai' }
    const server = new McpServer({ name: 'catalog-skills', version: '1' })
    registerGuguCatalogTools(server, () => [tool], undefined, () => [skill])
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'catalog-probe', version: '1' })
    clients.push(client)
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const listed = async (args: Record<string, unknown>) => (JSON.parse(text(await client.callTool({ name: 'catalog_list', arguments: args }))) as { items: unknown[] }).items
    const skillRow = { skill: 'choukatai', app: 'choukatai', about: 'Work a card table.', read: '/apps/choukatai/skills/choukatai/SKILL.md' }
    expect(await listed({})).toEqual([skillRow, { call: 'choukatai__board(board)', about: 'Read a card table.' }])
    // Looked up by the App's name, the skill comes with its tools; a name only a tool has leaves the skill out.
    expect(await listed({ name: 'chouka' })).toEqual([skillRow, { call: 'choukatai__board(board)', about: 'Read a card table.' }])
    expect(await listed({ name: 'board' })).toEqual([{ call: 'choukatai__board(board)', about: 'Read a card table.' }])
  })

  it('#6387 真宿主上:任务页会话的 catalog_list 列出扩展目录给的 skill;侧边聊天(分叉)不带扩展,也就不列', async () => {
    const skill = { extensionId: 'choukatai', name: 'choukatai', description: 'Work a card table.', dir: '/apps/choukatai/skills/choukatai' }
    const asked: string[] = []
    setSessionExtensionCatalog({ tools: async () => [], apps: async () => ({ apps: [] }), skills: async (grantKey) => (asked.push(grantKey), [skill]) })
    try {
      const items = async (client: Client) => (JSON.parse(text(await client.callTool({ name: 'catalog_list', arguments: { name: 'choukatai' } }))) as { items: unknown[] }).items
      expect(await items(await connectTo(social({ grantKey: 'taskpage:conv-1' })))).toEqual([
        { skill: 'choukatai', app: 'choukatai', about: 'Work a card table.', read: '/apps/choukatai/skills/choukatai/SKILL.md' },
      ])
      expect(asked).toEqual(['taskpage:conv-1'])
      expect(await items(await connectTo(social({ grantKey: 'taskpage:conv-1', forkOf: 'Claude 1' })))).toEqual([])
    } finally {
      setSessionExtensionCatalog(null)
    }
  })

  it('guide_topics 列出主题,guide_read 交出全文', async () => {
    const client = await connectTo(social())
    expect(JSON.parse(text(await client.callTool({ name: 'guide_topics', arguments: {} }))))
      .toEqual(GUIDE_TOPICS.map(({ topic, about }) => ({ topic, about })))
    const guide = text(await client.callTool({ name: 'guide_read', arguments: { topic: 'apps' } }))
    expect(guide).toBe(GUIDE_TOPICS.find((entry) => entry.topic === 'apps')?.text)
    expect(guide).toContain('window.gugu')
    const missing = await client.callTool({ name: 'guide_read', arguments: { topic: 'nope' } })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('guide_topics')
  })
})
