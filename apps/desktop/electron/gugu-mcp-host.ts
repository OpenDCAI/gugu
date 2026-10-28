import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { onErrorEvent } from '@gugu/session-shared'
import { createLogger } from './lib/logger'
import { agentEndpointServer, listenStable, type EndpointLog, type EndpointPorts, type PersistedRecords } from './session/main/lib/stable-endpoint'
const MCP_PATH = '/mcp'
const MCP_BODY_MAX_BYTES = 40 * 1024 * 1024
const MCP_DRAIN_TIMEOUT_MS = 5_000
const MCP_PAYLOAD_TOO_LARGE = Symbol('MCP_PAYLOAD_TOO_LARGE')
const log = createLogger('gugu-mcp-host')
export interface GuguMcpGrant { url: string; capability: string }
export interface GuguMcpGrantInvariant { ownerId: string; subjectId: string; toolScope: string }
/**
 * Track each tool call. When supplied, `toolName` is also recorded with its elapsed time so slow IM
 * calls identify the actual tool instead of leaving the host log to guess.
 */
export type GuguMcpRequestTracker = <T>(work: Promise<T>, toolName?: string) => Promise<T>
export type GuguMcpServerFactory<TContext> = (
  getContext: () => TContext,
  signal: AbortSignal,
  trackRequest: GuguMcpRequestTracker,
) => McpServer | Promise<McpServer>
const SLOW_TOOL_CALL_MS = 10_000

function trackToolCallDuration(work: Promise<unknown>, toolName: string): void {
  const startedAt = Date.now()
  const settle = (outcome: 'success' | 'error') => {
    const elapsedMs = Date.now() - startedAt
    const fields = { tool: toolName, elapsedMs, outcome }
    if (elapsedMs > SLOW_TOOL_CALL_MS) log.warn(fields, 'gugu MCP tool call exceeded 10s')
    else log.info(fields, 'gugu MCP tool call completed')
  }
  void work.then(() => settle('success'), () => settle('error'))
}
interface ClientRuntime {
  server: McpServer
  transport: StreamableHTTPServerTransport
  closing: Promise<void> | null
}
interface GrantRecord<TContext> {
  key: string
  capability: string
  /**
   * 这张卡自己的 URL 尾段 —— 只为**让每张卡有一个互不相同的地址**而存在,不做鉴权
   * (鉴权仍然只认 Authorization 里的 capability,路径是公开的、可猜的)。
   *
   * 为什么非有不可:从前每张卡都返回同一个 `http://127.0.0.1:<port>/mcp`,只靠 bearer 区分。
   * 一台宿主上只有一张卡时没事;而**集成**是一条会话上 N 张卡(linear、notion……),于是
   * harness 拿到 N 台 URL 完全相同的 server —— Claude Code 按地址去重,只连上第一台,
   * 后面的**静默消失**:不报错、不留日志,模型只是少一组工具。
   * owner 2026-09-15 实测:授权了 Notion,新会话里 `gugu`、`linear` 在,`notion` 不在。
   */
  slot: string
  context: TContext
  invariant: GuguMcpGrantInvariant
  revoked: boolean
  /**
   * 这张卡送出过 `tools/list` 应答。随卡落盘:宿主重启后认回同一张卡,接回的引擎还是当初 list 过它的那一个
   * (它不一定再 list:端口早绑时它只丢了 SSE 流,留着原来的 MCP 会话)。撤销、重新签发的卡从 false 起。
   */
  toolsListed: boolean
  clientsByMcpSession: Map<string, ClientRuntime>
  opening: Set<Promise<ClientRuntime>>
  closing: Set<ClientRuntime>
  activeRequests: Set<Promise<unknown>>
  abortController: AbortController
}
/** 落盘的一张卡:只有凭据与卡面,❌ 上下文(那是闭包,新进程由 restore 重建)。 */
export type PersistedGuguMcpGrant = { key: string; capability: string; slot: string; invariant: GuguMcpGrantInvariant; toolsListed?: boolean }

/**
 * #6264 让发出去的卡活过宿主进程重启(见 session/main/lib/stable-endpoint.ts):端口绑回原来那个,卡的凭据与地址落盘,
 * 新进程把它们原样认回来。重启前的 agent 拿着旧卡来敲门时,卡在盘上却还没人重新发过(那条会话还没被重新接上),
 * 就请 `restore` 把那条会话唤醒 —— 唤醒走的是正常起会话的路,会对同一个 key 再 grant 一次,
 * 而同一个 key、同一张卡面拿回的正是盘上那张卡。
 */
