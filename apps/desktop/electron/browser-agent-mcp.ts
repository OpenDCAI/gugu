import fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type CallToolRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { AcpMcpServer } from './acp-engine-utils'
import { GuguMcpHost, type GuguMcpHostPersistence } from './gugu-mcp-host'
import { createLogger } from './lib/logger'
import type { NativeAppProgram } from './session/main/core/extensions/extension-programs'
import type { ExtensionAgentStatus } from '../src/session/shared/extensions/agent-status'

const log = createLogger('browser-agent-mcp')

/**
 * #7191 会话的 agent 操作它会话页右侧的浏览器页签 —— 工具一个都不自己写,是 `@playwright/mcp` 原样的整套
 * (snapshot / click / type / navigate / screenshot …,Apache-2.0)。咕咕在这条链上只做三件事:
 *
 * - **连到哪个页签**:Playwright 经 `connectOverCDP(transport)` 连上来,transport 由会话页那一侧给
 *   (`emdashAgentBrowser.openTransport`,只报这条会话的一个页签,见 agent-browser.ts)。不开任何调试端口。
 * - **跟随 Agent 的调用生命周期**:取消时终止这一份连接的未完成动作,保留人的网页。浏览器没有独立暂停锁。
 * - **每条会话一份**:Playwright 的状态(快照里的 ref、当前页)是一条会话的,❌ 会话之间共用。
 *
 * 递给会话的是一台独立的 MCP server(`gugu-browser`),与 `gugu` 那台并列,和集成同一种做法(integration-mcp-bridge)。
 */
export const GUGU_BROWSER_MCP_SERVER_NAME = 'gugu-browser'

/** 会话页那一侧经桥给的动作(agent-browser.ts 的 `agentBrowserBridge`)。 */
export interface AgentBrowserBridge {
  states?: () => NonNullable<ExtensionAgentStatus['sessions']>
  openTransport: (sessionId: string, signal?: AbortSignal) => Promise<{ close(): void }>
  toolStarting: (sessionId: string) => { ok: true } | { ok: false; message: string }
  toolFinished: (sessionId: string) => void
  setInitialUrl: (sessionId: string, url: string | null) => void
  /** 这条会话的工作目录(拿不到 = null)。 */
  workspaceRoot: (sessionId: string) => Promise<string | null>
  /** #7199 云浏览器才有:请人登录(密码保险箱)/ 请人接手一步。结果话里永远不含账号密码。 */
  requestLogin?: (sessionId: string, args: { reason?: string }, signal?: AbortSignal) => Promise<{ ok: boolean; message: string }>
  requestTakeover?: (sessionId: string, args: { reason?: string }, signal?: AbortSignal) => Promise<{ ok: boolean; message: string }>
  /** 交回 agent 之前把工具结果里的已填密码盖掉(Playwright 的快照会写出密码框的值)。 */
  redact?: (text: string) => string
}

/**
 * 要脱敏时,工具不许自己挑文件名落盘(截图除外:图片里密码框本来就是圆点)。给了文件名的快照 / 控制台 / 网络记录
 * 会写进 agent 的工作目录、结果里只给个链接 —— redact 管不到文件里。去掉文件名,内容就回到结果里、照常被盖掉。
 */
export function withoutOwnFilename(name: string, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args || !('filename' in args) || name === 'browser_take_screenshot') return args
  const rest = { ...args }
  delete rest.filename
  return rest
}

/**
 * Playwright 自己落盘的文字也过一遍 redact:每个动作附带的整页快照(page-*.yml)默认就写成输出目录里的文件、
 * 结果里只给链接(0.0.83 实测),agent 会去读。只看这一步里新写的文字文件。
 */
