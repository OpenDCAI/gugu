import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDesktopGuguMcpHost,
  type DesktopGuguMcpHost,
  type GuguMcpContext,
} from '../../../../apps/desktop/electron/acp-engine-utils'
import { ACTIVITY_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-activity-tool'
import { LIBRARY_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-library-tool'
import { PROJECT_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-project-tool'
import { SESSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'
import { EXTENSION_TOOL_DEFS, setExtensionCheckAvailable } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { handleUnifiedSessionMessage } from '../../../../apps/desktop/electron/unified-session-message'

// #4191:胖工具 gugu_session(action 分派 + union)退役,会话页两域 = registerGuguSessionTools 的
// session_* 原子工具 + registerGuguExtensionTools 的 app_* 三个,同一台会话 MCP server。
// 分派器合同零变化:宿主收到的仍是 {action:'spawn', ...} / {action:'list', ...} —— 前缀只在注册机剥一次。

const SESSION_TOOL_NAMES = [
  'session_devices', 'device_actions', 'device_call', 'session_list_harnesses', 'session_list_models',
  'session_spawn', 'session_ask_user', 'session_children', 'session_message', 'session_open_in_tab', 'session_list_tabs', 'session_close_tab',
  'session_get', 'session_stop', 'session_archive', 'session_set_parent',
] as const
const PROJECT_TOOL_NAMES = PROJECT_TOOL_DEFS.map((def) => def.name)
const ACTIVITY_TOOL_NAMES = ACTIVITY_TOOL_DEFS.map(def => def.name)
const LIBRARY_TOOL_NAMES = LIBRARY_TOOL_DEFS.map(def => def.name)
const EXTENSION_TOOL_NAMES = ['app_manage', 'app_create', 'app_pack', 'app_install', 'app_check'] as const
// #7221 给自己排的已安排:与 session_* 同一个分派器、同一份 grant。
const SCHEDULE_TOOL_NAMES = ['schedule_create', 'schedule_list', 'schedule_cancel'] as const
// #6614 每条 grant 都有的两个域:guide_* 与渐进披露的 catalog_*。
const ALWAYS_TOOL_NAMES = ['guide_topics', 'guide_read', 'catalog_list', 'catalog_describe', 'catalog_call', 'app_search'] as const

const clients: Client[] = []
const hosts: DesktopGuguMcpHost[] = []

function responseText(value: unknown): string {
  const content = (value as { content?: Array<{ type: string; text?: string }> }).content
  return content?.[0]?.text ?? ''
}

/** 模型拿得到的全部工具:tools/list 列出的,加上 catalog_list 里的(各自经 catalog_describe 的完整定义)。 */
async function reachableTools(client: Client): Promise<Array<{ name: string; inputSchema: unknown }>> {
  const listed = (await client.listTools()).tools
  const catalog = JSON.parse(responseText(await client.callTool({ name: 'catalog_list', arguments: {} }))) as { items: Array<{ call: string }> }
  const described = await Promise.all(catalog.items.map(async ({ call }) =>
    JSON.parse(responseText(await client.callTool({ name: 'catalog_describe', arguments: { tool: call.slice(0, call.indexOf('(')) } }))) as { name: string; inputSchema: unknown }))
  return [...listed, ...described]
}

// F14: these are desktop hosts, which run app_check; the one test of a host that cannot says so itself.
beforeEach(() => setExtensionCheckAvailable(true))
afterEach(async () => {
  setExtensionCheckAvailable(false)
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
})

async function connectTo(contextValue: GuguMcpContext): Promise<Client> {
  const host = createDesktopGuguMcpHost()
  hosts.push(host)
  await host.start()
  const grant = await host.grant('session', contextValue)
  const client = new Client({ name: 'gugu-composed-client', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
    requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
  }))
  return client
}

const socialContext = (
  runSessionAction?: (action: unknown, signal?: AbortSignal) => Promise<unknown>,
): GuguMcpContext => ({
  kind: 'social',
  expectedOwnerUserId: 'owner-1',
  subjectId: 'agent-1',
  supabaseUrl: 'https://supabase.example',
  anonKey: 'anon-key',
  agentId: 'agent-1',
  threadRootId: null,
  guguHome: '/tmp/gugu-mcp-test',
  getAccessToken: async () => 'token',
  ...(runSessionAction ? { runSessionAction } : {}),
})

describe('single Gugu MCP surface (session_* + app_* atomic tools)', () => {
  it.each([false, true])('returns an Agent-ID receipt after exactly one delivery (remote: %s)', async (remote) => {
    const delivered: string[] = []
    const deliver = async (ids: string[]) => {
      delivered.push(...ids)
      return { recipients: ids.map(id => ({ to: `session:${id}`, status: 'delivered' as const, message_id: 'receipt' })) }
    }
    const client = await connectTo(socialContext(async action => handleUnifiedSessionMessage(action as Record<string, unknown>, {
      caller: { sessionId: 'caller', runtimeFork: false },
      graphMessage: deliver,
      localSessionsOfAgents: async () => ({ sessions: new Map(remote ? [] : [['target-agent', 'target-session']]), deletedRecipients: [] }),
      resolveLocalGuguNumbers: async () => new Map(),
      ...(remote ? { remote: {
        locateAgents: async () => ({ byUserId: new Map([['target-agent', 'other-device']]), numberToUserId: new Map() }),
        thisDeviceId: async () => 'this-device',
        sessionsOfAgents: async () => new Map([['target-agent', 'target-session']]),
        locateSessions: async () => ({ found: new Map(), missingMessage: null }),
        assertReachable: async () => {},
        deliver: async (_device, group) => (await deliver(group.sessionIds)).recipients,
      } } : {}),
    })))
    const response = await client.callTool({ name: 'session_message', arguments: { to: ['aid:target-agent'], text: 'one marker' } })
    expect(delivered).toEqual(['target-session'])
    expect(response.isError).not.toBe(true)
    expect(JSON.parse(responseText(response)).recipients).toEqual([
      { to: 'user:target-agent', session_id: 'session:target-session', status: 'delivered', message_id: 'msg:receipt' },
    ])
  })

  it('requires the assistant to distinguish a question from an assignment before dispatch', async () => {
    const seen: unknown[] = []
    const client = await connectTo({ ...socialContext(async action => { seen.push(action); return { recipients: [] } }), personalAssistant: true })
    const args = { to: ['session:target'], text: '请回复一句话' }
    expect((await client.callTool({ name: 'session_message', arguments: args })).isError).toBe(true)
    expect(seen).toEqual([])
    expect((await client.callTool({ name: 'session_message', arguments: { ...args, purpose: 'reply' } })).isError).not.toBe(true)
    expect(seen).toEqual([{ action: 'message', ...args, purpose: 'reply' }])
    await client.callTool({ name: 'session_message', arguments: { ...args, purpose: 'task' } })
    expect(seen[1]).toMatchObject({ action: 'message', purpose: 'task', text: expect.stringContaining('<gugu_task_context>') })
  })

  it('注册清单:两份 DEF 的原子工具名字→分派动作一一对应(前缀在注册机剥掉)', () => {
    expect(SESSION_TOOL_DEFS.map((def) => def.name)).toEqual([...SESSION_TOOL_NAMES])
    expect(EXTENSION_TOOL_DEFS.map((def) => def.name)).toEqual([...EXTENSION_TOOL_NAMES])
    // 工具面与分派器不许各写一份动作名清单:动作名 = 工具名剥掉域前缀。
    expect(Object.fromEntries(SESSION_TOOL_DEFS.map((def) => [def.name, def.action]))).toEqual({
      session_devices: 'devices',
      // #7199 device_* 借住在会话这份 DEF 里;动作名带全名,❌ 剥成 'actions' / 'call'(分派器里太容易撞)。
      device_actions: 'device_actions',
      device_call: 'device_call',
      session_list_harnesses: 'list_harnesses',
      session_list_models: 'list_models',
      session_spawn: 'spawn',
      session_ask_user: 'ask_user',
      session_children: 'children',
      session_message: 'message',
      session_open_in_tab: 'open_in_tab',
      session_list_tabs: 'list_tabs',
      session_close_tab: 'close_tab',
      session_get: 'get',
      session_stop: 'stop',
      session_archive: 'archive',
      session_set_parent: 'set_parent',
    })
    expect(Object.fromEntries(EXTENSION_TOOL_DEFS.map((def) => [def.name, def.action]))).toEqual({
      app_manage: 'manage',
      app_create: 'create',
      app_pack: 'pack',
      app_install: 'install',
      app_check: 'check',
    })
  })

  it('无任务分派器的社交 grant 不注册任务页工具;胖工具名已退役', async () => {
    const client = await connectTo(socialContext())
    const names = (await reachableTools(client)).map((tool) => tool.name)
    expect(names).toContain('message_send')
    for (const name of [...SESSION_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...LIBRARY_TOOL_NAMES, ...ACTIVITY_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...EXTENSION_TOOL_NAMES]) expect(names).not.toContain(name)
    expect(names).not.toContain('gugu_session')
    expect(names).not.toContain('gugu_extension')
    const missing = await client.callTool({ name: 'session_children', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(responseText(missing)).toContain('not found')
  })

  // createGuguImServer now enumerates _registeredTools; the historical #4191 list omission is fixed in dev.
  // TOOL_DEFS,把**之后**注册进同一台 server 的 session_*/app_* 十五个工具从 tools/list 里藏掉了
  // (调用仍通,但模型看不见就永远不会调)。重构前的 handler 枚举的是 server._registeredTools,没有这个洞。
  // ❌ 不许为了绿改成「只断言可调用」:工具清单在模型前缀里,广告不出去 = 功能对模型不存在。
  it('任务页(social+session)grant 的 tools/list 与 catalog 合起来同时广告社交域与 session/extension 两域', async () => {
    setExtensionCheckAvailable(true)
    const client = await connectTo({
      ...socialContext(async () => ({ ok: true })),
      runExtensionAction: async () => ({ ok: true }),
    })
    const names = (await reachableTools(client)).map((tool) => tool.name)
    expect(names).toContain('message_send')
    for (const name of [...SESSION_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...LIBRARY_TOOL_NAMES, ...ACTIVITY_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...EXTENSION_TOOL_NAMES]) expect(names).toContain(name)
  })

  it('tab tools stay in catalog, dispatch there, and reject a different session or device', async () => {
    const seen: unknown[] = []
    const client = await connectTo(socialContext(async (action) => { seen.push(action); return { tabs: [], tab_count: 0 } }))
    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    for (const name of ['session_list_tabs', 'session_close_tab']) expect(listed).not.toContain(name)
    await client.callTool({ name: 'catalog_call', arguments: { tool: 'session_list_tabs', args: {} } })
    await client.callTool({ name: 'catalog_call', arguments: { tool: 'session_close_tab', args: { tab_id: 'tab-1' } } })
    expect(seen).toEqual([{ action: 'list_tabs' }, { action: 'close_tab', tab_id: 'tab-1' }])
    for (const args of [{ tab_id: 't', session_id: 'session:other' }, { tab_id: 't', device: 'device:other' }, { tab_id: '' }]) {
      expect((await client.callTool({ name: 'catalog_call', arguments: { tool: 'session_close_tab', args } })).isError).toBe(true)
    }
    expect(seen).toHaveLength(2)
  })

  // F14 (L7-b) 列出来就得能用:跑不了隐藏页的宿主(咕咕 server)不列 app_check,其余四个照列。与上一条互为对照。
  it('宿主跑不了 app_check 时 catalog 里没有它,别的 app_* 都在', async () => {
    setExtensionCheckAvailable(false)
    const client = await connectTo({
      ...socialContext(async () => ({ ok: true })),
      runExtensionAction: async () => ({ ok: true }),
    })
    const names = (await reachableTools(client)).map((tool) => tool.name)
    expect(names).not.toContain('app_check')
    for (const name of EXTENSION_TOOL_NAMES.filter((tool) => tool !== 'app_check')) expect(names).toContain(name)
  })

  // 摩擦单 F54:工具清单是模型前缀的一段,按会话变就让新会话首轮吃不到缓存。#4378 曾把「你是终端/面板会话」
  // 写进 session_spawn 的说明,终端与面板两种会话因此各一份前缀;这件事改由会话的 surface 自述块说。
  it('tools/list 一字不随 grant 变:另一个会话、另一个 thread 拿到同一份,session_spawn 不带调用方的形态', async () => {
    const list = async (context: GuguMcpContext) => JSON.stringify((await (await connectTo(context)).listTools()).tools)
    const one = await list(socialContext(async () => ({ ok: true })))
    const anotherSession = { subjectId: 'agent-2', agentId: 'agent-2', threadRootId: 'root-2', guguHome: '/tmp/gugu-mcp-test-2' }
    const other = await list({ ...socialContext(async () => ({ ok: true })), ...anotherSession })
    expect(other).toBe(one)
    const spawn = (JSON.parse(one) as Array<{ name: string; description: string }>).find((tool) => tool.name === 'session_spawn')
    expect(spawn?.description).toBe(SESSION_TOOL_DEFS.find((tool) => tool.name === 'session_spawn')?.description)
    expect(spawn?.description).toContain('Omit transport to inherit your chat or terminal UI')
  })

  it('15 个原子工具全部拿得到并可调;typed id 双向编解码;分派器错误走 isError', async () => {
    const seen: unknown[] = []
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runSessionAction: async (action) => {
        seen.push(action)
        const dispatched = action as { action: string }
        if (dispatched.action === 'stop') throw new Error('stop failed')
        // 出参的 id 字段回到 agent 一律带类型 —— 编码在注册机做一次。
        if (dispatched.action === 'get') return { session_id: 'child-echo', parent_session_id: 'p-1', transport: 'pty', status: 'running' }
        // 列表工具的结果要是一张表 —— 注册机按约定切窗,拿不到表就响亮地拒。
        if (dispatched.action === 'list_harnesses') return { current_harness: 'claude', harnesses: [] }
        if (dispatched.action === 'list_models') return { harness_id: 'claude', models: [] }
        if (dispatched.action === 'children' || dispatched.action === 'devices') return []
        // 跨机器(owner 09-30):别的机器上起的 child 回执带 device_id,出参编成 device:。
        if (dispatched.action === 'spawn' && (dispatched as { device?: string }).device) {
          return { session_id: 'remote-child', spawned_by_session_id: 'agent-session', device_id: 'dev-b', spawned_by_device_id: 'dev-a' }
        }
        return { accepted: true }
      },
      runExtensionAction: async () => ({ extensions: [] }),
    })

    const reachable = await reachableTools(client)
    expect(new Set(reachable.map((tool) => tool.name))).toEqual(new Set([...SESSION_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...LIBRARY_TOOL_NAMES, ...ACTIVITY_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...EXTENSION_TOOL_NAMES, ...ALWAYS_TOOL_NAMES]))

    // #6720 agent 收起会话只有归档:按旧名 session_delete 调,得到的是「没有这个工具」,且到不了分派器。
    const retiredDelete = await client.callTool({ name: 'session_delete', arguments: { session_id: 'session:child' } })
    expect(retiredDelete.isError).toBe(true)
    expect(responseText(retiredDelete)).toContain('session_delete not found')
    expect(seen).toEqual([])

    // spec session-graph:agent 不能传 project id、owner、命令或 cwd —— 守的是**字段**。
    for (const tool of reachable) {
      const fieldNames = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      for (const field of ['owner', ...((tool.name.startsWith('project_') || tool.name === 'activity_list') ? [] : ['project_id']), 'cwd', 'command']) expect(fieldNames, tool.name).not.toContain(field)
      // 原子工具 = 扁平参数,没有 action 字段。
      expect(fieldNames, tool.name).not.toContain('action')
    }

    // ids cross the tool boundary typed (session:<id> / msg:<id>); the host dispatcher receives storage-form ids.
    const calls: Array<{ tool: string; args: Record<string, unknown>; dispatched: Record<string, unknown> }> = [
      { tool: 'session_devices', args: {}, dispatched: { action: 'devices' } },
      { tool: 'session_list_harnesses', args: {}, dispatched: { action: 'list_harnesses' } },
      // device 以 device:<id> 进来,宿主拿到裸 id(与 session: 同一道边界)。
      { tool: 'session_list_harnesses', args: { device: 'device:dev-b' }, dispatched: { action: 'list_harnesses', device: 'dev-b' } },
      {
        tool: 'session_spawn',
        args: { prompt: 'train', device: 'device:dev-b' },
        dispatched: { action: 'spawn', prompt: 'train', device: 'dev-b' },
      },
      // project:typed project: id 解成裸 id;别的都是那台机器上的目录,原样交过去(~ 由那台机器展开)。
      { tool: 'session_spawn', args: { prompt: 'p', project: 'project:proj-b' }, dispatched: { action: 'spawn', prompt: 'p', project_id: 'proj-b' } },
      {
        tool: 'session_spawn',
        args: { prompt: 'p', project: '~/Documents/gugu', device: 'device:dev-b' },
        dispatched: { action: 'spawn', prompt: 'p', project_path: '~/Documents/gugu', device: 'dev-b' },
      },
      { tool: 'session_list_models', args: {}, dispatched: { action: 'list_models' } },
      { tool: 'session_spawn', args: { prompt: 'inspect' }, dispatched: { action: 'spawn', prompt: 'inspect' } },
      { tool: 'session_ask_user', args: { questions: [{ question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }] }, dispatched: { action: 'ask_user', questions: [{ question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }] } },
      { tool: 'session_children', args: {}, dispatched: { action: 'children' } },
      {
        // #4562 union 寻址:to 条目保持 typed 穿过注册机,由宿主分派器按前缀拆腿。
        tool: 'session_message',
        args: { to: ['session:child', 'user:alice'], text: 'hi' },
        dispatched: { action: 'message', to: ['session:child', 'user:alice'], text: 'hi' },
      },
      {
        // owner 10-17:发信方自己说发完以后去向、回的是哪条 —— 原样(typed msg:)交给宿主,由编排层写上收件方的信封。
        tool: 'session_message',
        args: { to: ['session:child'], text: 'hi', then: 'wait', reply_to_message_id: 'msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f' },
        dispatched: { action: 'message', to: ['session:child'], text: 'hi', then: 'wait', reply_to_message_id: 'msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f' },
      },
      {
        tool: 'session_open_in_tab',
        args: { path: 'src/a.ts', intent: 'preview' },
        dispatched: { action: 'open_in_tab', path: 'src/a.ts', intent: 'preview' },
      },
      { tool: 'session_list_tabs', args: {}, dispatched: { action: 'list_tabs' } },
      { tool: 'session_close_tab', args: { tab_id: 'tab-1' }, dispatched: { action: 'close_tab', tab_id: 'tab-1' } },
      { tool: 'session_get', args: {}, dispatched: { action: 'get' } },
      {
        tool: 'session_stop',
        args: { session_id: 'session:child' },
        dispatched: { action: 'stop', session_id: 'child' },
      },
      {
        tool: 'session_archive',
        args: { session_id: 'session:child' },
        dispatched: { action: 'archive', session_id: 'child' },
      },
      {
        tool: 'session_archive',
        args: { session_id: 'session:child', with_children: true },
        dispatched: { action: 'archive', session_id: 'child', with_children: true },
      },
      {
        tool: 'session_set_parent',
        args: { session_id: 'session:child', parent_session_id: 'session:caller' },
        dispatched: { action: 'set_parent', session_id: 'child', parent_session_id: 'caller' },
      },
      {
        tool: 'session_set_parent',
        args: { session_id: 'session:child', parent_session_id: null },
        dispatched: { action: 'set_parent', session_id: 'child', parent_session_id: null },
      },
      {
        tool: 'session_open_in_tab',
        args: { url: 'https://example.com', intent: 'pinned' },
        dispatched: { action: 'open_in_tab', url: 'https://example.com', intent: 'pinned' },
      },
      {
        tool: 'session_open_in_tab',
        args: { app_tab: 'notes.board', intent: 'pinned' },
        dispatched: { action: 'open_in_tab', app_tab: 'notes.board', intent: 'pinned' },
      },
      // 摩擦单 F122 «open with X»: a path with the App to open it with (the parent refused this pair).
      {
        tool: 'session_open_in_tab',
        args: { path: 'TODO.md', app_tab: 'kanban.board' },
        dispatched: { action: 'open_in_tab', path: 'TODO.md', app_tab: 'kanban.board', intent: 'pinned' },
      },
    ]
    for (const { tool, args } of calls) {
      const result = await client.callTool({ name: tool, arguments: args })
      expect(result.isError === true, tool).toBe(tool === 'session_stop')
      if (tool === 'session_stop') expect(responseText(result)).toContain('stop failed')
      if (tool === 'session_spawn' && args.device) {
        expect(JSON.parse(responseText(result))).toEqual({
          session_id: 'session:remote-child',
          spawned_by_session_id: 'session:agent-session',
          device_id: 'device:dev-b',
          spawned_by_device_id: 'device:dev-a',
        })
      }
      if (tool === 'session_get') {
        // 出参编码:session_id 族字段带回 session: 前缀。
        expect(JSON.parse(responseText(result))).toEqual({
          session_id: 'session:child-echo',
          parent_session_id: 'session:p-1',
          transport: 'pty',
          status: 'running',
        })
      }
    }
    expect(seen).toEqual(calls.map(({ dispatched }) => dispatched))

    // 严格 schema:多带一个字段被 SDK 校验拒绝并点名那个字段,且不进分派器。
    const strayField = await client.callTool({
      name: 'session_spawn',
      arguments: { name: 'x', title: 'x', prompt: 'p' },
    })
    expect(strayField.isError).toBe(true)
    expect(responseText(strayField).toLowerCase()).toContain('unrecognized key')
    expect(responseText(strayField)).toContain('name')

    // A bare id or an id of another type never reaches the host: the boundary refuses it by name.
    const bare = await client.callTool({ name: 'session_stop', arguments: { session_id: 'child' } })
    expect(bare.isError).toBe(true)
    expect(responseText(bare)).toContain('session_id: expected a session: id')
    const wrongKind = await client.callTool({ name: 'session_stop', arguments: { session_id: 'msg:child' } })
    expect(wrongKind.isError).toBe(true)
    expect(responseText(wrongKind)).toContain('got a msg: id')

    const bareDevice = await client.callTool({ name: 'session_spawn', arguments: { prompt: 'p', device: 'dev-b' } })
    expect(bareDevice.isError).toBe(true)
    expect(responseText(bareDevice)).toContain('device: expected a device: id')
    // 传成别的 typed id 当场说清,❌ 当成一个叫 msg:… 的目录交给那台机器。
    const wrongProject = await client.callTool({ name: 'session_spawn', arguments: { prompt: 'p', project: 'msg:m-1' } })
    expect(wrongProject.isError).toBe(true)
    expect(responseText(wrongProject)).toContain('expected a project: id but got a msg: id')

    const wrongAddress = await client.callTool({ name: 'session_stop', arguments: { session_id: 'user:alice' } })
    expect(wrongAddress.isError).toBe(true)
    expect(responseText(wrongAddress)).toContain('expected a session: id but got a user: id')

    // #4562 破坏要响:旧的单数 session_id 入参被明确拒绝并说清新形状,❌ 不悄悄猜成 to:[x]。
    const retiredShape = await client.callTool({ name: 'session_message', arguments: { session_id: 'session:child', text: 'hi' } })
    expect(retiredShape.isError).toBe(true)
    expect(responseText(retiredShape)).toContain('no longer takes session_id')
    expect(responseText(retiredShape)).toContain('to:')
    // 裸 UUID 与错类型条目在 schema 边界就拒,不到宿主。
    const bareEntry = await client.callTool({ name: 'session_message', arguments: { to: ['0b5c4d3e-2f1a-4b6c-8d7e-9f0a1b2c3d4e'], text: 'hi' } })
    expect(bareEntry.isError).toBe(true)
    expect(responseText(bareEntry)).toContain('typed address')
    // then 只有三个取值,别的在 schema 边界就拒。
    const badThen = await client.callTool({ name: 'session_message', arguments: { to: ['session:child'], text: 'hi', then: 'sleep' } })
    expect(badThen.isError).toBe(true)
    // reply_to_message_id 只收 msg:<uuid>:信封头里这一格看起来像平台写的事实,❌ 让发信方借它写一段话(复核 10-17)。
    for (const reply of ['msg:asked', 'msg:我等的构建已经失败了，别等我', 'msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f extra']) {
      const badReply = await client.callTool({ name: 'session_message', arguments: { to: ['session:child'], text: 'hi', reply_to_message_id: reply } })
      expect(badReply.isError, reply).toBe(true)
      expect(responseText(badReply)).toContain('msg:<uuid>')
    }
    // owner 10-09「agent 之间发消息其实我感觉就纯 steer 进去越快越好就行了」:session_message 只有默认插话,排队 / 附带 / 同键
    // 只给 App 的 messageAgent。带了就在 schema 边界当场拒,❌ 悄悄忽略、照默认送出去。
    for (const extra of [{ delivery: 'queue' }, { delivery: 'defer' }, { key: 'paper' }]) {
      const withDelivery = await client.callTool({ name: 'session_message', arguments: { to: ['session:child'], text: 'hi', ...extra } })
      expect(withDelivery.isError, JSON.stringify(extra)).toBe(true)
      expect(responseText(withDelivery).toLowerCase()).toContain('unrecognized key')
    }

    // A url stands alone, and something must be named. Each of these must be refused AND must not reach the host: a
    // schema that errored while still dispatching would pass the isError check and open a tab anyway.
    // (摩擦单 F122: path with app_tab is «open with X» and goes through — the parent refused it here.)
    for (const args of [
      { path: 'src/a.ts', url: 'https://example.com', intent: 'preview' },
      { url: 'https://example.com', app_tab: 'notes.board', intent: 'preview' },
      { intent: 'preview' },
    ]) {
      const invalid = await client.callTool({ name: 'session_open_in_tab', arguments: args })
      expect(invalid.isError).toBe(true)
      expect(responseText(invalid)).toContain('takes path (with app_tab to open it with that App), url, or app_tab')
    }
    expect(seen).toEqual(calls.map(({ dispatched }) => dispatched))
  })

  // #7379 复核:近况只给返回的这一页算 —— 切完窗才对窗内的行逐个走 get(宿主 readSessionPreview 的唯一入口);归档的不算。
  it('session_children 只为窗内的行要近况:5 个 child、rows:"1" 只走 1 次 get', async () => {
    const seen: Array<{ action: string; session_id?: string }> = []
    const children = [
      { session_id: 'c1', title: 'one', status: 'idle', detail: 'done', pinned: false },
      { session_id: 'c2', title: 'two', status: 'idle', detail: 'done', pinned: false },
      { session_id: 'c3', title: 'three', status: 'archived', detail: null, pinned: false },
      { session_id: 'c4', title: 'four', status: 'working', detail: 'running', pinned: false },
      { session_id: 'c5', title: 'five', status: 'idle', detail: 'done', pinned: false },
    ]
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runSessionAction: async (action) => {
        const a = action as { action: string; session_id?: string }
        seen.push(a)
        if (a.action !== 'get') return children
        if (a.session_id === 'c5') throw new Error('machine "B" (device:b) did not answer')
        return { session_id: a.session_id, status: children.find((row) => row.session_id === a.session_id)?.status, preview: { running: false, now: null, ended: { kind: 'done', reason: a.session_id === 'c1' ? 'refusal' : 'end_turn' }, entries: [] } }
      },
    })
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'session_children', arguments: args })
      expect(result.isError ?? false, responseText(result)).toBe(false)
      return JSON.parse(responseText(result)) as { total: number; items: Array<{ session_id: string; preview?: { ended?: unknown; error?: { message: string } } }> }
    }

    const first = await call({ rows: '1' })
    expect(first.total).toBe(4)
    expect(first.items[0]!.preview?.ended).toEqual({ kind: 'done', reason: 'refusal' })
    expect(seen.filter((a) => a.action === 'get')).toEqual([{ action: 'get', session_id: 'c1' }])

    seen.length = 0
    const rest = await call({ rows: '2-5' })
    // 先筛掉归档再切窗；c5 那台没答,原因落在它自己那一行。
    expect(seen.filter((a) => a.action === 'get').map((a) => a.session_id)).toEqual(['c2', 'c4', 'c5'])
    expect(rest.items.map((row) => row.session_id)).toEqual(['session:c2', 'session:c4', 'session:c5'])
    expect(rest.items.find((row) => row.session_id === 'session:c5')?.preview?.error?.message).toContain('did not answer')

    seen.length = 0
    const archived = await call({ status: 'archived' })
    expect(archived.total).toBe(1)
    expect(archived.items).toEqual([expect.objectContaining({ session_id: 'session:c3', status: 'archived' })])
    expect(archived.items[0]).not.toHaveProperty('preview')
    expect(seen).toEqual([{ action: 'children' }])

    for (const status of ['', 'idle', 'done']) {
      const filtered = await call({ status })
      expect(filtered.items.map((row) => row.session_id)).not.toContain('session:c3')
    }

    const direct = await client.callTool({ name: 'session_get', arguments: { session_id: 'session:c3' } })
    expect(direct.isError ?? false, responseText(direct)).toBe(false)
    expect(JSON.parse(responseText(direct))).toMatchObject({ session_id: 'session:c3', status: 'archived' })
  })

  // spec im-mcp 列表约定:rows / name / 工具自己的筛选在注册机判,❌ 进分派器;结果按宿主给的顺序切窗。
  it('列表工具:筛选与窗口在注册机做,分派器只收它自己的参数', async () => {
    const seen: unknown[] = []
    const children = [
      { session_id: 'c1', title: 'Review routing', status: 'working', detail: 'running', pinned: true },
      { session_id: 'c2', title: 'Review docs', status: 'needs_user', detail: 'approval', pinned: false },
      { session_id: 'c3', title: 'Review login', status: 'working', detail: 'parked', pinned: false },
      { session_id: 'c4', title: 'Fix build', status: 'working', detail: 'running', pinned: false },
      { session_id: 'c5', title: 'review cache', status: null, detail: null, pinned: false },
    ]
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runSessionAction: async (action) => {
        seen.push(action)
        return (action as { action: string }).action === 'get' ? { preview: null } : children
      },
    })
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: 'session_children', arguments: args })
      expect(result.isError ?? false, responseText(result)).toBe(false)
      return JSON.parse(responseText(result)) as { total: number; rows: string | null; next: string | null; items: Array<{ session_id: string }> }
    }

    const working = await call({ session_id: 'session:parent', name: 'REVIEW', status: 'working' })
    expect(working.items.map((row) => row.session_id)).toEqual(['session:c1', 'session:c3'])
    expect(working).toMatchObject({ total: 2, rows: '1-2', next: null })
    const waiting = await call({ status: 'approval' })
    expect(waiting.items.map((row) => row.session_id)).toEqual(['session:c2'])
    const pinned = await call({ pinned: true })
    expect(pinned.items.map((row) => row.session_id)).toEqual(['session:c1'])
    const second = await call({ rows: '2-3' })
    expect(second).toMatchObject({ total: 5, rows: '2-3', next: '4-5' })
    expect(second.items.map((row) => row.session_id)).toEqual(['session:c2', 'session:c3'])

    // 分派器收到的只有它自己的参数(session_id 已解码成存储形态)。
    expect(seen.filter((action) => (action as { action: string }).action === 'children')).toEqual([
      { action: 'children', session_id: 'parent' },
      { action: 'children' },
      { action: 'children' },
      { action: 'children' },
    ])

    // 写错的区间响亮地拒,并说清两种写法。
    const bad = await client.callTool({ name: 'session_children', arguments: { rows: 'first ten' } })
    expect(bad.isError).toBe(true)
    expect(responseText(bad)).toContain('rows must be a count like "20" or a range like "41-60"')
    // 词表外的状态词响亮地拒,并列出合法的词(词表只有 core 那一份)。
    const badStatus = await client.callTool({ name: 'session_children', arguments: { status: 'running-ish' } })
    expect(badStatus.isError).toBe(true)
    expect(responseText(badStatus)).toContain('status must be one of idle, working, needs_user, error, running')
  })

  // 目录类(harness / 模型 / 扩展)默认全给:模型表里 harness 自家那一组排在前,默认窗口会把咕咕那一组整个藏掉。
  it('目录类工具不传 rows 就全给,传了才切', async () => {
    const models = [
      ...Array.from({ length: 22 }, (_, i) => ({ id: `harness-${i}`, name: `Harness ${i}`, source: 'harness' })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `platform:gugu-${i}`, name: `Gugu ${i}`, source: 'gugu' })),
    ]
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runSessionAction: async () => ({ harness_id: 'claude', models, selected: null }),
    })
    const all = JSON.parse(responseText(await client.callTool({ name: 'session_list_models', arguments: {} })))
    expect(all).toMatchObject({ total: 25, rows: '1-25', next: null, harness_id: 'claude' })
    expect(all.models.filter((m: { source: string }) => m.source === 'gugu')).toHaveLength(3)
    const window = JSON.parse(responseText(await client.callTool({ name: 'session_list_models', arguments: { rows: '5' } })))
    expect(window).toMatchObject({ total: 25, rows: '1-5', next: '6-10' })
    const gugu = JSON.parse(responseText(await client.callTool({ name: 'session_list_models', arguments: { name: 'gugu' } })))
    expect(gugu.models.map((m: { id: string }) => m.id)).toEqual(['platform:gugu-0', 'platform:gugu-1', 'platform:gugu-2'])
  })

  it('扩展动作住在 app_* 工具里,前缀只在注册机剥一次', async () => {
    const seenSession: unknown[] = []
    const seenExtension: unknown[] = []
    const client = await connectTo({
      ...socialContext(async (action) => {
        seenSession.push(action)
        return { ok: true }
      }),
      runExtensionAction: async (action) => {
        seenExtension.push(action)
        return { ok: true }
      },
    })

    await client.callTool({ name: 'app_pack', arguments: { source_dir: '/apps/notes' } })
    await client.callTool({ name: 'session_children', arguments: {} })

    // 工具面叫 app_pack,宿主分派器收到的仍是 pack —— ❌ 别让工具面和执行侧各写一份动作名清单。
    expect(seenExtension).toEqual([{ action: 'pack', source_dir: '/apps/notes' }])
    expect(seenSession).toEqual([{ action: 'children' }])
  })

  // F15 (L7-d) app_pack { chat_id } 以 agent 本人往群里发卡片:没有咕咕身份的会话在打包之前就说清楚,❌ 包打出来了再报发不出去。
  it('app_pack 带 chat_id:没有咕咕身份的会话先拒,不打包', async () => {
    const seen: unknown[] = []
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runExtensionAction: async (action) => {
        seen.push(action)
        return { file_path: '/tmp/x.guguext', file_name: 'x-1.0.0.guguext' }
      },
    })
    const refused = await client.callTool({ name: 'app_pack', arguments: { source_dir: '/tmp/x', chat_id: 'c1' } })
    expect(refused.isError).toBe(true)
    expect(responseText(refused)).toContain('app_pack: chat_id needs a session with a Gugu identity')
    expect(seen).toEqual([])
    // 对照:不带 chat_id 就照旧打包,回包原样。
    const packed = await client.callTool({ name: 'app_pack', arguments: { source_dir: '/tmp/x' } })
    expect(JSON.parse(responseText(packed))).toEqual({ file_path: '/tmp/x.guguext', file_name: 'x-1.0.0.guguext' })
    expect(seen).toEqual([{ action: 'pack', source_dir: '/tmp/x' }])
  })

  it('只拿到扩展那一半的 grant:工具清单不缩水,缺的那半在调用时才报错', async () => {
    setExtensionCheckAvailable(true)
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runExtensionAction: async () => ({ packed: true }),
    })

    // ❌ 别用「不注册」实现「不许用」:工具清单在模型前缀里,少一个工具就是另一份前缀,
    // 整段继承来的上下文都命中不了缓存。
    const names = (await reachableTools(client)).map((tool) => tool.name)
    expect(new Set(names)).toEqual(new Set([...SESSION_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...LIBRARY_TOOL_NAMES, ...ACTIVITY_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...EXTENSION_TOOL_NAMES, ...ALWAYS_TOOL_NAMES]))

    const refused = await client.callTool({ name: 'session_children', arguments: {} })
    expect(refused.isError).toBe(true)
    expect(responseText(refused)).toContain('session_children is unavailable for this grant')

    // 对照:同一条 grant 上,它真拿得到的那一半必须通
    const allowed = await client.callTool({ name: 'app_pack', arguments: { source_dir: '/apps/notes' } })
    expect(allowed.isError ?? false).toBe(false)
    expect(JSON.parse(responseText(allowed))).toEqual({ packed: true })
  })

  it('只拿到会话那一半的 grant:app_* 同样注册,调用时报缺的那半', async () => {
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      // 宿主的 children 动作回的是一张表(session_children 按列表约定切窗)。
      runSessionAction: async () => [],
    })
    const names = (await reachableTools(client)).map((tool) => tool.name)
    expect(new Set(names)).toEqual(new Set([...SESSION_TOOL_NAMES, ...PROJECT_TOOL_NAMES, ...LIBRARY_TOOL_NAMES, ...ACTIVITY_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES, ...EXTENSION_TOOL_NAMES, ...ALWAYS_TOOL_NAMES]))
    const refused = await client.callTool({ name: 'app_pack', arguments: { source_dir: '/apps/notes' } })
    expect(refused.isError).toBe(true)
    expect(responseText(refused)).toContain('app_pack is unavailable for this grant')
    const allowed = await client.callTool({ name: 'session_children', arguments: {} })
    expect(allowed.isError ?? false).toBe(false)
  })

  it('审计行带 tool 字段,action 是注入分派动作后的对象(GUGU_SESSION_TEST_HOOKS)', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'gugu-session-tool-audit-'))
    const auditFile = join(auditDir, 'audit.jsonl')
    const previousHooks = process.env.GUGU_SESSION_TEST_HOOKS
    const previousFile = process.env.GUGU_SESSION_TOOL_AUDIT_FILE
    process.env.GUGU_SESSION_TEST_HOOKS = '1'
    process.env.GUGU_SESSION_TOOL_AUDIT_FILE = auditFile
    try {
      const client = await connectTo({
        kind: 'session-only',
        expectedOwnerUserId: 'owner-1',
        subjectId: 'agent-1',
        runSessionAction: async (action) => {
          if ((action as { action: string }).action === 'stop') throw new Error('stop failed')
          return { accepted: true }
        },
      })
      await client.callTool({ name: 'session_message', arguments: { to: ['session:child'], text: 'hi' } })
      await client.callTool({ name: 'session_stop', arguments: { session_id: 'session:child' } })

      const entries = (await readFile(auditFile, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { phase: string; tool?: string; action?: Record<string, unknown>; error?: { message?: string } })
      expect(entries.length).toBeGreaterThan(0)
      // 每一行都点名工具 —— 原子化后一条审计不再靠 action 猜它属于哪个工具。
      for (const entry of entries) expect(['session_message', 'session_stop']).toContain(entry.tool)
      const parsedMessage = entries.find((entry) => entry.phase === 'parsed' && entry.tool === 'session_message')
      expect(parsedMessage?.action).toEqual({ action: 'message', to: ['session:child'], text: 'hi' })
      expect(entries.some((entry) => entry.phase === 'success' && entry.tool === 'session_message')).toBe(true)
      const stopError = entries.find((entry) => entry.phase === 'error' && entry.tool === 'session_stop')
      expect(stopError?.error?.message).toBe('stop failed')
    } finally {
      if (previousHooks === undefined) delete process.env.GUGU_SESSION_TEST_HOOKS
      else process.env.GUGU_SESSION_TEST_HOOKS = previousHooks
      if (previousFile === undefined) delete process.env.GUGU_SESSION_TOOL_AUDIT_FILE
      else process.env.GUGU_SESSION_TOOL_AUDIT_FILE = previousFile
      await rm(auditDir, { recursive: true, force: true })
    }
  })
})

