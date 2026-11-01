/**
 * #7199 跑子进程的两个口子:`runJxa`(osascript 跑 JXA,驱动「邮件」「备忘录」「信息」这类只给脚本接口的 App;第一次用时
 * macOS 会问「允许咕咕控制 xx 吗」—— 那就是这一组的系统权限)与 `execFileAsync`(命令行工具:mdfind、xattr、sdef ……)。
 * 参数经 argv 传 JSON,❌ 拼进脚本(引号 / 换行会把脚本弄坏)。脚本把结果 JSON.stringify 打到 stdout。
 */
import { execFile, spawn } from '@gugu/core/local/childProcess'

/** macOS 不让发 Apple Event(用户没点允许 / 在隐私设置里关了)时 osascript 的错误码。 */
const NOT_AUTHORIZED = /-1743|Not authori[sz]ed to send Apple events|不允许发送 Apple 事件/i
/**
 * Apple Event 等应答超时(-1712)。第一次用时 macOS 弹「允许咕咕控制日历吗」,没人点,脚本就一直等到这里
 * (2026-10-15 本机实测:读日历列表 120 秒后 -1712,那时日历 App 已经起来了)。
 */
const EVENT_TIMED_OUT = /-1712|AppleEvent timed out|AppleEvent已超时/i

export class MacScriptPermissionError extends Error {
  constructor(readonly app: string, message: string, readonly pending = false) {
    super(message)
    this.name = 'MacScriptPermissionError'
  }
}

export function runJxa(script: string, input: unknown, options: { signal?: AbortSignal; timeoutMs?: number; app: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, JSON.stringify(input ?? {})],
      { timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, signal: options.signal },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || ''}${error.message}`
          if (NOT_AUTHORIZED.test(detail)) {
            reject(new MacScriptPermissionError(options.app, detail.trim().slice(0, 300)))
            return
          }
          if (EVENT_TIMED_OUT.test(detail)) {
            reject(new MacScriptPermissionError(options.app, detail.trim().slice(0, 300), true))
            return
          }
          reject(new Error((stderr || error.message).trim().slice(0, 500)))
          return
        }
        const text = String(stdout ?? '').trim()
        if (!text) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`脚本输出看不懂:${text.slice(0, 200)}`))
        }
      },
    )
  })
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * 跑一个命令行工具,收齐 stdout / stderr / 退出码。退出码 ≠ 0 不抛(有的工具用它表示「没找到」),由调用方判;
 * 起不来(找不到程序)、超时、被取消才抛。
 */
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number; input?: string; cwd?: string; env?: Record<string, string>; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const max = options.maxBuffer ?? 16 * 1024 * 1024
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let overflow = false
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > max) overflow = true
      else out.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errBytes += chunk.length
      if (errBytes <= max) err.push(chunk)
    })
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`${file} 超过 ${Math.round(options.timeoutMs! / 1000)} 秒没结束,已停止`))
        }, options.timeoutMs)
      : null
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (overflow) {
        reject(new Error(`${file} 输出超过 ${Math.round(max / 1024 / 1024)} MB,已截停`))
        return
      }
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? -1 })
    })
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}