export interface GuguMcpHostPersistence {
  name: string
  ports: EndpointPorts
  grants: PersistedRecords<PersistedGuguMcpGrant>
  restore?: (key: string) => Promise<void>
  log: EndpointLog
  /** 唤醒最多等这么久(默认 60 秒),等不到这一次按没授权答。 */
  restoreTimeoutMs?: number
}

export class GuguMcpHost<TContext> {
  private server: Server | null = null
  private starting: Promise<void> | null = null
  private endpoint = ''
  private disposed = false
  private disposing: Promise<void> | null = null
  private readonly grants = new Map<string, GrantRecord<TContext>>()
  private readonly retiredGrants = new Map<string, GrantRecord<TContext>>()
  private readonly createMcpServer: GuguMcpServerFactory<TContext>
  private readonly invariantOf: (context: TContext) => GuguMcpGrantInvariant
  private readonly toolsListedListeners = new Map<string, Set<() => void>>()
  private readonly persistence: GuguMcpHostPersistence | null
  /** 盘上有、这个进程还没重新发过的卡(按 key)。 */
  private readonly dormant = new Map<string, PersistedGuguMcpGrant>()
  private readonly restoring = new Map<string, Promise<void>>()
  constructor(
    createMcpServer: GuguMcpServerFactory<TContext>,
    invariantOf: (context: TContext) => GuguMcpGrantInvariant,
    persistence?: GuguMcpHostPersistence,
  ) {
    this.createMcpServer = createMcpServer
    this.invariantOf = invariantOf
    this.persistence = persistence ?? null
    for (const record of this.persistence?.grants.list() ?? []) {
      if (typeof record.capability === 'string' && typeof record.slot === 'string' && record.invariant) {
        this.dormant.set(record.key, record)
      }
    }
  }
  async start(): Promise<void> {
    if (this.disposed) throw new Error('Gugu MCP host is disposed')
    if (this.endpoint) return
    if (this.starting) return this.starting
    const server = agentEndpointServer((request, response) => {
      if (!isLocalRequest(request)) {
        log.warn({ host: request.headers.host ?? null, origin: request.headers.origin ?? null }, 'MCP request from a non-local Host or Origin refused')
        return void response.writeHead(403).end()
      }
      const path = request.url?.split('?')[0] ?? ''
      // `/mcp` 与 `/mcp/<slot>` 都收:尾段只是让同一台宿主上的多张卡有互不相同的地址(见 GrantRecord.slot),
      // ❌ 不参与鉴权 —— 谁能进仍然只由 Authorization 里的 capability 决定。
      if (path !== MCP_PATH && !path.startsWith(`${MCP_PATH}/`)) {
        return void response.writeHead(404).end()
      }
      if (!this.authorize(request) && this.dormantFor(request)) {
        void this.restoreThenHandle(request, response)
        return
      }
      const record = this.authorize(request)
      // @@@3643-diag 请求级追踪(debug):#3551 把「host 收到了没返回」与「host 根本没收到」标为 UNMEASURED,
      // 而两者在客户端侧完全同形。这一行让它们分得开;默认 info 级不出声,排查时开 GUGU_LOG_LEVEL=debug。
      log.debug({ method: request.method, authorized: Boolean(record), hasMcpSession: Boolean(request.headers['mcp-session-id']) }, 'MCP request in')
      if (!record) return void response.writeHead(401).end()
      const handling = this.handleMcp(record, request, response)
      if (request.method === 'POST') {
        record.activeRequests.add(handling)
        void handling.finally(() => record.activeRequests.delete(handling))
      } else void handling
    })
    this.server = server
    const persistence = this.persistence
    const starting = persistence
      ? listenStable(server, { name: persistence.name, ports: persistence.ports, log: persistence.log }).then(({ port }) => {
          onErrorEvent(server, (error) => {
            log.error({ err: error }, 'Gugu MCP host server error')
          })
          this.endpoint = `http://127.0.0.1:${port}${MCP_PATH}`
        })
      : new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        // @@@unhandled-error-event (#4942) — 为什么摘掉 reject 之后必须立刻补一条长期出口:上面那条
        // `once('error', reject)` 只该活到 bind 结束(不摘就泄漏一个会 reject 已 settle 的 Promise 的闭包),
        // 但 listen 成功后 accept 期照样会出错(EMFILE 打满 fd、ECONNABORTED),而 Node 对**没有监听者**的
        // 'error' 一视同仁地抛成未捕获异常 —— 这台 host 跑在 Electron 主进程里,那等于整个宿主连同所有
        // 会话一起死。这类失败是**异步**送达的,start() 外面那圈 try/catch 一次也接不住。
        // ❌ 不是吞错:错误照旧落日志报出去,这里只切断「没人接 ⇒ 进程死」这条与错误本身无关的致命路径。
        onErrorEvent(server, (error) => {
          log.error({ err: error }, 'Gugu MCP host server error')
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Gugu MCP host did not bind TCP'))
        } else {
          this.endpoint = `http://127.0.0.1:${address.port}${MCP_PATH}`
          resolve()
        }
      })
    })
    this.starting = starting
    try {
      await starting
    } catch (error) {
      this.server = null
      server.close()
      throw error
    } finally {
      this.starting = null
    }
  }
  /**
   * 发一格授权。同一个 key 反复来:卡面(owner / subject / toolScope)全同 ⇒ 换上下文、沿用旧卡;
   *
   * **换主人 ⇒ 撤旧发新**(#4277 owner 拍板:会话不带账号,起 agent 那一刻读当下登录的是谁就以它跑)。
   * 旧卡上在飞的调用被中止——它们本来也过不了 acp-engine-utils 里逐调用的身份核对(auth.userId !==
   * expectedOwnerUserId ⇒ 抛),这里只是让它们死得早一点、不再挂着一张已经没主人的卡。
   *
   * 同主人却改 subject / toolScope ⇒ 仍然报错:那不是账号切换,是两条腿对同一条会话说了两种话
   * (编程错误),悄悄换掉会让工具面在两条腿之间漂。
   */
  private grantUrl(slot: string): string {
    return `${this.endpoint}/${slot}`
  }
  async grant(key: string, context: TContext): Promise<GuguMcpGrant> {
    if (this.disposed) throw new Error('Gugu MCP host is disposed')
    if (!this.server || !this.endpoint) throw new Error('Gugu MCP host is not started')
    const invariant = this.readInvariant(context)
    const existing = this.grants.get(key)
    if (existing) {
      if (sameInvariant(existing.invariant, invariant)) {
        existing.context = context
        return { url: this.grantUrl(existing.slot), capability: existing.capability }
      }
      if (existing.invariant.ownerId !== invariant.ownerId) {
        log.info(
          { key, from: existing.invariant.ownerId, to: invariant.ownerId },
          'gugu MCP grant changes owner: retiring the old grant and issuing a fresh one',
        )
        await this.revoke(key)
      } else {
        throw new Error(`Gugu MCP grant ${key} cannot change subject or tool scope under the same owner`)
      }
    }
    if (this.retiredGrants.has(key)) throw new Error(`Gugu MCP grant ${key} is still closing`)
    let capability: string
    let slot: string
    let toolsListed = false
    // #6264 同一个 key、同一张卡面在盘上有一张(重启前发的,agent 还拿着)⇒ 原样发回那一张,❌ 另起一张。
    const previous = this.dormant.get(key)
    this.dormant.delete(key)
    if (previous && sameInvariant(previous.invariant, invariant)) {
      capability = previous.capability
      slot = previous.slot
      toolsListed = previous.toolsListed === true
    } else {
      do capability = randomBytes(24).toString('base64url')
      while ([...this.grants.values()].some((record) => record.capability === capability))
      do slot = randomBytes(9).toString('base64url')
      while ([...this.grants.values()].some((record) => record.slot === slot))
    }
    this.grants.set(key, {
      key, capability, slot, context, invariant, revoked: false, toolsListed,
      clientsByMcpSession: new Map(), opening: new Set(), closing: new Set(), activeRequests: new Set(),
      abortController: new AbortController(),
    })
    this.persistence?.grants.put({ key, capability, slot, invariant, toolsListed })
    return { url: this.grantUrl(slot), capability }
  }
  /**
   * 「宿主为 grant `key` 送出了一次 `tools/list` 应答」—— 一条 transport 级事实,本 host 不解释它意味着什么
   * (那归认领者:spec delivery-routing「session-live 的产地」,claude TUI 拿它当可投递就绪,#4896)。
   * 通知点在 `handleRequest` 返回之后:SDK 1.29 的 node 适配器把 web Response 流完整写进 node response 后
   * 才 resolve(SSE 模式下 JSON-RPC 应答由 `send()` 关流),所以此刻应答已经在线上,且只在 HTTP 200 时通知。
   * 同一 grant 每个 client session 的每次 tools/list 都通知;订阅者自己做幂等。返回取消订阅。
   */
  onToolsListed(key: string, listener: () => void): () => void {
    const listeners = this.toolsListedListeners.get(key) ?? new Set<() => void>()
    listeners.add(listener)
    this.toolsListedListeners.set(key, listeners)
    return () => {
      const current = this.toolsListedListeners.get(key)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.toolsListedListeners.delete(key)
    }
  }
  /** 这张卡已经送出过 `tools/list` 应答(含宿主重启前) —— 晚于那一刻才来问的人(接回的会话)读这份状态。 */
  hasListedTools(key: string): boolean {
    return this.grants.get(key)?.toolsListed === true
  }
  private emitToolsListed(key: string): void {
    const listeners = this.toolsListedListeners.get(key)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        log.error({ key, err: error }, 'tools/list listener failed')
      }
    }
  }
  async revoke(key: string): Promise<void> {
    // 正式收回(会话真结束、换了主人):盘上那张也作废 —— 只有进程退出 ❌ 算收回(dispose 不动盘)。
    this.dormant.delete(key)
    this.persistence?.grants.remove(key)
    const record = this.grants.get(key) ?? this.retiredGrants.get(key)
    if (!record) return
    this.grants.delete(key)
    record.revoked = true
    record.abortController.abort()
    this.retiredGrants.set(key, record)
    await this.closeGrant(record)
    this.retiredGrants.delete(key)
  }
  /**
   * #6938 收回发给这个身份的每一张卡(活的与盘上休眠的),逐张走 revoke。身份从名册上删掉了(云端已经没有它),
   * 发给它的卡就跟着作废:不撤的话,这条会话下次以新身份要卡时,撞上 grant 里「同主人改 subject」那道检查。
   */
  async revokeSubject(subjectId: string): Promise<void> {
    const keys = new Set<string>()
    for (const [key, record] of this.grants) if (record.invariant.subjectId === subjectId) keys.add(key)
    for (const [key, record] of this.dormant) if (record.invariant.subjectId === subjectId) keys.add(key)
    const errors = rejectedReasons(await Promise.allSettled([...keys].map((key) => this.revoke(key))))
    if (errors.length) throw new AggregateError(errors, `Failed to revoke the Gugu MCP grants of ${subjectId}`)
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    const disposing = this.disposeOwned().finally(() => {
      if (this.disposing === disposing) this.disposing = null
    })
    this.disposing = disposing
    return disposing
  }
  private async disposeOwned(): Promise<void> {
    this.disposed = true
    await this.starting?.catch(() => undefined)
    const server = this.server
    this.endpoint = ''
    for (const [key, record] of this.grants) {
      record.revoked = true
      record.abortController.abort()
      this.retiredGrants.set(key, record)
    }
    this.grants.clear()
    const records = [...this.retiredGrants.entries()]
    const results = await Promise.allSettled(records.map(async ([key, record]) => {
      await this.closeGrant(record)
      this.retiredGrants.delete(key)
    }))
    const errors = rejectedReasons(results)
    if (server) {
      server.closeAllConnections?.()
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          })
        }
        this.server = null
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Failed to dispose Gugu MCP host')
  }
  /** 拿着的是一张「盘上有、还没重新发」的卡吗(常量时间比较,同 authorize)。 */
  private dormantFor(request: IncomingMessage): PersistedGuguMcpGrant | null {
    if (!this.persistence?.restore || this.dormant.size === 0) return null
    const header = request.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
    let match: PersistedGuguMcpGrant | null = null
    for (const record of this.dormant.values()) {
      if (constantTimeEqual(presented, record.capability)) match = record
    }
    return match
  }
  /** 先把那条会话唤醒(它会重新发同一张卡),再照常处理这一个请求。同一个 key 同时只唤醒一次。 */
  private async restoreThenHandle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const dormant = this.dormantFor(request)
    const restore = this.persistence?.restore
    if (dormant && restore) {
      let pending = this.restoring.get(dormant.key)
      if (!pending) {
        const timeoutMs = this.persistence?.restoreTimeoutMs ?? 60_000
        pending = Promise.race([
          restore(dormant.key),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('restore timed out')), timeoutMs).unref?.()),
        ]).finally(() => this.restoring.delete(dormant.key))
        this.restoring.set(dormant.key, pending)
      }
      try {
        await pending
        log.info({ key: dormant.key }, 'gugu MCP grant from before the restart is live again')
      } catch (error) {
        log.warn({ key: dormant.key, err: error }, 'gugu MCP grant from before the restart could not be restored')
      }
    }
    const record = this.authorize(request)
    if (!record) return void response.writeHead(401).end()
    const handling = this.handleMcp(record, request, response)
    if (request.method === 'POST') {
      record.activeRequests.add(handling)
      void handling.finally(() => record.activeRequests.delete(handling))
    }
    await handling
  }
  private authorize(request: IncomingMessage): GrantRecord<TContext> | null {
    const header = request.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
    let match: GrantRecord<TContext> | null = null
    for (const record of this.grants.values()) {
      if (constantTimeEqual(presented, record.capability)) match = record
    }
    return match
  }
  private async handleMcp(record: GrantRecord<TContext>, request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (record.revoked) return void response.writeHead(401).end()
      const mcpSessionId = request.headers['mcp-session-id']
      if (typeof mcpSessionId === 'string' && mcpSessionId) {
        const runtime = record.clientsByMcpSession.get(mcpSessionId)
        if (!runtime) return void response.writeHead(404).end()
        // GET = 这个 MCP 会话的 standalone SSE 流,handleRequest 要等它关掉才返回 ⇒ 保活要在它之前挂上。
        const stopKeepalive = request.method === 'GET' ? keepSseStreamAlive(response) : null
        try {
          const body = request.method === 'POST' ? await readJsonBody(request) : undefined
          log.debug({ rpc: (body as { method?: string } | null)?.method ?? null, method: request.method }, 'MCP in-session request')
          const stopProgress = reportToolCallProgress(runtime.server, body)
          try {
            await runtime.transport.handleRequest(request, response, body)
          } finally {
            stopProgress?.()
          }
          log.debug({ rpc: (body as { method?: string } | null)?.method ?? null }, 'MCP in-session request returned')
          if ((body as { method?: unknown } | null)?.method === 'tools/list' && response.statusCode === 200) {
            if (!record.toolsListed) {
              record.toolsListed = true
              const { key, capability, slot, invariant } = record
              this.persistence?.grants.put({ key, capability, slot, invariant, toolsListed: true })
            }
            this.emitToolsListed(record.key)
          }
        } finally {
          stopKeepalive?.()
          if (request.method === 'DELETE') {
            record.clientsByMcpSession.delete(mcpSessionId)
            await this.closeClient(runtime)
          }
        }
        return
      }
      if (request.method !== 'POST') return void response.writeHead(400).end()
      const body = await readJsonBody(request)
      log.debug({ rpc: (body as { method?: string } | null)?.method ?? null, isInit: isInitializeRequest(body) }, 'MCP session-less POST')
      if (!isInitializeRequest(body)) return void response.writeHead(400).end()
      if (record.revoked) return void response.writeHead(401).end()
      await this.initializeClient(record, request, response, body)
    } catch (error) {
      if (error === MCP_PAYLOAD_TOO_LARGE) return void response.writeHead(413).end()
      log.error({ err: error }, 'MCP request failed')
      if (!response.headersSent) response.writeHead(500).end()
    }
  }
  private async initializeClient(record: GrantRecord<TContext>, request: IncomingMessage,
    response: ServerResponse, body: unknown): Promise<void> {
    const opening = this.createClient(record)
    record.opening.add(opening)
    let runtime: ClientRuntime | null = null
    try {
      runtime = await opening
      if (record.revoked) { await this.closeClient(runtime); return void response.writeHead(401).end() }
      await runtime.transport.handleRequest(request, response, body)
      const mcpSessionId = runtime.transport.sessionId
      if (!mcpSessionId) {
        // SDK 拒掉 initialize 时自己写了响应(406 Accept 不对 / 400 请求头或内容不对 …),只看「没有 session id」查不动。
        throw new Error(`Gugu MCP client initialize returned no session id (HTTP ${response.statusCode}, accept=${request.headers.accept ?? '-'}, content-type=${request.headers['content-type'] ?? '-'}, user-agent=${request.headers['user-agent'] ?? '-'})`)
      }
      if (record.clientsByMcpSession.has(mcpSessionId)) throw new Error('Gugu MCP client session id collision')
      record.clientsByMcpSession.set(mcpSessionId, runtime)
      if (record.revoked) {
        record.clientsByMcpSession.delete(mcpSessionId)
        await this.closeClient(runtime)
      }
    } catch (error) {
      if (runtime) {
        record.closing.add(runtime)
        const closeErrors = await collectErrors([this.closeClient(runtime)])
        if (closeErrors.length) {
          throw new AggregateError([error, ...closeErrors], 'Failed to initialize and close Gugu MCP client')
        }
        record.closing.delete(runtime)
      }
      throw error
    } finally {
      record.opening.delete(opening)
    }
  }
  private async createClient(record: GrantRecord<TContext>): Promise<ClientRuntime> {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () =>
      randomBytes(16).toString('hex') })
    const server = await this.createMcpServer(() => {
      if (record.revoked) throw new Error('Gugu MCP grant is revoked')
      return record.context
    }, record.abortController.signal, (work, toolName) => {
      record.activeRequests.add(work)
      void work.then(
        () => record.activeRequests.delete(work),
        () => record.activeRequests.delete(work),
      )
      if (toolName) trackToolCallDuration(work, toolName)
      return work
    })
    const runtime: ClientRuntime = { server, transport, closing: null }
    try {
      if (record.revoked) throw new Error('Gugu MCP grant is revoked')
      await server.connect(transport)
      // SDK 拒掉请求(400/406/…)时只把原因交给 onerror,响应体里的那句客户端未必会报出来;接到日志里,
      // 否则只看得到「没有 session id」(#6264 实测:codex 的 initialize 被 400,原因一个字都没有)。
      const onerror = transport.onerror
      transport.onerror = (error) => {
        log.error({ err: error }, 'MCP transport rejected a request')
        onerror?.(error)
      }
      const onclose = transport.onclose
      transport.onclose = () => {
        const mcpSessionId = transport.sessionId
        if (mcpSessionId && record.clientsByMcpSession.get(mcpSessionId) === runtime) {
          record.clientsByMcpSession.delete(mcpSessionId)
        }
        onclose?.()
      }
      return runtime
    } catch (error) {
      record.closing.add(runtime)
      const closeErrors = await collectErrors([this.closeClient(runtime)])
      if (closeErrors.length) {
        throw new AggregateError([error, ...closeErrors], 'Failed to connect and close Gugu MCP client')
      }
      record.closing.delete(runtime)
      throw error
    }
  }
  private closeClient(runtime: ClientRuntime): Promise<void> {
    runtime.closing ??= runtime.server.close().catch((error) => {
      runtime.closing = null
      throw error
    })
    return runtime.closing
  }
  private async closeGrant(record: GrantRecord<TContext>): Promise<void> {
    for (const runtime of record.clientsByMcpSession.values()) record.closing.add(runtime)
    record.clientsByMcpSession.clear()
    const opening = [...record.opening].map((pending) => pending.then(
      async (runtime) => {
        record.closing.add(runtime)
        await this.closeClient(runtime)
        record.closing.delete(runtime)
      },
      () => undefined,
    ))
    const closing = [...record.closing].map(async (runtime) => {
      await this.closeClient(runtime)
      record.closing.delete(runtime)
    })
    const drains = [...closing, ...opening, ...record.activeRequests]
      .map((pending) => withTimeout(pending, MCP_DRAIN_TIMEOUT_MS))
    const errors = await collectErrors(drains)
    if (errors.length) throw new AggregateError(errors, 'Failed to close Gugu MCP grant')
  }
  private readInvariant(context: TContext): GuguMcpGrantInvariant {
    const { ownerId, subjectId, toolScope } = this.invariantOf(context)
    if (!ownerId || !subjectId || !toolScope) {
      throw new Error('Gugu MCP grant requires ownerId, subjectId, and toolScope')
    }
    return { ownerId, subjectId, toolScope }
  }
}
/**
 * standalone SSE 流上隔一阵写一行 SSE 注释(`: keepalive`,解析方一律忽略)。claude 的 HTTP MCP 客户端把 360 s 一个字节
 * 都没有的流判成空闲超时、断开重连,每断一次记一次「terminal connection error n/3」。平时它马上重连上、计数归零,
 * 可宿主恰好在重启时,攒下的那一次加上重启的两下就凑满 3 次,走进「整个传输重连、最多 5 次」,随后永久放弃
 * (10-08 ThinkPad 15:32 换版实测)。写之前确认流真的开着:响应头已发出、200、还没结束。in-session 的 GET 只有
 * standalone SSE 流会这样一直开着(出错的 GET 当场就结束了)。❌ 读 content-type:SDK 经 hono 用 writeHead 直接发头,
 * `getHeader` 读不到。
 */
