// #6615 会话经扩展网关调扩展程序:每会话每程序一条条目;每次调用现查权限、现找装着的那一版;调用方身份由网关写进 `_meta`,agent 写的一概到不了程序。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpMcpServer } from '../../../../apps/desktop/electron/acp-engine-utils'
import {
  buildExtensionGateway,
  createExtensionCatalog,
  createExtensionGatewayHost,
  forgetSessionAppScope,
  NOT_GIVEN,
  setSessionAppScope,
  SWITCHED_OFF,
  type ExtensionGatewayHost,
} from '../../../../apps/desktop/electron/extension-gateway'
import type { CloudMarketEntry } from '../../../../apps/desktop/src/session/shared/extensions/market'
import { parseExtensionTabKind, type ExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import type { CatalogTool } from '../../../../apps/desktop/electron/mcp/gugu-catalog-tools'
import type { ExtensionProgram, ExtensionPrograms } from '../../../../apps/desktop/electron/session/main/core/extensions/extension-programs'
import { revokeExtensionProgramAccess } from '../../../../apps/desktop/electron/session/main/core/extensions/extension-program-access'

const notes: ExtensionProgram = {
  extensionId: 'agent-notes', server: 'agent-notes', digest: 'v1', command: 'node', args: [], env: {}, cwd: '/x', dataDir: '/data/agent-notes',
}
const calls: CallToolRequest['params'][] = []
const calledVersions: string[] = []
let refusal: string | null = null
const addNote: Tool = { name: 'add_note', inputSchema: { type: 'object' } }
// #6635 MCP Apps: a tool whose visibility has no "model" is its extension's pages' alone.
const refreshView: Tool = { name: 'refresh_view', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } }
let toolList: Tool[] = [addNote, refreshView]
/** #6634 问题 16 What tools/list throws for a program, by its server name (the SDK's own words when the shape is wrong). */
const listFailures = new Map<string, string>()
/** What a program said about itself at its start (initialize `instructions`), by its server name. */
const instructionsNow = new Map<string, string>()
let installedNow: ExtensionProgram | undefined = notes
/** F16 What each call handed its program, and the files an agent may hand (item id → group). */
const handedPerCall: unknown[] = []
const handedChatsPerCall: unknown[] = []
const visibleTo = new Map<string, Map<string, string>>()
/** A1 The chats each agent is in (id, and public id → id). */
const memberOf = new Map<string, Set<string>>()
const publicIds = new Map<string, string>()
const programs: ExtensionPrograms = {
  registerNative: () => undefined,
  agentToolsRefusal: () => refusal,
  tools: async (program) => {
    const failure = listFailures.get(program.server)
    if (failure) throw new Error(failure)
    return toolList
  },
  instructions: (program) => instructionsNow.get(program.server),
  call: async (program, params, options) => {
    calls.push(params)
    calledVersions.push(program.digest)
    handedPerCall.push(options.handed)
    handedChatsPerCall.push(options.handedChats)
    return { content: [{ type: 'text', text: 'saved' }] }
  },
  handedFiles: async (agentUserId, itemIds) => itemIds.map((itemId) => {
    const chatId = visibleTo.get(agentUserId)?.get(itemId)
    if (!chatId) throw new Error(`${itemId}: not a chat file you can open, so it was not handed over`)
    return { itemId, chatId, agentUserId }
  }),
  handedChats: async (agentUserId, chatIds) => chatIds.map((named) => {
    const chatId = publicIds.get(named) ?? named
    if (!memberOf.get(agentUserId)?.has(chatId)) throw new Error(`${named}: not a chat you are in, so it was not handed over`)
    return { chatId, resourceChatId: chatId, agentUserId }
  }),
  killAllSync: () => {},
  setSource: () => {},
  installed: () => (installedNow ? [installedNow] : []),
  callFromPage: async () => {
    throw new Error('pages do not go through the gateway')
  },
}

/** The installed Apps the catalog reads beside the programs: here, one per App the programs come from. */
const manifestOf = (id: string, name = id, more: Partial<ExtensionManifest> = {}) =>
  ({ id, name, version: '1.0.0', contributes: { tabs: [] }, ...more }) as unknown as ExtensionManifest
const appsOf = (installed: () => ExtensionProgram[]) => () =>
  [...new Set(installed().map((program) => program.extensionId))].map((id) => ({ manifest: manifestOf(id), enabled: true, givesAgents: true }))
const noMarket = { market: async () => [] }
const withApps = { apps: appsOf(() => programs.installed()), ...noMarket }
/** #6634 问题 16 What the catalog says of the installed Apps a session cannot use: each one's `next`. */
const leftOut = async (catalog: ReturnType<typeof createExtensionCatalog>, session?: string) =>
  (await catalog.apps(session, false)).apps.filter((app) => app.state !== 'on').map((app) => app.next)

const hosts: ExtensionGatewayHost[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()))
  calls.length = 0
  calledVersions.length = 0
  handedPerCall.length = 0
  handedChatsPerCall.length = 0
  visibleTo.clear()
  memberOf.clear()
  publicIds.clear()
  toolList = [addNote, refreshView]
  listFailures.clear()
  instructionsNow.clear()
  refusal = null
  installedNow = notes
})

const hostOf = () => createExtensionGatewayHost(() => programs)

async function gatewayFor(host: ExtensionGatewayHost, agentId: string) {
  return buildExtensionGateway(host, { grantKey: `surface:${agentId}`, ownerUserId: 'owner-1', subjectId: `agent-${agentId}`, agentId }, [notes], (message) => {
    throw new Error(message)
  })
}

