/**
 * cua-driver's versioned daemon protocol (cua-driver-core/src/daemon.rs).
 * Like its MCP proxy, own one session_begin control connection and use a new
 * connection per call. Unlike the serial stdio proxy, read-only cursor samples
 * can run while the same owner's native batch is in flight. The daemon still
 * applies the native session, authorization, policy and tool checks.
 */
import net from 'node:net'
import readline from 'node:readline'
import { NativeCallError } from './mac-helper-client'
import type { CuaToolResult } from './cua-client'

interface Response { ok: boolean; result?: unknown; error?: string; exit_code?: number }
type CallOptions = { signal?: AbortSignal; timeoutMs?: number }

export const CUA_CANCEL_UNCONFIRMED = '已请求取消；操作可能部分执行，结果未确认，请先检查窗口'
const MUTATIONS = new Set(['click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'type_text_chars', 'press_key', 'hotkey', 'set_value', 'move_cursor', 'set_window_frame', 'invoke_menu', 'bring_to_front', 'launch_app', 'kill_app', 'mouse_button_down', 'mouse_button_up'])

/** Shared by both cancellation timers; a checks-only batch is an observation. */
export function cuaMutates(name: string, args: Record<string, unknown>): boolean {
  if (name !== 'run_steps') return MUTATIONS.has(name)
  return Array.isArray(args.steps) && args.steps.some(step => {
    if (!step || typeof step !== 'object') return false
    if (typeof step.tool === 'string') return MUTATIONS.has(step.tool)
    return Object.keys(step).some(tool => MUTATIONS.has(tool))
  })
}

export interface CuaDaemonLease {
  call(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<CuaToolResult>
  close(): void
}

export async function openCuaDaemonLease(options: {
  socket: string
  owner: string
  hostBundleId?: string
  timeoutMs: number
  onClosed(): void
}): Promise<CuaDaemonLease> {
  const connections = new Set<net.Socket>()
  let closed = false
  let control: net.Socket | null = null
  const unavailable = () => new NativeCallError('execution_failed', '电脑控制的连接已结束，请重新获取窗口后再试')
  const close = () => {
    if (closed) return
    closed = true
    control?.destroy()
    for (const connection of connections) connection.destroy()
    options.onClosed()
  }

  const exchange = (request: Record<string, unknown>, call: CallOptions = {}, mutation = false): Promise<Response> => {
    if (closed) return Promise.reject(unavailable())
    if (call.signal?.aborted) return Promise.reject(new NativeCallError('execution_failed', '已取消'))
    return new Promise((resolve, reject) => {
      const connection = net.createConnection(options.socket)
      connections.add(connection)
      const lines = readline.createInterface({ input: connection })
      let settled = false
      let sent = false
      const finish = (error?: Error, value?: Response) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        call.signal?.removeEventListener('abort', abort)
        connections.delete(connection)
        lines.close()
        connection.destroy()
        if (error) reject(error)
        else resolve(value!)
      }
      const cancel = (code: 'execution_failed' | 'timeout') => {
        if (settled) return
        const retireOwner = mutation && sent
        const message = code === 'timeout' ? '电脑控制请求超时，结果未确认' : '电脑控制请求已取消，结果未确认'
        finish(new NativeCallError(code, retireOwner ? CUA_CANCEL_UNCONFIRMED : message))
        // End the owner control, not just this request socket: native queued
        // inputs must see session-ending. A cancelled read never ends it.
        if (retireOwner) close()
      }
      const abort = () => cancel('execution_failed')
      const timer = setTimeout(() => cancel('timeout'), call.timeoutMs ?? options.timeoutMs)
      call.signal?.addEventListener('abort', abort, { once: true })
      connection.once('connect', () => {
        if (settled) return
        sent = true
        connection.write(`${JSON.stringify(request)}\n`)
      })
      connection.once('error', error => finish(new NativeCallError('execution_failed', error.message)))
      connection.once('close', () => finish(unavailable()))
      lines.once('line', line => {
        try {
          const result = JSON.parse(line) as Response
          if (typeof result.ok !== 'boolean') throw new Error('Invalid cua-driver response')
          finish(undefined, result)
        } catch (error) { finish(new NativeCallError('execution_failed', String(error))) }
      })
    })
  }

  try {
    const metadata = await exchange({ method: 'metadata' })
    const identity = metadata.result as { embedded?: boolean; host_bundle_id?: string; driver_version?: string } | undefined
    if (!metadata.ok || identity?.embedded !== true || !identity.driver_version
      || (options.hostBundleId && identity.host_bundle_id !== options.hostBundleId)) {
      throw new NativeCallError('execution_failed', '电脑控制服务的宿主身份不匹配')
    }
    await new Promise<void>((resolve, reject) => {
      control = net.createConnection(options.socket)
      const lines = readline.createInterface({ input: control })
      let acknowledged = false
      const timer = setTimeout(() => { reject(new NativeCallError('timeout', '电脑控制会话未能启动')); close() }, options.timeoutMs)
      control.once('connect', () => control!.write(`${JSON.stringify({ method: 'session_begin', session_id: options.owner })}\n`))
      control.once('error', error => { clearTimeout(timer); reject(error); close() })
      control.once('close', () => {
        clearTimeout(timer)
        lines.close()
        if (!acknowledged) reject(unavailable())
        close()
      })
      lines.once('line', line => {
        clearTimeout(timer)
        try {
          const response = JSON.parse(line) as Response
          if (!response.ok || (response.result as { session_begin?: boolean } | undefined)?.session_begin !== true) throw unavailable()
          acknowledged = true
          resolve()
        } catch (error) { reject(error); close() }
      })
    })
  } catch (error) {
    close()
    throw error
  }

  return {
    async call(name, args, call = {}) {
      // Same reserved-argument boundary as the native MCP proxy. Only the host
      // owns transport identity; agent-supplied underscore keys never select it.
      const clean = Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith('_')))
      const response = await exchange({ method: 'call', name, args: clean, session_id: options.owner, observation_origin: 'direct', client_kind: 'unknown' }, call, cuaMutates(name, clean))
      if (!response.ok) return { isError: true, content: [{ type: 'text', text: response.error ?? 'cua-driver refused the call' }], structuredContent: { exit_code: response.exit_code ?? 1 } }
      if (!response.result || typeof response.result !== 'object') throw new NativeCallError('execution_failed', '电脑控制返回了无效工具结果')
      return response.result as CuaToolResult
    },
    close,
  }
}
