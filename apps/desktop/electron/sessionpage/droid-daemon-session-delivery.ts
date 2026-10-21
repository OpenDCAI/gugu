import { randomInt } from 'node:crypto'
import WebSocket from 'ws'
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context'
import { spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec'
import { onErrorEvent } from '@gugu/session-shared'
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context'
import type { SessionpageSessionMessage, SessionpageDeliveryTarget } from './session-injection'
import { demoteSessionpageDeliveryOwner, registerSessionpageDeliveryTarget } from './sessionpage-delivery-owner-registry'
import { registerSessionpageSessionRuntime } from './sessionpage-session-runtime-registry'
import { createLogger } from '../lib/logger'
import {
  backendSessionNameFor,
  findTmuxBackend,
  launchTmuxBackend,
  type TmuxBackend,
  type TmuxBackendDeps,
} from './tmux-backend'

/** 测试缝:tmux 调用与进程探测。生产用默认那一份。 */
let tmuxBackendDepsForTest: TmuxBackendDeps | undefined
export function setDroidTmuxBackendDepsForTest(deps: TmuxBackendDeps | undefined): void {
  tmuxBackendDepsForTest = deps
}

/**
 * 一台 daemon:宿主的子进程(owned),或 #6264 住在 tmux 里、活过宿主进程重启的那台(backend)。二选一。
 */
type Daemon = { owned: OwnedChild | null; backend: TmuxBackend | null; port: number; socket: WebSocket }

function droidLogger() {
  return createLogger('sessionpage/droid-daemon')
}

type Rpc = { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> }
type Binding = {
  agentUserId: string
  sessionId: string
  /** The harness this daemon serves; names the declared `tui` cell for the router's timing lookup. */
  providerId: string
  providerSessionId: string
  cwd: string
  /** #6264 droid TUI 所在的 tmux 会话名;有它 ⇒ daemon 也住进 tmux、活过宿主进程重启(见 tmux-backend.ts)。 */
  tmuxSessionName?: string
}

/** Provider-native droid TUI channel. One daemon sidecar is owned by each mapped conversation. */
export class DroidDaemonSessionDelivery implements SessionpageDeliveryTarget {
  readonly deliveryTargetName = 'droid-daemon-v1'
  readonly hostAdapter = 'droid-daemon-v1' as const
  private readonly bindings = new Map<string, Binding>()
  private readonly daemons = new Map<string, Daemon>()
  private nextRpcId = 1

  /**
   * Publish this conversation's claim — only from inside `promoteSessionpageDeliveryOwner`, the synchronous
   * turn that also removes the offline blocker. Same shape as the opencode serve/attach claimant
   * (@@@claim-at-promotion, #5049): a claim published while the daemon is still booting sits next to the
   * blocker as a second live owner, and every delivery in that window fails on owner cardinality.
   */
  register(binding: Binding): void {
    this.bindings.set(binding.sessionId, binding)
  }

  async startSession(binding: Binding): Promise<Record<string, string>> {
    const daemon = await this.ensureDaemon(binding)
    return {
      FACTORY_DAEMON_TRANSPORT: 'websocket',
      FACTORY_DAEMON_HOST: '127.0.0.1',
      FACTORY_DAEMON_PORT: String(daemon.port),
    }
  }

  liveSessionIdByAgent(agentUserId: string): string | null {
    return [...this.bindings.values()].find((b) => b.agentUserId === agentUserId)?.sessionId ?? null
  }

  deliveryKeyForSession(sessionId: string): string | null {
    return this.bindings.has(sessionId) ? sessionId : null
  }

  /** The declared cell this conversation runs on (route log + timing lookup, #5049 Q2). */
  sessionProviderSurface(sessionId: string): { providerId: string; surface: 'tui' } | null {
    const binding = this.bindings.get(sessionId)
    return binding ? { providerId: binding.providerId, surface: 'tui' } : null
  }

  async tryInjectSessionMessage(sessionId: string, message: SessionpageSessionMessage): Promise<boolean> {
    const binding = this.bindings.get(sessionId)
    if (!binding) return false
    const daemon = await this.ensureDaemon(binding)
    const requestId = message.id || `gugu-${Date.now()}`
    const result = await this.requestAny(daemon.socket, ['daemon.add_user_message', 'droid.add_user_message'], {
      sessionId: binding.providerSessionId,
      content: [{ type: 'text', text: message.text }],
      queuePlacement: 'end_of_loop',
      requestId,
    })
    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error(`droid daemon rejected message for ${sessionId}`)
    }
    // Keep the provider's durable queue receipt explicit. Droid exposes both queue placements;
    // updating the same request id is the only supported way to move a busy message without
    // creating a second turn.
    await this.requestAny(daemon.socket, ['daemon.resolve_queued_user_message', 'droid.resolve_queued_user_message'], {
      sessionId: binding.providerSessionId,
      action: 'update_queue',
      requestId,
      queuePlacement: 'end_of_loop',
    })
    return true
  }

  releaseAgentClaim(agentUserId: string): void {
    const binding = [...this.bindings.values()].find((b) => b.agentUserId === agentUserId)
    if (!binding) return
    this.unregisterSession(binding.sessionId).catch((error: unknown) => {
      droidLogger().error({ sessionId: binding.sessionId, err: (error as Error).message }, 'droid daemon stop failed')
    })
  }

  /** `onReleased` 在认领摘掉的那一刻同步调用(没有认领可摘就不调)—— 交还离线占位就挂在这里。 */
  async unregisterSession(sessionId: string, onReleased?: () => void): Promise<void> {
    if (this.bindings.delete(sessionId)) onReleased?.()
    const daemon = this.daemons.get(sessionId)
    if (!daemon) return
    this.daemons.delete(sessionId)
    try { daemon.socket.close() } catch { /* already closed */ }
    await daemon.owned?.stop()
    await daemon.backend?.terminate()
  }

  /**
   * 会话真结束(stopSession / 闲置回收):停 daemon,并在认领摘掉的同一刻把这个 agent 交还给离线占位 ——
   * 与 codex / claude / opencode 同一个写口。此前这里没有登记 teardown:停会话之后 daemon 一直在跑,
   * 旧认领也还在,下一条消息撞上「两个属主」。
   */
  async teardownSession(sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId)
    if (!binding) return this.unregisterSession(sessionId)
    await demoteSessionpageDeliveryOwner(
      { guguAgentUserId: binding.agentUserId, sessionId },
      binding.providerId,
      (replaceAfterRelease) => this.unregisterSession(sessionId, replaceAfterRelease),
    )
  }

  /** 宿主关停。#6264 住在 tmux 里的只断开(droid TUI 还连着它,新宿主按名字接回);其余照旧收掉。 */
  async dispose(): Promise<void> {
    for (const [sessionId, daemon] of [...this.daemons]) {
      if (!daemon.backend) continue
      try { daemon.socket.close() } catch { /* already closed */ }
      this.daemons.delete(sessionId)
      this.bindings.delete(sessionId)
    }
    await Promise.all([...this.daemons.keys()].map((id) => this.unregisterSession(id)))
  }

  /** 崩溃 / 信号路径:子进程收掉;tmux 里那台只断开(孤儿由 tmux 钩子与下次启动的对账收)。 */
  disposeSync(): void {
    for (const daemon of this.daemons.values()) {
      try { daemon.socket.close() } catch { /* already closed */ }
      daemon.owned?.kill('SIGTERM')
    }
    this.daemons.clear()
    this.bindings.clear()
  }

  /**
   * #6264 上一个宿主留在 tmux 里的那台 daemon(droid TUI 一直连着它)→ 连回同一个端口。
   * UNVERIFIED(本机无 droid):接回时 ❌ 再 initialize_session —— 会话在 daemon 里本就是初始化过的,
   * 再发一次是否幂等没有文档可依;投递用的 add_user_message 按 sessionId 寻址,不依赖这条连接做过初始化。
   */
  private async adoptDaemon(binding: Binding, name: string): Promise<Daemon | null> {
    const survivor = await findTmuxBackend(name, 'droid-daemon', tmuxBackendDepsForTest)
    if (!survivor) return null
    const port = Number(survivor.endpoint.match(/^ws:\/\/127\.0\.0\.1:(\d+)$/)?.[1] ?? NaN)
    try {
      if (!Number.isInteger(port)) throw new Error(`unrecognised endpoint ${survivor.endpoint}`)
      const socket = await this.openSocket(`ws://127.0.0.1:${port}`)
      const daemon: Daemon = { owned: null, backend: survivor, port, socket }
      this.watchBackendSocket(binding.sessionId, daemon)
      const token = process.env.DROID_DAEMON_AUTH_TOKEN || process.env.FACTORY_API_KEY
      if (token) await this.request(socket, 'daemon.authenticate', { token })
      this.daemons.set(binding.sessionId, daemon)
      droidLogger().info({ sessionId: binding.sessionId, port, pid: survivor.pid }, 'droid daemon adopted from tmux after a host restart')
      return daemon
    } catch (error) {
      droidLogger().warn({ sessionId: binding.sessionId, err: String(error) }, '接回 tmux 里的 droid daemon 失败 —— 收掉它,新起一台')
      await survivor.terminate().catch(() => undefined)
      return null
    }
  }

  /** tmux 里那台没有 exit 事件:连接一断就问一次它还在不在,不在就从表里摘掉(下次投递新起)。 */
  private watchBackendSocket(sessionId: string, daemon: Daemon): void {
    daemon.socket.once('close', () => {
      if (this.daemons.get(sessionId) === daemon && daemon.backend && !daemon.backend.isAlive()) {
        this.daemons.delete(sessionId)
      }
    })
  }

  private async ensureDaemon(binding: Binding): Promise<Daemon> {
    const existing = this.daemons.get(binding.sessionId)
    if (existing) return existing
    const tmuxBackendName = process.platform !== 'win32' ? backendSessionNameFor(binding.tmuxSessionName) : null
    if (tmuxBackendName) {
      const adopted = await this.adoptDaemon(binding, tmuxBackendName)
      if (adopted) return adopted
    }
    const port = randomInt(20_000, 50_000)
    // 跑哪一份 droid —— 与这一家的会话、登录、模型清单**同一个**答案(#5702)。
    // 从前这里写死 `~/.local/bin/droid`:用户在 Agents 设置里选了别的拷贝(brew 装的、
    // 自定义路径、切账号 wrapper),会话那条腿跑选中那份、这条 daemon 跑写死那份 ——
    // 而 `--droid-path` 还会把这份写死的路径继续传给 daemon 自己起的子进程。
    // 编程腿(tui)的投递 daemon —— 跑的是这条腿的程序(#6335 起按腿取程序)。
    const runContext = await resolveLocalAgentRunContext(binding.providerId, { role: 'tui' })
    if (runContext.cli.kind === 'unresolved') throw new Error(runContext.cli.message)
    const cli = runContext.cli.path
    const daemonEnv = composeAgentSpawnEnv(runContext, {
      providerEnv: { DROID_DISABLE_AUTO_UPDATE: 'true', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' },
    })
    const daemonArgs = ['daemon', '--port', String(port), '--host', '127.0.0.1', '--listen', 'websocket', '--droid-path', cli]
    let daemon: Daemon
    if (tmuxBackendName) {
      // #6264 住进 tmux(见 tmux-backend.ts):宿主退出只断开,新宿主按会话名接回同一个端口。
      // tmux 只在 Unix 上用,`cli` 就是可执行文件本身,❌ 需要 Windows 的 `.cmd` 壳。
      const backend = await launchTmuxBackend({
        name: tmuxBackendName,
        kind: 'droid-daemon',
        endpoint: `ws://127.0.0.1:${port}`,
        command: cli,
        args: daemonArgs,
        env: daemonEnv,
        cwd: binding.cwd,
      }, tmuxBackendDepsForTest)
      let socket: WebSocket
      try {
        socket = await this.openSocket(`ws://127.0.0.1:${port}`)
      } catch (error) {
        await backend.terminate().catch(() => undefined)
        throw error
      }
      daemon = { owned: null, backend, port, socket }
      this.daemons.set(binding.sessionId, daemon)
      this.watchBackendSocket(binding.sessionId, daemon)
    } else {
      // Windows 上 `cli` 可能是 npm 的 `.cmd` 壳，裸 spawn 会被 Node 拒绝(EINVAL) —— #5719。
      const owned = spawnOwnedChild(cli, daemonArgs, {
        cwd: binding.cwd,
        // ❌ 不再铺 `...process.env`:真会话拿到的是白名单 + 平台补偿那一份,daemon 铺全量
        // 等于这条腿看得到用户 shell 里任何东西,而会话腿看不到 —— 两条腿又不是一个环境了。
        env: daemonEnv,
        stdio: 'ignore',
        // @@@unhandled-error-event (#4942) — 为什么不能只挂 'exit':ChildProcess 的 'error'(spawn 失败、
        // teardown 时 kill 失败)走的是另一条通道,没有监听者时 Node 把它抛成未捕获异常,在会话页宿主里
        // 等于宿主连同所有会话一起死。这条错误是**异步**送达的,ensureDaemon 外面那圈 try/catch 接不住。
        // 终身出口:daemon 是长驻 sidecar,握手成功之后的整个生命周期都要有这条出口。
        onError: (error) => {
          droidLogger().error(
            { sessionId: binding.sessionId, port, err: error.message },
            'droid daemon child process error',
          )
        },
      })
      const child = owned.child
      const socket = await this.openSocket(`ws://127.0.0.1:${port}`)
      const spawned: Daemon = { owned, backend: null, port, socket }
      daemon = spawned
      this.daemons.set(binding.sessionId, spawned)
      child.once('exit', () => {
        if (this.daemons.get(binding.sessionId) === spawned) this.daemons.delete(binding.sessionId)
      })
    }
    try {
      const token = process.env.DROID_DAEMON_AUTH_TOKEN || process.env.FACTORY_API_KEY
      if (token) await this.request(daemon.socket, 'daemon.authenticate', { token })
      await this.requestAny(daemon.socket, ['daemon.initialize_session', 'droid.initialize_session'], { sessionId: binding.providerSessionId, cwd: binding.cwd })
      return daemon
    } catch (error) {
      await this.unregisterSession(binding.sessionId).catch((stopError: unknown) => {
        throw new AggregateError([error, stopError], 'droid daemon startup and its cleanup both failed')
      })
      throw error
    }
  }

  private openSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000
      let lastError: unknown
      const attempt = () => {
        const socket = new WebSocket(url)
        // 这一条 attempt 是否已经定局(open / 超时 / 错误)。下面的终身 'error' 出口靠它分岔。
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          socket.close()
          if (Date.now() >= deadline) reject(new Error(`droid daemon websocket startup timed out: ${String(lastError ?? 'unknown error')}`))
          else attempt()
        }, 500)
        socket.once('open', () => { settled = true; clearTimeout(timer); resolve(socket) })
        // @@@unhandled-error-event (#4942) — 这条 'error' 出口必须【终身】在,而且必须按 settled 分岔。
        // 为什么不用 once:once 被第一个错误消费掉之后,连接后续的任何错误(daemon 崩了、连接被 RST、
        // 发送失败)就没有监听者,Node 把它抛成未捕获异常 —— 在会话页宿主里等于所有会话一起死;而这条
        // 错误是**异步**送达的,requestAny / ensureDaemon 外面那圈 try/catch 一次也接不住。
        // 为什么要分岔:原 handler 的语义是「换一条连接重试」,那只在**握手期**成立;在已 settle(已 open
        // 或已超时换过)的连接上再跑一遍,会凭空多起一条 attempt 链、并对已 resolve 的 Promise 重复 settle。
        // 已 settle 之后这条只负责把错误报出去;连接的死活由 daemon.child 的 'exit' 与 RPC 超时各自处理。
        onErrorEvent(socket, (error) => {
          if (settled) {
            droidLogger().warn({ url, err: error.message }, 'droid daemon websocket error after settle')
            return
          }
          settled = true
          lastError = error
          clearTimeout(timer)
          socket.close()
          if (Date.now() < deadline) attempt()
          else reject(error)
        })
      }
      attempt()
    })
  }

  private request(socket: WebSocket, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRpcId++
    const payload: Rpc = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`droid daemon RPC timeout: ${method}`)) }, 30_000)
      const onMessage = (raw: WebSocket.RawData) => {
        let value: unknown
        try { value = JSON.parse(raw.toString()) } catch { return }
        if (!value || typeof value !== 'object' || (value as { id?: number }).id !== id) return
        clearTimeout(timer)
        socket.off('message', onMessage)
        const response = value as { error?: { message?: string }; result?: unknown }
        if (response.error) reject(new Error(response.error.message || `droid daemon RPC failed: ${method}`))
        else resolve(response.result)
      }
      socket.on('message', onMessage)
      socket.send(JSON.stringify(payload))
    })
  }

  private async requestAny(socket: WebSocket, methods: string[], params: Record<string, unknown>): Promise<unknown> {
    let lastError: unknown
    for (const method of methods) {
      try { return await this.request(socket, method, params) } catch (error) { lastError = error }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
}

export const droidDaemonSessionDelivery = new DroidDaemonSessionDelivery()
registerSessionpageDeliveryTarget(droidDaemonSessionDelivery)
registerSessionpageSessionRuntime({
  name: 'droid-daemon',
  teardown: (sessionId) => droidDaemonSessionDelivery.teardownSession(sessionId),
})
process.once('exit', () => droidDaemonSessionDelivery.disposeSync())