async function connect(entry: AcpMcpServer): Promise<Client> {
  if (entry.transport === 'stdio') throw new Error('expected an http entry')
  const client = new Client({ name: 'harness', version: '1.0.0' })
  const headers = Object.fromEntries(entry.headers.map(({ name, value }) => [name, value]))
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } }))
  clients.push(client)
  return client
}

describe('the extension gateway (#6615)', () => {
  it('revocation during caller preparation rejects the old call while a fresh call can proceed', async () => {
    const gate = Promise.withResolvers<void>()
    const preparing = Promise.withResolvers<void>()
    const catalog = createExtensionCatalog({ programs: () => programs, onProblem: message => { throw new Error(message) }, ...withApps,
      sessionContext: async () => { preparing.resolve(); await gate.promise; return null } })
    const tool = (await catalog.tools('old-session', 'conv-a'))[0]!
    let outcome = 'pending'
    const extra = { signal: new AbortController().signal, sendNotification: async () => {} } as unknown as Parameters<CatalogTool['run']>[1]
    const old = tool.run({}, extra).then(() => { outcome = 'completed' }, () => { outcome = 'interrupted' })
    try {
      await preparing.promise
      revokeExtensionProgramAccess(notes.extensionId)
      await expect.poll(() => outcome, { timeout: 1_000 }).toBe('interrupted')
    } finally {
      gate.resolve()
      await old
    }
    await new Promise(resolve => setImmediate(resolve))
    expect(calls).toHaveLength(0)
    const fresh = createExtensionCatalog({ programs: () => programs, onProblem: message => { throw new Error(message) }, ...withApps })
    await (await fresh.tools('new-session', 'conv-b'))[0]!.run({}, extra)
    expect(calls).toHaveLength(1)
  })

  it('gives each session its own entry per program, under the name the program always had', async () => {
    const host = hostOf()
    hosts.push(host)
    const a = await gatewayFor(host, 'conv-a')
    const b = await gatewayFor(host, 'conv-b')
    expect(a.origins).toEqual([{ name: 'agent-notes', extensionId: 'agent-notes' }])
    expect(a.servers[0]).toMatchObject({ name: 'agent-notes', transport: 'http', alwaysLoad: true, owner: 'integration' })
    // Claude Code keeps one server per address: two sessions on one address would lose one silently.
    expect((a.servers[0] as { url: string }).url).not.toBe((b.servers[0] as { url: string }).url)
  })

  it('what the agent writes in _meta never reaches the program: gugu writes all of it (no session ids: an App sees user:<uuid> only)', async () => {
    const host = hostOf()
    hosts.push(host)
    const a = await connect((await gatewayFor(host, 'conv-a')).servers[0]!)
    const b = await connect((await gatewayFor(host, 'conv-b')).servers[0]!)
    expect((await a.listTools()).tools.map((tool) => tool.name)).toEqual(['add_note'])
    await a.callTool({ name: 'add_note', arguments: { text: 'hi' }, _meta: { 'gugu/agentId': 'conv-b', other: 'x' } })
    await b.callTool({ name: 'add_note', arguments: {} })
    expect(calls.map((call) => call._meta)).toEqual([{}, {}])
    expect(calls[0]!.arguments).toEqual({ text: 'hi' })
  })

  it('never lists a page-only tool to a session, and refuses it when called by name (#6635)', async () => {
    const host = hostOf()
    hosts.push(host)
    const client = await connect((await gatewayFor(host, 'conv-a')).servers[0]!)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['add_note'])
    const refused = await client.callTool({ name: 'refresh_view', arguments: {} })
    expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: "tool refresh_view is for the App's own pages only" }] })
    expect(calls).toHaveLength(0)
  })

  it('refuses the next call of a running session once the extension may no longer give agents tools', async () => {
    const host = hostOf()
    hosts.push(host)
    const client = await connect((await gatewayFor(host, 'conv-a')).servers[0]!)
    await client.callTool({ name: 'add_note', arguments: {} })
    refusal = 'Extension agent-notes is turned off'
    const refused = await client.callTool({ name: 'add_note', arguments: {} })
    expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Extension agent-notes is turned off' }] })
    expect(calls).toHaveLength(1)
    expect((await client.listTools()).tools).toEqual([])
  })

  it('calls the version installed now: an upgrade reaches a running session at its next call', async () => {
    const host = hostOf()
    hosts.push(host)
    const client = await connect((await gatewayFor(host, 'conv-a')).servers[0]!)
    await client.callTool({ name: 'add_note', arguments: {} })
    installedNow = { ...notes, digest: 'v2' }
    await client.callTool({ name: 'add_note', arguments: {} })
    installedNow = undefined
    expect(await client.callTool({ name: 'add_note', arguments: {} })).toMatchObject({
      isError: true, content: [{ type: 'text', text: 'App agent-notes no longer ships program agent-notes' }],
    })
    expect(calledVersions).toEqual(['v1', 'v2'])
  })
})