// #7221 schedule_*:给自己排的已安排。工具面只做两件事 —— 扁平参数原样交给会话分派器(动作名 = 工具名),
// 结果原样回来(schedule_id 由宿主自己编成 schedule:,注册机不碰);没有任何「目标会话」参数。
describe('schedule_* (#7221)', () => {
  it('三把工具交给会话分派器,参数原样、没有目标会话;schedule_create 原生列出,另两把在目录', async () => {
    const seen: unknown[] = []
    const client = await connectTo({
      kind: 'session-only',
      expectedOwnerUserId: 'owner-1',
      subjectId: 'agent-1',
      runSessionAction: async (action) => {
        seen.push(action)
        const dispatched = action as { action: string }
        if (dispatched.action === 'schedule_list') {
          return { schedules: [{ schedule_id: 'schedule:a', title: 'water' }, { schedule_id: 'schedule:b', title: 'agenda' }] }
        }
        if (dispatched.action === 'schedule_cancel') throw new Error('no schedule schedule:zzz of yours')
        return { schedule_id: 'schedule:new', next_run_at: '2026-10-16 08:00 Asia/Shanghai' }
      },
    })

    const listed = (await client.listTools()).tools.map((tool) => tool.name)
    expect(listed).toContain('schedule_create')
    expect(listed).not.toContain('schedule_list')
    expect(listed).not.toContain('schedule_cancel')

    const created = await client.callTool({
      name: 'schedule_create',
      arguments: { prompt: 'remind them to drink water', at: '2026-10-16T08:00', tz: 'Asia/Shanghai' },
    })
    expect(created.isError).toBeFalsy()
    expect(JSON.parse(responseText(created))).toEqual({ schedule_id: 'schedule:new', next_run_at: '2026-10-16 08:00 Asia/Shanghai' })

    // 只能给自己排:多给一个目标会话,schema 当场拒,到不了分派器。
    const elsewhere = await client.callTool({
      name: 'schedule_create',
      arguments: { prompt: 'x', cron: '0 8 * * *', session_id: 'session:other' },
    })
    expect(elsewhere.isError).toBe(true)

    const list = await client.callTool({ name: 'catalog_call', arguments: { tool: 'schedule_list', args: { name: 'agenda' } } })
    expect(JSON.parse(responseText(list)).schedules).toEqual([{ schedule_id: 'schedule:b', title: 'agenda' }])

    const cancelled = await client.callTool({ name: 'catalog_call', arguments: { tool: 'schedule_cancel', args: { schedule_id: 'schedule:zzz' } } })
    expect(cancelled.isError).toBe(true)
    expect(responseText(cancelled)).toContain('no schedule schedule:zzz of yours')

    expect(seen).toEqual([
      { action: 'schedule_create', prompt: 'remind them to drink water', at: '2026-10-16T08:00', tz: 'Asia/Shanghai' },
      { action: 'schedule_list' },
      { action: 'schedule_cancel', schedule_id: 'schedule:zzz' },
    ])
  })
})