export function redactOutputFiles(dir: string, sinceMs: number, redact: (text: string) => string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!/\.(ya?ml|log|md|txt|json)$/i.test(name)) continue
    const file = join(dir, name)
    try {
      const stat = fs.statSync(file)
      if (!stat.isFile() || stat.mtimeMs < sinceMs) continue
      const text = fs.readFileSync(file, 'utf8')
      const redacted = redact(text)
      if (redacted !== text) fs.writeFileSync(file, redacted)
    } catch (error) {
      log.warn({ file, error: (error as Error).message }, 'could not redact a browser output file')
    }
  }
}

/** 工具结果里每一段文字过一遍 redact;图片(截图里密码框本来就是圆点)原样。 */
export function redactToolResult(result: CallToolResult, redact: ((text: string) => string) | undefined): CallToolResult {
  if (!redact) return result
  return {
    ...result,
    content: result.content.map((part) => (part.type === 'text' ? { ...part, text: redact(part.text) } : part)),
  }
}

export interface BrowserAgentGrantContext {
  sessionId: string
  ownerUserId: string
  subjectId: string
  /** Explicit host role, never inferred from the workspace or the prompt. */
  personalAssistant?: true
}

export type BrowserAgentMcpHost = GuguMcpHost<BrowserAgentGrantContext>

type PlaywrightMcp = {
  createConnection: (config: object, contextGetter: () => Promise<unknown>) => Promise<{ connect(transport: unknown): Promise<void>; close(): Promise<void> }>
  chromium: { connectOverCDP: (transport: object) => Promise<{ contexts(): unknown[]; on(event: 'disconnected', listener: () => void): void }> }
}

let playwright: PlaywrightMcp | null = null

/**
 * 运行时从磁盘加载(根 dependencies,❌ 打进主进程包:它靠 `__dirname` 找自己的文件)。
 * `playwright-core` 从 `@playwright/mcp` 的位置解析 —— 连浏览器的和出工具的必须是同一份(它锁定的那个版本)。
 */
function loadPlaywright(): PlaywrightMcp {
  if (playwright) return playwright
  const requireHere = createRequire(__filename)
  const mcp = requireHere('@playwright/mcp') as Pick<PlaywrightMcp, 'createConnection'>
  const requireFromMcp = createRequire(requireHere.resolve('@playwright/mcp'))
  const core = requireFromMcp('playwright-core') as Pick<PlaywrightMcp, 'chromium'>
  playwright = { createConnection: mcp.createConnection, chromium: core.chromium }
  return playwright
}

/** Playwright 的工具组(`core*` 不论列不列都开,见 WITHHELD_TOOLS)。❌ 装浏览器、cookie / 存储 / 网络改写、devtools —— 这里操作的是会话页里的一个现成页签。 */
export const PLAYWRIGHT_CONFIG = {
  capabilities: ['core', 'core-navigation', 'core-input', 'vision'],
  // 页面自己注册的工具(实验中的 WebMCP)不收:网页内容对 agent 是不可信输入,❌ 让网页往 agent 的工具箱里加东西。
  webmcp: false,
  saveSession: false,
  // 本机文件(file://、上传)放行:agent 在这台电脑上本来就能读写文件,Playwright 自己也说这道闸「不是安全边界」;
  // 不放行时 agent 打不开刚写好的本地网页,而人在同一个页签里照样能打开 —— 只挡了 agent 一边。
  allowUnrestrictedFileAccess: true,
} as const

const SESSION_TOOL_TIMEOUT_MS = 120_000

export class SessionBrowserTools {
  /** Playwright 自动命名的输出(每个动作附带的页面快照、截图……)落在这里。 */
  readonly outputDir: string
  private connecting: Promise<Client> | null = null
  private closeServer: (() => Promise<void>) | null = null
  private transport: { close(): void } | null = null
  /**
   * 调用取消、会话结束或连接作废时拉下:还在搭的 Playwright、还在开的页签、刚连上的那一下都就此作罢 ——
   * ❌ 半截连上的一份留在页签上(之后重连会和它抢同一个 debugger 的消息)。
   */
  private readonly lifetime = new AbortController()