// #6615 问题 11 —— 程序只知道「谁调的」,不知道「在哪个任务、哪个工作副本」:页面调用早就带 gugu/sessionId,agent 调用没有。
// W-21 实测两家都卡在这里(一家让页面转存路径,一家编了个不存在的 GUGU_PROJECT_DIR)。
describe('the caller task context in _meta (#6615 问题 11)', () => {
  // conv-a runs on a Gugu model; conv-b never chose one (its model is null: the key is left out, never '' or null).
  const where: Record<string, { sessionId: string; workspaceRoot: string | null; model: string | null }> = {
    'conv-a': { sessionId: 'task-a', workspaceRoot: '/work/a', model: 'platform:glm-5.3-flash' },
    'conv-b': { sessionId: 'task-b', workspaceRoot: null, model: null },
  }
  const sessionContext = async (agentId: string) => where[agentId] ?? null
  const extra = { signal: new AbortController().signal, sendNotification: async () => {} } as unknown as Parameters<CatalogTool['run']>[1]

  it('a native call carries the caller task, working copy and model; the agent cannot write them', async () => {
    const host = createExtensionGatewayHost(() => programs, undefined, { sessionContext })
    hosts.push(host)
    const a = await connect((await gatewayFor(host, 'conv-a')).servers[0]!)
    await a.callTool({ name: 'add_note', arguments: {}, _meta: { 'gugu/sessionId': 'forged', 'gugu/workspaceRoot': '/etc', 'gugu/model': 'platform:forged' } })
    expect(calls.map((call) => call._meta)).toEqual([
      { 'gugu/sessionId': 'task-a', 'gugu/workspaceRoot': '/work/a', 'gugu/model': 'platform:glm-5.3-flash' },
    ])
  })

  it('a catalog call carries the same; an unmounted working copy and an unchosen model are left out, not guessed; an unknown caller gets none', async () => {
    const catalog = createExtensionCatalog({ programs: () => programs, onProblem: (message) => { throw new Error(message) }, sessionContext, ...withApps })
    for (const agentId of ['conv-a', 'conv-b', 'conv-unknown']) await (await catalog.tools(`s-${agentId}`, agentId))[0]!.run({}, extra)
    expect(calls.map((call) => call._meta)).toEqual([
      { 'gugu/sessionId': 'task-a', 'gugu/workspaceRoot': '/work/a', 'gugu/model': 'platform:glm-5.3-flash' },
      { 'gugu/sessionId': 'task-b' },
      {},
    ])
  })

  it('a lookup that fails fails the call, loudly — never a silent call without context', async () => {
    const catalog = createExtensionCatalog({
      programs: () => programs, onProblem: (message) => { throw new Error(message) },
      sessionContext: async () => { throw new Error('task database is not open') },
      ...withApps,
    })
    await expect((await catalog.tools('s1', 'conv-a'))[0]!.run({}, extra)).rejects.toThrow('task database is not open')
    expect(calls).toHaveLength(0)
  })
})

describe('the extension catalog (#6615, D-10)', () => {
  const other: ExtensionProgram = { ...notes, extensionId: 'other-ext', server: 'main' }
  const extra = { signal: new AbortController().signal, sendNotification: async () => {} } as unknown as Parameters<CatalogTool['run']>[1]
  const catalogOf = (installed: () => ExtensionProgram[]) =>
    createExtensionCatalog({ programs: () => ({ ...programs, installed }), onProblem: (message) => { throw new Error(message) }, apps: appsOf(installed), ...noMarket })
  const names = (tools: CatalogTool[]) => tools.map((tool) => (tool.listed === false ? `(${tool.name})` : tool.name))

  it('holds every allowed extension under the native names, installs included the moment they happen; a natively listed one is there but not listed', async () => {
    let installed = [notes]
    const catalog = catalogOf(() => installed)
    expect(names(await catalog.tools('s1', 'conv-1'))).toEqual(['agent-notes__add_note'])
    catalog.listedNatively('s1', ['agent-notes'])
    expect(names(await catalog.tools('s1', 'conv-1'))).toEqual(['(agent-notes__add_note)'])
    installed = [notes, other]
    // 摩擦单 F119: named after the App alone, whatever its program is called (the parent: other-ext-main__add_note).
    expect(names(await catalog.tools('s1', 'conv-1'))).toEqual(['(agent-notes__add_note)', 'other-ext__add_note'])
    refusal = 'Extension other-ext is turned off'
    expect(await catalog.tools('s1', 'conv-1')).toEqual([])
  })

  it('runs the version installed now, listed natively or not: an upgrade reaches a running session at its next call', async () => {
    let installed = [notes]
    const catalog = catalogOf(() => installed)
    catalog.listedNatively('s2', ['agent-notes'])
    await (await catalog.tools('s1', 'conv-1'))[0]!.run({}, extra)
    installed = [{ ...notes, digest: 'v2' }]
    await (await catalog.tools('s1', 'conv-1'))[0]!.run({}, extra)
    await (await catalog.tools('s2', 'conv-2'))[0]!.run({ text: 'hi' }, extra)
    expect(calledVersions).toEqual(['v1', 'v2', 'v2'])
    expect(calls.map((call) => [call.name, call._meta, call.arguments])).toEqual([
      ['add_note', {}, {}],
      ['add_note', {}, {}],
      ['add_note', {}, { text: 'hi' }],
    ])
  })

  it('never offers a page-only tool, not even unlisted to a session that has the extension natively (#6635)', async () => {
    const catalog = catalogOf(() => [notes])
    expect(names(await catalog.tools('s1', 'conv-1'))).toEqual(['agent-notes__add_note'])
    catalog.listedNatively('s1', ['agent-notes'])
    expect(names(await catalog.tools('s1', 'conv-1'))).toEqual(['(agent-notes__add_note)'])
    toolList = [refreshView]
    expect(await catalog.tools('s1', 'conv-1')).toEqual([])
  })
})