describe('project_* tools', () => {
  it.each([undefined, 'device:peer'])('windows and filters project lists without changing their array shape (device: %s)', async (device_id) => {
    const seen: unknown[] = []
    const client = await connectTo(socialContext(async (action) => {
      seen.push(action)
      return [
        { project_id: 'p1', name: 'Alpha app', path: '/work/alpha' },
        { project_id: 'p2', name: 'Other', path: '/work/other' },
        { project_id: 'p3', name: 'Alpha docs', path: '/work/docs' },
      ]
    }))
    const list = async (args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: 'catalog_call', arguments: {
        tool: 'project_list', args: { ...(device_id ? { device_id } : {}), ...args },
      } })
      expect(result.isError ?? false).toBe(false)
      return JSON.parse(responseText(result))
    }
    expect(await list()).toMatchObject({ total: 3, rows: '1-3', next: null, items: [
      { project_id: 'project:p1' }, { project_id: 'project:p2' }, { project_id: 'project:p3' },
    ] })
    const first = await list({ name: 'alpha', rows: '1' })
    expect(first).toEqual({ total: 2, rows: '1-1', next: '2-2', items: [
      { project_id: 'project:p1', name: 'Alpha app', path: '/work/alpha' },
    ] })
    expect(await list({ name: 'alpha', rows: first.next })).toEqual({ total: 2, rows: '2-2', next: null, items: [
      { project_id: 'project:p3', name: 'Alpha docs', path: '/work/docs' },
    ] })
    expect(await list({ name: 'missing' })).toEqual({ total: 0, rows: null, next: null, items: [] })
    expect(seen).toEqual(Array(4).fill({ action: 'project_list', ...(device_id ? { device: 'peer' } : {}) }))
  })

  it('returns an empty remote project list as an empty page', async () => {
    const client = await connectTo(socialContext(async () => []))
    const result = await client.callTool({ name: 'catalog_call', arguments: {
      tool: 'project_list', args: { device_id: 'device:peer' },
    } })
    expect(result.isError ?? false).toBe(false)
    expect(JSON.parse(responseText(result))).toEqual({ total: 0, rows: null, next: null, items: [] })
  })

  it('advertises project operations in the catalog and routes typed IDs exactly once', async () => {
    const seen: unknown[] = []
    const client = await connectTo(socialContext(async (action) => {
      seen.push(action)
      return { project_id: 'p1', linked_project_id: 'p2', undo: { tool: 'project_remove_folder', project_id: 'p2', folder_id: 'folder1', device_id: 'target' } }
    }))
    expect((await reachableTools(client)).map((tool) => tool.name)).toEqual(expect.arrayContaining(PROJECT_TOOL_NAMES))
    const result = await client.callTool({ name: 'catalog_call', arguments: { tool: 'project_add_device', args: { project_id: 'project:p1', device_id: 'device:source', target_device_id: 'device:target', path: '/work/app' } } })
    expect(result.isError ?? false).toBe(false)
    expect(seen).toEqual([{ action: 'project_add_device', project_id: 'p1', device: 'source', target_device: 'target', path: '/work/app' }])
    // The host supplies the target device for composite operations; direct remote operations inherit their device.
    expect(JSON.parse(responseText(result))).toMatchObject({ project_id: 'project:p1', linked_project_id: 'project:p2', undo: { device_id: 'device:target', project_id: 'project:p2' } })
  })

  it('routes a confirmed existing project root through project_add_folder with typed source identity', async () => {
    const seen: unknown[] = []
    const client = await connectTo(socialContext(async (action) => {
      seen.push(action)
      return { project_id: 'target', source_project_id: 'source', linked_project_id: 'source' }
    }))
    const result = await client.callTool({ name: 'project_add_folder', arguments: {
      project_id: 'project:target', path: '/work/legacy', merge_existing: true, source_project_id: 'project:source',
    } })
    expect(result.isError ?? false).toBe(false)
    expect(seen).toEqual([{ action: 'project_add_folder', project_id: 'target', path: '/work/legacy', merge_existing: true, source_project_id: 'source' }])
    expect(JSON.parse(responseText(result))).toEqual({ project_id: 'project:target', source_project_id: 'project:source', linked_project_id: 'project:source' })
  })

  it('rejects bare or mismatched project/device IDs before dispatch', async () => {
    const seen: unknown[] = []
    const client = await connectTo(socialContext(async (action) => { seen.push(action); return {} }))
    for (const args of [{ project_id: 'p1' }, { project_id: 'session:p1' }, { device_id: 'b' }, { device_id: 'project:b' }]) {
      const result = await client.callTool({ name: 'project_get', arguments: args })
      expect(result.isError).toBe(true)
    }
    expect(seen).toEqual([])
  })

  it('undo of a remote folder operation keeps that device at the tool boundary', async () => {
    const client = await connectTo(socialContext(async () => ({ undo: { tool: 'project_add_folder', project_id: 'p2', path: '/work/docs' } })))
    const result = await client.callTool({ name: 'project_remove_folder', arguments: { project_id: 'project:p2', device_id: 'device:b', folder_id: 'folder1' } })
    expect(JSON.parse(responseText(result))).toEqual({ undo: { tool: 'project_add_folder', project_id: 'project:p2', device_id: 'device:b', path: '/work/docs' } })
  })

  it('a remote device unlink returns restore arguments accepted by the advertised tool', async () => {
    const chat_id = '00000000-0000-4000-8000-000000000123'
    const seen: unknown[] = []
    const client = await connectTo(socialContext(async (action) => {
      seen.push(action)
      return (action as { action: string }).action === 'project_remove_device'
        ? { undo: { tool: 'project_restore_device', project_id: 'p2', chat_id, expected_chat_id: null } }
        : { restored: true }
    }))
    const result = await client.callTool({ name: 'project_remove_device', arguments: { project_id: 'project:p2', device_id: 'device:b' } })
    const { tool, ...args } = JSON.parse(responseText(result)).undo
    expect((await client.callTool({ name: tool, arguments: args })).isError ?? false).toBe(false)
    expect(seen[1]).toEqual({ action: 'project_restore_device', project_id: 'p2', device: 'b', chat_id, expected_chat_id: null })
  })
})