export const SSE_KEEPALIVE_MS = 60_000
export function keepSseStreamAlive(response: ServerResponse): () => void {
  const timer = setInterval(() => {
    if (!response.headersSent || response.writableEnded || response.statusCode !== 200) return
    response.write(': keepalive\n\n')
  }, SSE_KEEPALIVE_MS)
  timer.unref?.()
  const stop = () => clearInterval(timer)
  response.once('close', stop)
  return stop
}
/**
 * A tool call that waits on a person (a browser login or takeover, an App install's consent) or on a slow device stays
 * open for minutes. Claude Code aborts an MCP tool that sends no response or progress for 300 s
 * (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT), and treats a response stream without a byte as dead and gives the call up
 * 90 s after the stream errors ("transport dropped mid-call"); every progress notification resets both. So while a
 * `tools/call` that carried a `progressToken` is pending, tell the caller it is still running, on that call's own response
 * stream. A call without a token gets nothing: the spec only allows progress for a token the caller sent.
 */
export const TOOL_CALL_PROGRESS_MS = 30_000
export function reportToolCallProgress(server: McpServer, body: unknown): (() => void) | null {
  const call = body as { method?: unknown; id?: unknown; params?: { _meta?: { progressToken?: unknown } } } | null | undefined
  const progressToken = call?.params?._meta?.progressToken
  if (call?.method !== 'tools/call' || (typeof call.id !== 'string' && typeof call.id !== 'number')) return null
  if (typeof progressToken !== 'string' && typeof progressToken !== 'number') return null
  const relatedRequestId = call.id
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    server.server.notification({ method: 'notifications/progress', params: { progressToken, progress, message: 'Still running' } }, { relatedRequestId })
      .catch((error: unknown) => log.debug({ error: String(error) }, 'tool call progress not sent (its stream is gone)'))
  }, TOOL_CALL_PROGRESS_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