  constructor(
    private readonly sessionId: string,
    private readonly bridge: () => AgentBrowserBridge,
    private readonly onDisconnected: () => void,
  ) {
    this.outputDir = join(tmpdir(), 'gugu-agent-browser', sessionId)
  }

  client(): Promise<Client> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('the browser connection of this session was closed'))
    this.connecting ??= this.connect().catch((error: unknown) => {
      this.connecting = null
      throw error
    })
    return this.connecting
  }

  private async connect(): Promise<Client> {
    const { createConnection, chromium } = loadPlaywright()
    const signal = this.lifetime.signal
    const outputDir = this.outputDir
    const workspace = await this.bridge().workspaceRoot(this.sessionId)
    const server = await createConnection(
      { ...PLAYWRIGHT_CONFIG, outputDir },
      async () => {
        signal.throwIfAborted()
        const transport = await this.bridge().openTransport(this.sessionId, signal)
        if (signal.aborted) transport.close()
        signal.throwIfAborted()
        this.transport = transport
        const browser = await chromium.connectOverCDP(transport)
        if (signal.aborted) transport.close()
        signal.throwIfAborted()
        // 页签被关掉 / 人删了会话 → 连接断了:这一份作废,下一个动作重新连(会话没有页签就再开一个)。
        browser.on('disconnected', () => this.onDisconnected())
        const context = browser.contexts()[0]
        if (!context) throw new Error('the browser tab has no page to drive')
        return context
      },
    )
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = browserToolsClient(workspace ?? outputDir)
    await client.connect(clientSide)
    const closeServer = async () => {
      await client.close().catch(() => undefined)
      await server.close().catch(() => undefined)
    }
    if (signal.aborted) {
      await closeServer()
      signal.throwIfAborted()
    }
    this.closeServer = closeServer
    return client
  }

  async close(): Promise<void> {
    this.lifetime.abort()
    this.connecting = null
    const transport = this.transport
    this.transport = null
    const close = this.closeServer
    this.closeServer = null
    // Closing the MCP request alone does not cancel Playwright's pending locator actions.
    // Disconnect CDP synchronously so those actions cannot later reach the person's page.
    transport?.close()
    await close?.()
  }
}

/**
 * 连 Playwright 的那一端。它问「客户端的根目录」(MCP `roots/list`),agent 给了文件名的截图 / 快照 / 下载就落在那里;
 * ❌ 回答时它退回咕咕进程的工作目录 —— 装机包里是 `/`(写不进去),开发版里是代码仓(10-15 实撞:agent 存的截图
 * 「磁盘上找不到」,快照落进了代码仓)。答这条会话的工作目录,agent 在它自己的目录里找得到;没有工作目录就答输出目录。
 */
export function browserToolsClient(root: string): Client {
  const client = new Client({ name: 'gugu', version: '1.0.0' }, { capabilities: { roots: {} } })
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: pathToFileURL(root).href, name: 'session workspace' }] }))
  return client
}

/** 每条会话一份;会话结束(收回卡)时关掉。 */
const sessionTools = new Map<string, SessionBrowserTools>()

function toolsFor(sessionId: string, bridge: () => AgentBrowserBridge): SessionBrowserTools {
  let tools = sessionTools.get(sessionId)
  if (!tools) {
    const created: SessionBrowserTools = new SessionBrowserTools(sessionId, bridge, () => {
      if (sessionTools.get(sessionId) === created) sessionTools.delete(sessionId)
      void created.close()
    })
    tools = created
    sessionTools.set(sessionId, tools)
  }
  return tools
}

/** End this session's browser work, retaining the person's tab for the next turn. */
export async function closeSessionBrowserTools(sessionId: string): Promise<void> {
  const tools = sessionTools.get(sessionId)
  sessionTools.delete(sessionId)
  await tools?.close()
}