it('Gugu’s built-in library is discovered on demand, keeps device routing, and refuses Ideas before host dispatch', async () => {
  const calls: unknown[] = []
  const client = await connectTo(socialContext(async action => {
    calls.push(action)
    return { root: '/gugu/library', volumes: [] }
  }))
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('library_read')
  const listed = await client.callTool({ name: 'catalog_call', arguments: { tool: 'library_list', args: { device_id: 'device:owned-device' } } })
  expect(listed.isError).not.toBe(true)
  expect(calls).toEqual([{ action: 'library_list', device: 'owned-device' }])
  const rejected = await client.callTool({ name: 'catalog_call', arguments: { tool: 'library_read', args: { kind: 'ideas' } } })
  expect(rejected.isError).toBe(true)
  expect(calls).toHaveLength(1)
})

it('saves a built-in capability entry through its actual device route without connecting or granting a service', async () => {
  const calls: unknown[] = []
  const client = await connectTo(socialContext(async action => { calls.push(action); return { id: 'note-id' } }))
  const saved = await client.callTool({ name: 'catalog_call', arguments: { tool: 'library_write', args: {
    device_id: 'device:owned-device', kind: 'capabilities', name: 'Calendar', group: 'Work', description: 'Appointments', content: 'Use existing connection.',
  } } })
  expect(saved.isError).not.toBe(true)
  expect(calls).toEqual([{ action: 'library_write', device: 'owned-device', kind: 'capabilities', name: 'Calendar', group: 'Work', description: 'Appointments', content: 'Use existing connection.' }])
})