/**
 * MCP 规范(Streamable HTTP 的 Security Warning)要求本机 server 校验 Origin 防 DNS rebinding:把自己域名解析到
 * 127.0.0.1 的网页,浏览器照样把请求送到这个端口,但 Host / Origin 仍是它自己的域名。harness 都是非浏览器客户端,
 * 不带 Origin、Host 是卡上的 127.0.0.1 ⇒ 这道闸只会拦到浏览器里的页面。缺 Host 或 Origin 为 `null` 一律按非本机。
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])
function isLocalRequest(request: IncomingMessage): boolean {
  const { host, origin } = request.headers
  return isLoopbackUrl(`http://${host ?? ''}`) && (origin === undefined || isLoopbackUrl(origin))
}
function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(url.hostname)
  } catch {
    return false
  }
}
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MCP_BODY_MAX_BYTES) {
    throw MCP_PAYLOAD_TOO_LARGE
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    received += buffer.byteLength
    if (received > MCP_BODY_MAX_BYTES) throw MCP_PAYLOAD_TOO_LARGE
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
async function collectErrors(promises: Promise<unknown>[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(promises)
  return rejectedReasons(settled)
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP drain timed out')), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}
function rejectedReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason)
}
function sameInvariant(left: GuguMcpGrantInvariant, right: GuguMcpGrantInvariant): boolean {
  return left.ownerId === right.ownerId && left.subjectId === right.subjectId && left.toolScope === right.toolScope
}
function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
}