function refused(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

let appToolSchemas: Promise<Tool[]> | null = null
/** Listing a host capability must not acquire a page or launch a separate browser. */
function browserAppToolSchemas(): Promise<Tool[]> {
  appToolSchemas ??= (async () => {
    const server = await loadPlaywright().createConnection(PLAYWRIGHT_CONFIG, async () => {
      throw new Error('Tool schema listing cannot open a browser page')
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = browserToolsClient(tmpdir())
    try {
      await server.connect(serverSide)
      await client.connect(clientSide)
      return agentVisibleTools((await client.listTools()).tools)
    } finally {
      await client.close()
      await server.close()
    }
  })().catch((error: unknown) => { appToolSchemas = null; throw error })
  return appToolSchemas
}

async function callBrowserTool(bridge: () => AgentBrowserBridge, sessionId: string, params: CallToolRequest['params'],
  signal: AbortSignal, initialUrl?: string): Promise<CallToolResult> {
  if (signal.aborted) return refused('This browser action was cancelled with the Agent turn.')
  const local = answeredLocally(params.name)
  if (local) return local
  const person = PERSON_TOOLS.find((tool) => tool.name === params.name)
  if (person) return callPersonTool(bridge(), sessionId, person.name, params.arguments, signal)
  const gate = bridge().toolStarting(sessionId)
  if (!gate.ok) return refused(gate.message)
  // The App's default startUrl is about:blank, not an instruction to navigate on a key/snapshot reconnect.
  const url = params.name === 'browser_navigate' ? params.arguments?.url : initialUrl === 'about:blank' ? undefined : initialUrl
  if (typeof url === 'string' && url) bridge().setInitialUrl(sessionId, url)
  const redact = bridge().redact
  const startedAt = Date.now() - 1_000
  const tools = toolsFor(sessionId, bridge)
  const cancel = () => {
    if (sessionTools.get(sessionId) === tools) sessionTools.delete(sessionId)
    void tools.close().catch((error: unknown) => {
      log.warn({ sessionId, error: (error as Error).message }, 'could not close cancelled browser tools')
    })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) cancel()
    signal.throwIfAborted()
    const client = await tools.client()
    signal.throwIfAborted()
    const request = redact ? { ...params, arguments: withoutOwnFilename(params.name, params.arguments) } : params
    const result = await client.callTool(request, undefined, { signal, timeout: SESSION_TOOL_TIMEOUT_MS }) as CallToolResult
    if (redact) redactOutputFiles(tools.outputDir, startedAt, redact)
    return redactToolResult(result, redact)
  } catch (error) {
    log.warn({ sessionId, tool: params.name, error: (error as Error).message }, 'browser tool failed')
    return refused(`The browser tool could not run: ${(error as Error).message}`)
  } finally {
    signal.removeEventListener('abort', cancel)
    bridge().setInitialUrl(sessionId, null)
    bridge().toolFinished(sessionId)
  }
}

/** The browser is an App program: ordinary App consent, scope, disclosure and live revocation all apply. */
export function createBrowserAppProgram(bridge: () => AgentBrowserBridge): NativeAppProgram {
  const used = new Map<string, { sessions: Set<string>; calls: Set<Promise<CallToolResult>> }>()
  return {
    tools: browserAppToolSchemas,
    call(program, params, signal) {
      const sessionId = params._meta?.['gugu/sessionId']
      if (typeof sessionId !== 'string' || !sessionId) return Promise.resolve(refused('Browser Use needs a local Gugu session.'))
      let own = used.get(program.extensionId)
      if (!own) { own = { sessions: new Set(), calls: new Set() }; used.set(program.extensionId, own) }
      own.sessions.add(sessionId)
      const settings = JSON.parse(program.env.GUGU_APP_SETTINGS ?? '{}') as { startUrl?: unknown }
      const initialUrl = typeof settings.startUrl === 'string' ? settings.startUrl : undefined
      const call = callBrowserTool(bridge, sessionId, params, signal, initialUrl)
      own.calls.add(call)
      void call.finally(() => own.calls.delete(call)).catch(() => undefined)
      return call
    },
    status(extensionId) {
      const sessions = used.get(extensionId)?.sessions ?? new Set<string>()
      return { running: [...sessions].filter((id) => sessionTools.has(id)).length,
        sessions: (bridge().states?.() ?? []).filter((state) => sessions.has(state.sessionId)) }
    },
    async retire(extensionId) {
      const own = used.get(extensionId)
      used.delete(extensionId)
      if (!own) return
      await Promise.allSettled(own.calls)
      await Promise.all([...own.sessions].filter((id) => ![...used.values()].some((other) => other.sessions.has(id))).map(closeSessionBrowserTools))
    },
  }
}

/**
 * 不交给 agent 的(Playwright 把 `core*` 组一律打开,配置关不掉,只能在这里滤):
 * - `browser_run_code_unsafe`:在 Playwright 所在的进程里跑任意代码(它自己的说明就是「RCE-equivalent」),这里那个
 *   进程是咕咕主进程 —— 拿得到每个页签、每份浏览器配置的 cookie,一步越过「只交这一个页签」和调用的取消边界。
 * - `browser_tabs`:一条会话只操作一个页签,开 / 关页签在 transport 那一层一律被拒,留着只会让 agent 撞错。
 */
const WITHHELD_TOOLS = new Set(['browser_run_code_unsafe', 'browser_tabs'])

export function agentVisibleTools<T extends { name: string }>(tools: T[]): T[] {
  return tools.filter((tool) => !WITHHELD_TOOLS.has(tool.name))
}

/**
 * 在这里就应答、不转给 Playwright 的调用。`browser_close`:页签是人的,agent 做完 ❌ 把它关掉;
 * 转过去 Playwright 关的是整条连接,这条会话之后的浏览器动作也跟着断。
 */
export function answeredLocally(toolName: string): CallToolResult | null {
  if (WITHHELD_TOOLS.has(toolName)) return refused(`${toolName} is not available in Gugu's browser.`)
  if (toolName === 'browser_close') {
    return {
      content: [{ type: 'text', text: 'The tab stays open in the session so the person can see it; nothing was closed.' }],
    }
  }
  return null
}

/**
 * #7199 云浏览器多给的两个工具(Playwright 那套里没有、只有咕咕有的「请人来」):agent 卡在登录、验证码这类
 * 只有人能做的步骤时,❌ 在聊天里要密码、❌ 自己硬闯。工具挂着等人做完(最多 10 分钟),做完才返回。
 */
export const PERSON_TOOLS = [
  {
    name: 'browser_request_login',
    description:
      'Ask the person to log in to the site open in your browser tab. They type their username and password into Gugu\'s ' +
      'password vault and Gugu fills them into the login form; you never see them (a login the person saved is filled ' +
      'without asking). Use this whenever a page asks for a login: never ask for a password in chat and never type one ' +
      'yourself. Returns once the form is filled (then submit it) or the person declines.',
    inputSchema: {
      type: 'object' as const,
      properties: { reason: { type: 'string', description: 'One short line shown to the person, in their language: what the login is for.' } },
    },
  },
  {
    name: 'browser_request_takeover',
    description:
      'Ask the person to do one step on the page themselves: a CAPTCHA, an SMS or 2FA code, a payment confirmation, or ' +
      'anything you cannot or should not do. They take over the browser, do it and hand it back; this returns then. ' +
      'Take a fresh browser_snapshot afterwards.',
    inputSchema: {
      type: 'object' as const,
      properties: { reason: { type: 'string', description: 'One short line shown to the person, in their language: what they need to do.' } },
      required: ['reason'],
    },
  },
] as const

type PersonToolName = (typeof PERSON_TOOLS)[number]['name']

export function personToolsOf(bridge: AgentBrowserBridge): typeof PERSON_TOOLS[number][] {
  return PERSON_TOOLS.filter((tool) => (tool.name === 'browser_request_login' ? !!bridge.requestLogin : !!bridge.requestTakeover))
}

async function callPersonTool(
  bridge: AgentBrowserBridge,
  sessionId: string,
  name: PersonToolName,
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const reason = typeof args?.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 200) : undefined
  const ask = name === 'browser_request_login' ? bridge.requestLogin : bridge.requestTakeover
  if (!ask) return refused(`${name} is not available in this browser.`)
  const result = await ask(sessionId, reason ? { reason } : {}, signal)
  return { content: [{ type: 'text', text: result.message }], ...(result.ok ? {} : { isError: true }) }
}

export function createBrowserAgentMcpHost(
  bridge: () => AgentBrowserBridge,
  persistence?: GuguMcpHostPersistence,
): BrowserAgentMcpHost {
  return new GuguMcpHost<BrowserAgentGrantContext>(
    (getContext, grantSignal, trackRequest) => {
      const server = new McpServer(
        { name: GUGU_BROWSER_MCP_SERVER_NAME, version: '0.1.0' },
        { capabilities: { tools: {} } },
      )
      server.server.setRequestHandler(ListToolsRequestSchema, async () =>
        trackRequest(
          (async () => {
            return { tools: getContext().personalAssistant ? [] : [...await browserAppToolSchemas(), ...personToolsOf(bridge())] }
          })(),
          'tools/list',
        ),
      )
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
        trackRequest(
          (async (): Promise<CallToolResult> => {
            if (getContext().personalAssistant) return refused('Browser actions require a task agent on this device: session_spawn device=<device>.')
            return callBrowserTool(bridge, getContext().sessionId, request.params, AbortSignal.any([grantSignal, extra.signal]))
          })(),
          request.params.name,
        ),
      )
      return server
    },
    (context) => ({
      ownerId: context.ownerUserId,
      subjectId: context.subjectId,
      // Two fixed role surfaces, shared by all assistants / all executors respectively.
      // Like the Gugu grant, a key cannot change role without revocation.
      toolScope: GUGU_BROWSER_MCP_SERVER_NAME + (context.personalAssistant ? ':assistant' : ''),
    }),
    persistence,
  )
}