describe('what the catalog leaves out, and why (#6634 问题 16)', () => {
  const todos: ExtensionProgram = { ...notes, extensionId: 'todo-panel', server: 'todos' }
  // The SDK's own multi-line words for a tools/list result without `tools`.
  const WRONG_SHAPE = `[
  {
    "expected": "array",
    "path": [ "tools" ],
    "message": "Invalid input: expected array, received undefined"
  }
]`
  const quietCatalog = (installed: () => ExtensionProgram[]) =>
    createExtensionCatalog({ programs: () => ({ ...programs, installed }), onProblem: () => {}, apps: appsOf(installed), ...noMarket })

  it('a program whose tools/list fails is named with its reason on one line; the rest of the catalog is untouched', async () => {
    listFailures.set('todos', WRONG_SHAPE)
    const catalog = quietCatalog(() => [notes, todos])
    expect((await catalog.tools('s1', 'conv-1')).map((tool) => tool.name)).toEqual(['agent-notes__add_note'])
    expect(await leftOut(catalog)).toEqual([
      'program todos: [ { "expected": "array", "path": [ "tools" ], "message": "Invalid input: expected array, received undefined" } ]',
    ])
  })

  // 摩擦单 F119: a name two programs of one App give is in the catalog for neither, and both are named — never one
  // silently over the other.
  it('two programs of one App giving the same tool: neither is in the catalog, and both are named', async () => {
    const catalog = quietCatalog(() => [notes, { ...notes, server: 'more' }])
    expect(await catalog.tools('s1', 'conv-1')).toEqual([])
    const why = 'agent-notes__add_note is given by programs agent-notes and more of one App — rename one'
    expect(await leftOut(catalog)).toEqual([`program agent-notes: ${why}; program more: ${why}`])
  })

  // 10-19 mac1: one App's program never answered initialize; the catalog asked the programs one by one and waited on it.
  it('a program that never answers: another App is asked alone, and a listing asks every program at once', async () => {
    const stuck: ExtensionProgram = { ...notes, extensionId: 'computer-use', server: 'computer-use' }
    const asked: string[] = []
    let answer!: (tools: Tool[]) => void
    const catalog = createExtensionCatalog({
      programs: () => ({
        ...programs,
        installed: () => [stuck, notes],
        tools: (program) => {
          asked.push(program.server)
          return program === stuck ? new Promise<Tool[]>((resolve) => { answer = resolve }) : programs.tools(program)
        },
      }),
      onProblem: () => {},
      apps: appsOf(() => [stuck, notes]),
      ...noMarket,
    })
    /** What the work gave once the event loop has turned a few times; undefined while it still waits. */
    const soon = async <T>(work: Promise<T>): Promise<T | undefined> => {
      let given: T | undefined
      void work.then((value) => { given = value })
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
      return given
    }
    expect((await soon(catalog.tools('s1', 'conv-1', undefined, 'agent-notes__add_note')))?.map((tool) => tool.name)).toEqual(['agent-notes__add_note'])
    expect(asked).toEqual(['agent-notes'])

    const listing = catalog.tools('s1', 'conv-1')
    expect(await soon(listing)).toBeUndefined()
    expect(asked).toEqual(['agent-notes', 'computer-use', 'agent-notes'])
    answer([])
    expect((await listing).map((tool) => tool.name)).toEqual(['agent-notes__add_note'])
  })

  // 10-19 mac1: 全能搜索 without a search key answered with only its settings page's tools — and vanished from the
  // catalog without a word, while a failed program is named with its reason.
  it('a program that gives agents no tools is named too, in its own words when it gave any; gone once it gives one', async () => {
    const catalog = quietCatalog(() => [notes])
    toolList = [refreshView]
    expect(await catalog.tools('s1', 'conv-1')).toEqual([])
    expect(await leftOut(catalog)).toEqual(['program agent-notes: gives agents no tools right now; its page in 「App」 shows how it is set up'])

    instructionsNow.set('agent-notes', '未配置搜索服务的 API key，请在全能搜索的设置页填写。')
    await catalog.tools('s1', 'conv-1')
    expect(await leftOut(catalog)).toEqual(['program agent-notes: gives agents no tools right now; it says: 未配置搜索服务的 API key，请在全能搜索的设置页填写。'])

    listFailures.set('agent-notes', 'did not start: exited with code 1')
    await catalog.tools('s1', 'conv-1')
    expect(await leftOut(catalog)).toEqual(['program agent-notes: did not start: exited with code 1; it says: 未配置搜索服务的 API key，请在全能搜索的设置页填写。'])

    listFailures.clear()
    toolList = [addNote, refreshView]
    expect((await catalog.tools('s1', 'conv-1')).map((tool) => tool.name)).toEqual(['agent-notes__add_note'])
    expect(await leftOut(catalog)).toEqual([])
  })

  // app_search read the programs' last listing only: asked first in a fresh session, an App whose program fails or gives
  // agents nothing was "on", pointing at tools that are not there.
  it("an App's state asks its programs itself: asked before any listing, it already says why", async () => {
    toolList = [refreshView]
    expect(await leftOut(quietCatalog(() => [notes]))).toEqual(['program agent-notes: gives agents no tools right now; its page in 「App」 shows how it is set up'])
    toolList = [addNote, refreshView]
    listFailures.set('agent-notes', 'did not start: exited with code 1')
    expect(await leftOut(quietCatalog(() => [notes]))).toEqual(['program agent-notes: did not start: exited with code 1'])
  })

  it('gone once the program lists; gone when it is uninstalled', async () => {
    let installed = [notes, todos]
    const catalog = quietCatalog(() => installed)
    listFailures.set('todos', 'did not start: spawn node ENOENT')
    await catalog.tools('s1', 'conv-1')
    expect(await leftOut(catalog)).toHaveLength(1)
    installed = [notes]
    expect(await leftOut(catalog)).toEqual([])
    installed = [notes, todos]
    listFailures.delete('todos')
    await catalog.tools('s1', 'conv-1')
    expect(await leftOut(catalog)).toEqual([])
  })

  it('an extension that may not give tools is named with the words a native entry answers with, once, over any listing failure', async () => {
    const refused = new Map([['todo-panel', 'Extension todo-panel may no longer give agents tools']])
    const installed = () => [notes, todos, { ...todos, server: 'archive' }]
    const catalog = createExtensionCatalog({
      programs: () => ({
        ...programs,
        installed,
        agentToolsRefusal: (extensionId) => refused.get(extensionId) ?? null,
      }),
      onProblem: () => {},
      apps: appsOf(installed),
      ...noMarket,
    })
    listFailures.set('todos', 'did not start: spawn node ENOENT')
    expect((await catalog.tools('s1', 'conv-1')).map((tool) => tool.name)).toEqual(['agent-notes__add_note'])
    expect(await leftOut(catalog)).toEqual(['Extension todo-panel may no longer give agents tools'])
    refused.clear()
    await catalog.tools('s1', 'conv-1')
    expect(await leftOut(catalog)).toEqual(['program todos: did not start: spawn node ENOENT'])
  })

  it('a start failure says what happened once, not「extension X: program P」twice', async () => {
    listFailures.set('todos', 'extension todo-panel: program todos did not start: spawn node ENOENT')
    const catalog = quietCatalog(() => [todos])
    await catalog.tools('s1', 'conv-1')
    expect(await leftOut(catalog)).toEqual(['program todos: did not start: spawn node ENOENT'])
  })
})

