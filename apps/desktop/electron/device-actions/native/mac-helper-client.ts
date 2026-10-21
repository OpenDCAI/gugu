/**
 * #7199 咕咕的 Mac 原生助手(`gugu-mac-helper`,Swift,源码 apps/desktop/native/mac-helper)的客户端。
 * 日历 / 提醒事项 / 通讯录 / 定位 / 文字识别 / 系统授权这些只有原生接口的能力都经它做(这些是 native 工具)。
 *
 * 一个常驻子进程,stdin / stdout 各一行一个 JSON:
 *   → {"id":1,"method":"calendar.events.list","params":{…}}
 *   ← {"id":1,"ok":true,"result":…}  或  {"id":1,"ok":false,"error":{"code":"os_permission","message":"…","details":…}}
 * 它是咕咕的子进程,系统授权(「咕咕想访问你的日历」)记在咕咕名下。挂了就在下一次调用时重起,在途的调用一律报错(❌ 悄悄重发:
 * 建日程可能已经做了)。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'

/** 原生助手回的错:code 与设备动作的错误码同名(os_permission / invalid_args / not_found / needs_confirmation / execution_failed)。 */
export class NativeCallError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'NativeCallError'
  }
}

export interface MacHelperClient {
  /** 原生助手在不在(开发环境没编译、或不是 Mac 时不在)。 */
  available(): { ok: true } | { ok: false; message: string }
  call<T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>
  dispose(): void
}

type Log = { info(fields: Record<string, unknown>, msg: string): void; warn(fields: Record<string, unknown>, msg: string): void }

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null; method: string }

export function createMacHelperClient(options: { binary: string | null; missingMessage: string; log?: Log }): MacHelperClient {
  let child: ChildProcessWithoutNullStreams | null = null
  let nextId = 1
  // 在途请求按进程记:旧进程迟一步退出时只拒它自己的,❌ 连带拒掉已经发给新进程的。
  const pendingOf = new WeakMap<ChildProcessWithoutNullStreams, Map<number, Pending>>()

  const failAll = (proc: ChildProcessWithoutNullStreams, error: Error) => {
    const pending = pendingOf.get(proc)
    if (!pending) return
    for (const [id, p] of pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(error)
      pending.delete(id)
    }
  }

  const start = (): ChildProcessWithoutNullStreams => {
    if (child && child.exitCode === null && !child.killed) return child
    const binary = options.binary!
    const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    child = proc
    const pending = new Map<number, Pending>()
    pendingOf.set(proc, pending)
    const lines = readline.createInterface({ input: proc.stdout })
    lines.on('line', (line) => {
      let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; details?: unknown } }
      try {
        msg = JSON.parse(line)
      } catch {
        options.log?.warn({ line: line.slice(0, 200) }, 'mac helper wrote a non-JSON line')
        return
      }
      const id = typeof msg.id === 'number' ? msg.id : -1
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (p.timer) clearTimeout(p.timer)
      if (msg.ok === true) p.resolve(msg.result ?? null)
      else {
        const code = typeof msg.error?.code === 'string' ? msg.error.code : 'execution_failed'
        const message = typeof msg.error?.message === 'string' ? msg.error.message : `${p.method} 失败`
        p.reject(new NativeCallError(code, message, msg.error?.details))
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) options.log?.info({ stderr: text.slice(0, 500) }, 'mac helper stderr')
    })
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null
      options.log?.warn({ code, signal, inFlight: pending.size }, 'mac helper exited')
      failAll(proc, new NativeCallError('execution_failed', `咕咕的原生助手意外退出了(${signal ?? code}),这次没做成`))
    })
    proc.on('error', (error) => {
      if (child === proc) child = null
      failAll(proc, new NativeCallError('execution_failed', `咕咕的原生助手起不来:${error.message}`))
    })
    return proc
  }

  return {
    available() {
      if (!options.binary) return { ok: false, message: options.missingMessage }
      if (!fs.existsSync(options.binary)) return { ok: false, message: `${options.missingMessage}(找不到 ${options.binary})` }
      return { ok: true }
    },
    call<T>(method: string, params?: unknown, callOptions: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
      const ready = this.available()
      if (!ready.ok) return Promise.reject(new NativeCallError('unsupported', ready.message))
      if (callOptions.signal?.aborted) return Promise.reject(new NativeCallError('execution_failed', '已取消'))
      return new Promise<T>((resolve, reject) => {
        const proc = start()
        const pending = pendingOf.get(proc)!
        const id = nextId++
        const timeoutMs = callOptions.timeoutMs ?? 120_000
        const entry: Pending = {
          resolve: resolve as (value: unknown) => void,
          reject,
          method,
          timer: setTimeout(() => {
            pending.delete(id)
            reject(new NativeCallError('timeout', `${method} 超过 ${Math.round(timeoutMs / 1000)} 秒没回`))
          }, timeoutMs),
        }
        pending.set(id, entry)
        callOptions.signal?.addEventListener('abort', () => {
          if (!pending.has(id)) return
          pending.delete(id)
          if (entry.timer) clearTimeout(entry.timer)
          reject(new NativeCallError('execution_failed', '已取消'))
        }, { once: true })
        proc.stdin.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`)
      })
    },
    dispose() {
      if (child) failAll(child, new NativeCallError('execution_failed', '咕咕正在退出'))
      child?.kill()
      child = null
    },
  }
}