/**
 * 这条会话带不带浏览器工具。只给这台电脑上的会话(卡的 key 是 `taskpage:<会话>`)—— 别的机器上的会话
 * 由那台机器自己的咕咕给。拿不到就不带:少一组工具 agent 照样能用,❌ 把会话拖死。
 */
export async function buildBrowserAgentBridge(
  host: BrowserAgentMcpHost,
  grantKey: string,
  sessionId: string,
  ownerUserId: string,
  subjectId: string,
  personalAssistant?: true,
): Promise<AcpMcpServer[]> {
  try {
    await host.start()
    const grant = await host.grant(`${grantKey}:${GUGU_BROWSER_MCP_SERVER_NAME}`, { sessionId, ownerUserId, subjectId, ...(personalAssistant ? { personalAssistant } : {}) })
    if (personalAssistant) return []
    return [{
      name: GUGU_BROWSER_MCP_SERVER_NAME,
      transport: 'http',
      url: grant.url,
      headers: [{ name: 'Authorization', value: `Bearer ${grant.capability}` }],
      alwaysLoad: true,
      // 与集成同一档(McpServerOwner):由咕咕投递、不在各家静态能力包的名单里;用户可以在 `/mcp` 里为某条会话关掉它。
      // ❌ 'gugu':那一档专指 agent 靠它说话、不可关的那台。
      owner: 'integration',
    }]
  } catch (error) {
    log.warn({ grantKey, error: (error as Error).message }, 'browser tools unavailable for this session')
    return []
  }
}