// 摩擦单 F16:程序要知道「是哪个 agent」—— 跨机器可寻址的 user:<uuid>,gugu.send 收的就是它;交给程序的群文件按调用它的
// agent 本人核一遍(agent 自己得在那个群里),只在这次调用期间交给程序。
describe('who called, and the files a call hands its program (F16)', () => {
  const AGENT = '0a000000-0000-4000-8000-000000000016'
  const ITEM = '0c000000-0000-4000-8000-000000000016'
  const CHAT = '0b000000-0000-4000-8000-000000000016'
  const followDoubts: Tool = {
    name: 'follow_doubts',
    inputSchema: { type: 'object', properties: { board: { type: 'string', format: 'gugu-file' }, card: { type: 'string' } } },
  }
  const extra = { signal: new AbortController().signal, sendNotification: async () => {} } as unknown as Parameters<CatalogTool['run']>[1]
  const catalog = () => createExtensionCatalog({ programs: () => programs, onProblem: (message) => { throw new Error(message) }, ...withApps })

  it('a native call carries the agent as user:<uuid>, and no session id; the agent cannot write it', async () => {
    const host = hostOf()
    hosts.push(host)
    const gateway = await buildExtensionGateway(host, { grantKey: 'surface:conv-a', ownerUserId: 'owner-1', subjectId: AGENT, agentId: 'conv-a' }, [notes], (message) => {
      throw new Error(message)
    })
    const client = await connect(gateway.servers[0]!)
    await client.callTool({ name: 'add_note', arguments: {}, _meta: { 'gugu/agent': 'user:forged' } })
    expect(calls.map((call) => call._meta)).toEqual([{ 'gugu/agent': `user:${AGENT}` }])
  })

  it('a catalog call carries the same; an id that is not a uuid is never passed off as one', async () => {
    await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({}, extra)
    await (await catalog().tools('s1', 'conv-b', 'agent-b'))[0]!.run({}, extra)
    expect(calls.map((call) => call._meta)).toEqual([{ 'gugu/agent': `user:${AGENT}` }, {}])
  })

  it('a gugu-file argument is checked as the caller and handed to the program for that call', async () => {
    toolList = [followDoubts]
    visibleTo.set(AGENT, new Map([[ITEM, CHAT]]))
    const result = await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ board: ITEM, card: '17' }, extra)
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'saved' }] })
    expect(handedPerCall).toEqual([[{ itemId: ITEM, chatId: CHAT, agentUserId: AGENT }]])
    expect(calls[0]!.arguments).toEqual({ board: ITEM, card: '17' })
  })

  // 群文件夹 App(#7155 重建,148 10-14):对一个文件的工具只带 item_id,chat_id 只在 list / create 上。agent 多传一个 chat_id
  // (ver3 里 Claude 给原生 workspace_download 多传,被 schema 拒 2/8)—— 网关不拒、原样交给程序,文件照样按 agent 本人核。
  // 用的是这个 App 真的 read 的 schema;原生和 catalog 两条路都走一遍。
  it('an argument the tool does not declare (a chat_id on the folder\'s read) is passed on as given, never refused; the file is still checked', async () => {
    const folderTools = new URL('../../../../apps/desktop/preinstalled-apps/workspace/tools.js', import.meta.url).href
    const { read } = (await import(/* @vite-ignore */ folderTools)) as Record<string, { inputSchema: Tool['inputSchema'] }>
    toolList = [{ name: 'read', inputSchema: read!.inputSchema }]
    visibleTo.set(AGENT, new Map([[ITEM, CHAT]]))
    const viaCatalog = await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ item_id: ITEM, chat_id: 211178 }, extra)
    expect(viaCatalog).toMatchObject({ content: [{ type: 'text', text: 'saved' }] })
    const host = hostOf()
    hosts.push(host)
    const gateway = await buildExtensionGateway(host, { grantKey: 'surface:conv-a', ownerUserId: 'owner-1', subjectId: AGENT, agentId: 'conv-a' }, [notes], (message) => {
      throw new Error(message)
    })
    const native = await (await connect(gateway.servers[0]!)).callTool({ name: 'read', arguments: { item_id: ITEM, chat_id: CHAT } })
    expect(native.isError).not.toBe(true)
    expect(handedPerCall).toEqual([[{ itemId: ITEM, chatId: CHAT, agentUserId: AGENT }], [{ itemId: ITEM, chatId: CHAT, agentUserId: AGENT }]])
    expect(calls.map((call) => call.arguments)).toEqual([{ item_id: ITEM, chat_id: 211178 }, { item_id: ITEM, chat_id: CHAT }])
  })

  it('counter-cells: a file the agent cannot open, or a caller with no agent id, is refused and the program never called', async () => {
    toolList = [followDoubts]
    const cannot = await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ board: ITEM }, extra)
    expect(cannot).toEqual({ isError: true, content: [{ type: 'text', text: `${ITEM}: not a chat file you can open, so it was not handed over` }] })
    const noAgent = await (await catalog().tools('s1', 'conv-b', undefined))[0]!.run({ board: ITEM }, extra)
    expect(noAgent).toMatchObject({ isError: true, content: [{ type: 'text', text: 'follow_doubts is handed a group file, and only an agent of that group can hand one' }] })
    expect(calls).toHaveLength(0)
  })

  // 片场 0.7.0 试演 10-12(第 6 条):a writer handed the table as the
  // gugu-file:// link the round's message carries — the link gugu.send itself writes — and it was refused as no file.
  describe('a gugu-file argument given as its gugu-file:// link', () => {
    const OTHER = '0c000000-0000-4000-8000-0000000000ff'
    const run = async (args: Record<string, unknown>) => (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run(args, extra)

    it('a link: the file it names is handed, checked as the caller, and reaches the program as its id', async () => {
      toolList = [followDoubts]
      visibleTo.set(AGENT, new Map([[ITEM, CHAT]]))
      await run({ board: `gugu-file://${ITEM}`, card: '17' })
      expect(handedPerCall).toEqual([[{ itemId: ITEM, chatId: CHAT, agentUserId: AGENT }]])
      expect(calls.map((call) => call.arguments)).toEqual([{ board: ITEM, card: '17' }])
    })

    it('an id: as before, handed and passed on as it is', async () => {
      toolList = [followDoubts]
      visibleTo.set(AGENT, new Map([[ITEM, CHAT]]))
      await run({ board: ITEM, card: '17' })
      expect(handedPerCall).toEqual([[{ itemId: ITEM, chatId: CHAT, agentUserId: AGENT }]])
      expect(calls.map((call) => call.arguments)).toEqual([{ board: ITEM, card: '17' }])
    })

    it('a link that names no file: handed as written, so refused, and the program never called', async () => {
      toolList = [followDoubts]
      visibleTo.set(AGENT, new Map([[ITEM, CHAT]]))
      for (const bad of ['gugu-file://not-an-id', `gugu-file://${ITEM}/notes.md`, `gugu-file:${ITEM}`, `https://gugu-file/${ITEM}`]) {
        expect(await run({ board: bad })).toEqual({ isError: true, content: [{ type: 'text', text: `${bad}: not a chat file you can open, so it was not handed over` }] })
      }
      expect(calls).toHaveLength(0)
    })

    // PR-2 评审 r3:the array path had no cell of its own — items left as written (变异 N2) went green.
    it('arrays: every item is handed and checked, and reaches the program as the id it was checked as — files and chats alike', async () => {
      const ITEM2 = '0c000000-0000-4000-8000-000000000017'
      toolList = [{
        name: 'compare_boards',
        inputSchema: { type: 'object', properties: {
          boards: { type: 'array', items: { type: 'string', format: 'gugu-file' } },
          chats: { type: 'array', items: { type: 'string', format: 'gugu-chat' } },
        } },
      }]
      visibleTo.set(AGENT, new Map([[ITEM, CHAT], [ITEM2, CHAT]]))
      memberOf.set(AGENT, new Set([CHAT]))
      publicIds.set('207957', CHAT)
      await run({ boards: [`gugu-file://${ITEM}`, ITEM2], chats: [207957] })
      expect(handedPerCall).toEqual([[{ itemId: ITEM, chatId: CHAT, agentUserId: AGENT }, { itemId: ITEM2, chatId: CHAT, agentUserId: AGENT }]])
      expect(handedChatsPerCall).toEqual([[{ chatId: CHAT, resourceChatId: CHAT, agentUserId: AGENT }]])
      expect(calls.map((call) => call.arguments)).toEqual([{ boards: [ITEM, ITEM2], chats: [CHAT] }])
    })

    it('a link to a file of a group the caller is not in: refused as that file, and the program never called', async () => {
      toolList = [followDoubts]
      visibleTo.set(AGENT, new Map([[ITEM, CHAT]]))
      expect(await run({ board: `gugu-file://${OTHER}` })).toEqual({ isError: true, content: [{ type: 'text', text: `${OTHER}: not a chat file you can open, so it was not handed over` }] })
      expect(calls).toHaveLength(0)
    })
  })

  it('a call handing nothing hands nothing', async () => {
    toolList = [followDoubts]
    await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ card: '17' }, extra)
    expect(handedPerCall).toEqual([[]])
    expect(handedChatsPerCall).toEqual([[]])
  })

  // A1: a chat an agent hands is checked as the agent, who must be in it; a public id reaches the program as the chat's id.
  const listFolder: Tool = {
    name: 'list',
    inputSchema: { type: 'object', properties: { chat_id: { type: 'string', format: 'gugu-chat' }, rows: { type: 'string' } } },
  }

  it('A1: a gugu-chat argument is checked as the caller and handed to the program for that call, as the chat\'s id', async () => {
    toolList = [listFolder]
    memberOf.set(AGENT, new Set([CHAT]))
    publicIds.set('207957', CHAT)
    await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ chat_id: CHAT, rows: '20' }, extra)
    await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ chat_id: '207957' }, extra)
    expect(handedChatsPerCall).toEqual([[{ chatId: CHAT, resourceChatId: CHAT, agentUserId: AGENT }], [{ chatId: CHAT, resourceChatId: CHAT, agentUserId: AGENT }]])
    expect(calls.map((call) => call.arguments)).toEqual([{ chat_id: CHAT, rows: '20' }, { chat_id: CHAT }])
  })

  // PR-2 评审 605898b:the number people see sent as a JSON number (A/B 10-12, Codex) is handed and checked here, like the same
  // number in quotes — made text in the program instead, it went past this check (the #6492 leak's shape).
  it('A1: the number people see sent as a JSON number is handed as its text, checked as the caller, and reaches the program as the chat\'s id', async () => {
    toolList = [listFolder]
    memberOf.set(AGENT, new Set([CHAT]))
    publicIds.set('207957', CHAT)
    await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ chat_id: 207957 }, extra)
    expect(handedChatsPerCall).toEqual([[{ chatId: CHAT, resourceChatId: CHAT, agentUserId: AGENT }]])
    expect(calls.map((call) => call.arguments)).toEqual([{ chat_id: CHAT }])
    // Checked as the caller: the number of a chat the agent is not in is refused, the program never called.
    const notIn = await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ chat_id: 208000 }, extra)
    expect(notIn).toEqual({ isError: true, content: [{ type: 'text', text: '208000: not a chat you are in, so it was not handed over' }] })
    expect(calls).toHaveLength(1)
    // Not a whole positive number: it names no chat, nothing is handed, and it reaches the program as sent (the folder refuses it).
    for (const bad of [1.5, -3, 0]) await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ chat_id: bad }, extra)
    expect(handedChatsPerCall.slice(1)).toEqual([[], [], []])
    expect(calls.slice(1).map((call) => call.arguments)).toEqual([{ chat_id: 1.5 }, { chat_id: -3 }, { chat_id: 0 }])
  })

  it('A1 counter-cells: a chat the agent is not in, or a caller with no agent id, is refused and the program never called', async () => {
    toolList = [listFolder]
    const notIn = await (await catalog().tools('s1', 'conv-a', AGENT))[0]!.run({ chat_id: CHAT }, extra)
    expect(notIn).toEqual({ isError: true, content: [{ type: 'text', text: `${CHAT}: not a chat you are in, so it was not handed over` }] })
    const noAgent = await (await catalog().tools('s1', 'conv-b', undefined))[0]!.run({ chat_id: CHAT }, extra)
    expect(noAgent).toMatchObject({ isError: true, content: [{ type: 'text', text: 'list is handed a group chat, and only an agent of that group can hand one' }] })
    expect(calls).toHaveLength(0)
  })
})

