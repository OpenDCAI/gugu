import type { ExecResult } from './types'
import { spawnOwnedChild } from './owned-child'

const PROCESS_GROUP_KILL_GRACE_MS = 100
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024

type ProcessGroupExecOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
}

/**
 * Buffer a child command while owning a dedicated process group. This is used by
 * one-shot probes whose wrappers may fork descendants that must die with the probe.
 */
export function execInProcessGroup(
  command: string,
  args: string[],
  options: ProcessGroupExecOptions
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const owned = spawnOwnedChild(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      onError: (error) => onChildError(error)
    })
    const child = owned.child
    const stdout: string[] = []
    const stderr: string[] = []
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER
    const pgid = child.pid
    let settled = false
    let timedOut = false
    let maxBufferExceeded = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let killHandle: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let abortReason: unknown

    const stdoutText = (): string => stdout.join('')
    const stderrText = (): string => stderr.join('')
    const residualCount = (): number | undefined => {
      if (!pgid || process.platform === 'win32') return undefined
      try {
        process.kill(-pgid, 0)
        return 1
      } catch {
        return 0
      }
    }
    const rejectWith = (error: unknown): void => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (killHandle) clearTimeout(killHandle)
      reject(error)
    }
    const terminateGroup = (signal: NodeJS.Signals): void => owned.kill(signal)
    const timeoutError = (): Error & Record<string, unknown> =>
      Object.assign(new Error(`Timed out after ${options.timeout}ms`), {
        code: null,
        killed: true,
        timedOut: true,
        stdout: stdoutText(),
        stderr: stderrText(),
        processGroupResidualCount: residualCount()
      }) as unknown as Error & Record<string, unknown>
    const maxBufferError = (): Error & Record<string, unknown> =>
      Object.assign(new Error('stdout/stderr exceeded maxBuffer'), {
        stdout: stdoutText(),
        stderr: stderrText(),
        code: null,
        processGroupResidualCount: residualCount()
      }) as unknown as Error & Record<string, unknown>
    const onAbort = (): void => {
      terminateGroup('SIGTERM')
      abortReason = options.signal?.reason ?? new DOMException('Aborted', 'AbortError')
      killHandle = setTimeout(() => {
        killHandle = undefined
        terminateGroup('SIGKILL')
        if (closed) rejectWith(abortReason)
      }, PROCESS_GROUP_KILL_GRACE_MS)
    }

    if (options.signal?.aborted) {
      terminateGroup('SIGKILL')
      reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout.push(chunk)
      if (Buffer.byteLength(stdoutText()) > maxBuffer) {
        if (maxBufferExceeded) return
        maxBufferExceeded = true
        terminateGroup('SIGTERM')
        killHandle = setTimeout(() => {
          killHandle = undefined
          terminateGroup('SIGKILL')
          if (closed) rejectWith(maxBufferError())
        }, PROCESS_GROUP_KILL_GRACE_MS)
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr.push(chunk)
      if (Buffer.byteLength(stderrText()) > maxBuffer) {
        if (maxBufferExceeded) return
        maxBufferExceeded = true
        terminateGroup('SIGTERM')
        killHandle = setTimeout(() => {
          killHandle = undefined
          terminateGroup('SIGKILL')
          if (closed) rejectWith(maxBufferError())
        }, PROCESS_GROUP_KILL_GRACE_MS)
      }
    })
    // spawn 失败,或停不下来的树(比这次执行本身的失败更要紧):以它结束。
    const onChildError = (error: Error): void => {
      options.signal?.removeEventListener('abort', onAbort)
      // `code` 在这条路上是退出码(调用方据它判「跑没跑起来」),系统错误名挪到 `spawnErrorCode`,❌ 丢掉。
      const spawnErrorCode = (error as NodeJS.ErrnoException).code ?? null
      rejectWith(Object.assign(error, { stdout: stdoutText(), stderr: stderrText(), code: null, spawnErrorCode }))
    }
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', onAbort)
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (settled) {
        if (killHandle) clearTimeout(killHandle)
        return
      }
      if (timedOut) {
        closed = true
        if (killHandle) return
        rejectWith(timeoutError())
        return
      }
      if (abortReason) {
        closed = true
        if (killHandle) return
        rejectWith(abortReason)
        return
      }
      if (maxBufferExceeded) {
        closed = true
        if (killHandle) return
        rejectWith(maxBufferError())
        return
      }
      if (killHandle) clearTimeout(killHandle)
      if ((code ?? 0) === 0) {
        const processGroupResidualCount = residualCount()
        if (processGroupResidualCount) {
          terminateGroup('SIGTERM')
          setTimeout(() => terminateGroup('SIGKILL'), PROCESS_GROUP_KILL_GRACE_MS)
        }
        settled = true
        resolve({ stdout: stdoutText(), stderr: stderrText(), processGroupResidualCount })
        return
      }
      rejectWith(
        Object.assign(
          new Error(stderrText() || `Process exited with ${code ?? signal ?? 'unknown'}`),
          {
            stdout: stdoutText(),
            stderr: stderrText(),
            code: code ?? null,
            signal
          }
        )
      )
    })
    if (options.timeout) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        terminateGroup('SIGTERM')
        killHandle = setTimeout(() => {
          killHandle = undefined
          terminateGroup('SIGKILL')
          if (closed) rejectWith(timeoutError())
        }, PROCESS_GROUP_KILL_GRACE_MS)
      }, options.timeout)
    }
  })
}

export type { ProcessGroupExecOptions }