// D-30 (主人 10-06「肯定是能选的啊」): which agents get an App's tools is the owner's choice, read once per session. One not
// given to this session's agent is in neither its catalog nor its native entry, and asking for it says why.
describe('an App reaches only the sessions its owner gave it to (D-30)', () => {
  afterEach(() => {
    forgetSessionAppScope('given')
    forgetSessionAppScope('not-given')
    forgetSessionAppScope('surface:conv-out')
  })

  it('the catalog leaves it out of a session it is not given to, and says why; a session it is given to has it', async () => {
    setSessionAppScope('given', async (extensionId) => extensionId === 'agent-notes')
    setSessionAppScope('not-given', async () => false)
    const catalog = createExtensionCatalog({ programs: () => programs, onProblem: (message) => { throw new Error(message) }, ...withApps })
    expect((await catalog.tools('given', 'conv-a')).map((tool) => tool.name)).toEqual(['agent-notes__add_note'])
    expect(await catalog.tools('not-given', 'conv-b')).toEqual([])
    expect(await leftOut(catalog, 'not-given')).toEqual([NOT_GIVEN(['agent-notes'])])
    expect(await leftOut(catalog, 'given')).toEqual([])
    // Several left out so are named in the one sentence.
    expect(NOT_GIVEN(['a', 'b'])).toMatch(/^Apps a, b are not given to this agent: /)
  })

  it('#6387 its skills follow its tools: listed to a session it is given to, not to one it is not, nor once it may not give tools', async () => {
    setSessionAppScope('given', async (extensionId) => extensionId === 'agent-notes')
    setSessionAppScope('not-given', async () => false)
    const skill = (extensionId: string) => ({ extensionId, name: 'notes', description: 'Keep notes.', dir: `/apps/${extensionId}/skills/notes` })
    let refused: string | null = null
    const catalog = createExtensionCatalog({
      programs: () => ({ ...programs, agentToolsRefusal: () => refused }),
      onProblem: (message) => { throw new Error(message) },
      skills: () => [skill('agent-notes'), skill('other-ext')],
      ...withApps,
    })
    expect(await catalog.skills('given')).toEqual([skill('agent-notes')])
    expect(await catalog.skills('not-given')).toEqual([])
    refused = 'agent-notes may not give agents tools'
    expect(await catalog.skills('given')).toEqual([])
  })

  it('its native entry lists nothing to a session it is not given to and refuses a call, in the same words', async () => {
    setSessionAppScope('surface:conv-out', async () => false)
    const host = hostOf()
    hosts.push(host)
    const out = await connect((await gatewayFor(host, 'conv-out')).servers[0]!)
    expect((await out.listTools()).tools).toEqual([])
    const answer = await out.callTool({ name: 'add_note', arguments: {} })
    expect(answer).toMatchObject({ isError: true, content: [{ type: 'text', text: NOT_GIVEN(['agent-notes']) }] })
    expect(calls).toEqual([])
  })
})

// 10-19 owner「想想怎么多维度,分页筛选」: every App, with what this session can do with it and who does the next step — the
// records app_search filters. Read like the programs, so an App switched off or installed while a session runs is said at its next call.
describe('the Apps as app_search reads them (10-19)', () => {
  const entry = (id: string, more: Partial<CloudMarketEntry> = {}, manifest: Partial<ExtensionManifest> = {}) =>
    ({ manifest: manifestOf(id, id.toUpperCase(), { description: `${id} does a thing.`, ...manifest }), version: '1.0.0', publishedAt: '2026-10-10T00:00:00Z',
      firstPublishedAt: '2026-10-01T00:00:00Z', deprecated: null, compat: null, ...more }) as CloudMarketEntry & { firstPublishedAt: string }
  const installed = [
    { manifest: manifestOf('agent-notes', 'Notes', { contributes: { tabs: [{ name: 'board', title: 'Board' }] } } as Partial<ExtensionManifest>), enabled: true, givesAgents: true },
    { manifest: manifestOf('radar', '雷达'), enabled: false, givesAgents: true },
    { manifest: manifestOf('pomodoro', 'Pomodoro'), enabled: true, givesAgents: false },
  ]
  const catalogWith = (market: () => Promise<(CloudMarketEntry & { firstPublishedAt: string })[]>) =>
    createExtensionCatalog({ programs: () => ({ ...programs, agentToolsRefusal: () => null }), onProblem: () => {}, apps: () => installed, market })

  it('installed: on with its tab_kinds and where its tools are, or switched off with who switches it on and where', async () => {
    const { apps, market } = await catalogWith(async () => { throw new Error('the market is not read without withMarket') }).apps('s1', false)
    expect(market).toBeUndefined()
    expect(apps.map(({ manifest, ...rest }) => ({ id: manifest.id, ...rest }))).toEqual([
      { id: 'agent-notes', version: '1.0.0', state: 'on', next: 'catalog_list { name: "agent-notes" } lists its tools and skill. For a feature its tools or tabs do not provide, read guide_read apps-fork and ask "Shall I fork a version?" before making changes or building a workaround.', tabs: ['agent-notes.board'] },
      { id: 'radar', version: '1.0.0', state: 'off', next: SWITCHED_OFF('雷达') },
      { id: 'pomodoro', version: '1.0.0', state: 'on', next: 'It gives agents no tools: open one of its tabs with session_open_in_tab { app_tab }. For a feature its tools or tabs do not provide, read guide_read apps-fork and ask "Shall I fork a version?" before making changes or building a workaround.', tabs: [] },
    ])
    // The tab_kind handed out is what session_open_in_tab / app_check parse back (it replaced app_list's): never parts to assemble.
    expect(parseExtensionTabKind(apps[0]!.tabs![0]!)).toEqual({ extensionId: 'agent-notes', tabName: 'board' })
    expect(SWITCHED_OFF('雷达')).toMatch(/^Switched off on this computer\. You cannot switch it on: ask your owner to open 「App」 in 咕咕, open 雷达 there and press 「启用」 \(Turn on\); /)
  })

  // 5-minute game rounds 2-3 (10-29): a group App made in another chat read as 「on」 was taken for 「in this chat」.
  it('an App of chat files: on this computer, in no chat by itself — the row names the call that puts it into one', async () => {
    const group = { manifest: manifestOf('dinner-vote', 'Dinner vote', { contributes: { tabs: [{ name: 'main', title: 'Vote', opensFiles: { chat: ['.dinner-vote.json'] } }] } } as Partial<ExtensionManifest>), enabled: true, givesAgents: false }
    const catalog = createExtensionCatalog({ programs: () => ({ ...programs, agentToolsRefusal: () => null }), onProblem: () => {}, apps: () => [group], market: async () => [] })
    const [row] = (await catalog.apps('s1', false)).apps
    expect(row!.next).toContain(`It is on your owner's computer only, in no chat yet. Asked for in a chat, call app_install { app: "dinner-vote", chat_id: <that chat>, data } now, without asking first`)
  })

  it('the market: Apps not installed here, how to install each, who confirms; one this computer cannot install says why; deprecated ones are not offered; installed ones take its dates', async () => {
    const offered = [
      entry('agent-notes', { publishedAt: '2026-10-12T00:00:00Z' }),
      entry('turtle-soup', {}, { name: '海龟汤' }),
      entry('paper-club', {}, { permissions: { capabilities: ['chat:read'], network: ['arxiv.org'] } } as Partial<ExtensionManifest>),
      entry('future', { compat: { reason: 'needs-newer-app', minAppVersion: '9.0.0' } }),
      entry('old', { deprecated: { note: null, replacedBy: null } }),
    ]
    const { apps } = await catalogWith(async () => offered).apps('s1', true)
    expect(apps.find((app) => app.manifest.id === 'agent-notes')).toMatchObject({ state: 'on', publishedAt: '2026-10-12T00:00:00Z', firstPublishedAt: '2026-10-01T00:00:00Z' })
    expect(apps.filter((app) => app.state === 'market').map((app) => [app.manifest.id, app.next])).toEqual([
      ['turtle-soup', 'Not installed: catalog_call app_install { market: "turtle-soup" } installs it from the market, without asking anyone'],
      ['paper-club', 'Not installed: catalog_call app_install { market: "paper-club" } installs it from the market — the call itself asks your owner to confirm chat:read, arxiv.org before anything is installed'],
      ['future', 'Not installed, and this computer cannot install it: Extension future@1.0.0 needs gugu 9.0.0 or newer — ask the person to update gugu'],
    ])
  })

  it('a market not reached is said, and the installed Apps are still there', async () => {
    const { apps, market } = await catalogWith(async () => { throw new Error('fetch failed') }).apps('s1', true)
    expect(apps.map((app) => app.manifest.id)).toEqual(['agent-notes', 'radar', 'pomodoro'])
    expect(market).toBe('not reached (fetch failed); only the Apps installed here were searched')
  })
})
