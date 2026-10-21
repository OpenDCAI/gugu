import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { onErrorEvents } from '@gugu/session-shared'
import { spawnFsWatchWorker } from '@gugu/session-core/services/fs-watch/worker'
import { createSupervisedProcess } from '@gugu/session-wire/process'
import type {
  ChildHandle,
  ManagedProcess,
  ProcessExit,
  ProcessHost,
  ProcessSpec
} from '@gugu/session-wire/process'

const PROBE_TIMEOUT_MS = 20_000
const EVENT_TIMEOUT_MS = 5_000
const SHUTDOWN_COMPLETE_EVENT = 'shutdown-complete'

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log(
      `[verify-fs-watch-shutdown] skipped on ${process.platform}; the packaged native teardown probe is macOS-only`
    )
    return
  }

  await withDeadline(runProbe(), PROBE_TIMEOUT_MS, 'packaged fs-watch shutdown probe')
}

async function runProbe(): Promise<void> {
  const root = resolve(process.cwd())
  const entry = join(root, 'apps/desktop/dist-electron/fs-watch-runtime.js')
  await access(entry, constants.R_OK)

  const electron = createRequire(import.meta.url)('electron') as string
  const electronAbi = readElectronAbi(electron)
  if (electronAbi !== '119') {
    throw new Error(`Expected packaged Electron ABI 119, observed ${electronAbi}`)
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'gugu-fs-watch-shutdown-'))
  let child: ChildProcess | undefined
  let shutdownMarkers = 0
  let watcher: ReturnType<typeof spawnFsWatchWorker> | undefined

  const host: ProcessHost = {
    async spawn(spec, scope): Promise<ManagedProcess> {
      const managed = await createSupervisedProcess(
        spec,
        (childSpec) => {
          child = spawnElectronChild(electron, childSpec)
          return childHandle(child)
        },
        scope
      )
      managed.onMessage((message) => {
        if (isShutdownCompleteSignal(message)) shutdownMarkers += 1
      })
      return managed
    }
  }

  try {
    watcher = spawnFsWatchWorker({ entry, host })
    let eventCount = 0
    let resolveEvent: (() => void) | undefined
    const eventSeen = new Promise<void>((resolveEventPromise) => {
      resolveEvent = resolveEventPromise
    })
    const handle = watcher.watch(tempRoot, (events) => {
      eventCount += events.length
      if (events.length > 0) resolveEvent?.()
    })

    await handle.ready()
    const childPid = child?.pid
    if (!childPid) throw new Error('Packaged fs-watch worker has no child PID')

    await writeFile(join(tempRoot, 'native-event.txt'), 'probe\n')
    await withDeadline(eventSeen, EVENT_TIMEOUT_MS, 'nonempty native watch event')
    await watcher.dispose()
    watcher = undefined

    if (shutdownMarkers !== 1) {
      throw new Error(
        `Expected exactly one structured shutdown-complete signal, observed ${shutdownMarkers}`
      )
    }

    const stableZeroSamples = [aliveCount(childPid), await delayedAliveCount(childPid, 100)]
    if (stableZeroSamples.some((count) => count !== 0)) {
      throw new Error(
        `Owned fs-watch child ${childPid} survived shutdown: ${stableZeroSamples.join(',')}`
      )
    }

    console.log(
      JSON.stringify({
        probe: 'packaged-fs-watch-shutdown',
        // 探针驱动的是真实 watch service,所以这里报的是它实际走的传输。本脚本仅在 darwin 运行
        // （见上方 skip），而 darwin 的传输已从 @parcel/watcher 的 kqueue 换成直接绑 FSEvents。
        backend: 'fsevents',
        electronAbi,
        childPid,
        subscriptions: 1,
        eventCount,
        shutdownMarkers,
        stableZeroSamples
      })
    )
  } finally {
    try {
      await watcher?.dispose()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
}

function readElectronAbi(electron: string): string {
  return execFileSync(electron, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 5_000
  }).trim()
}

function spawnElectronChild(electron: string, spec: ProcessSpec): ChildProcess {
  return spawn(electron, [spec.entry, ...(spec.args ?? [])], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced'
  })
}

function childHandle(child: ChildProcess): ChildHandle {
  // 进程本体与两条 stdio 流是四个独立的发射器,任何一个没人接都会把这个探针脚本整个带走。
  const errorListeners = new Set<(error: Error) => void>()
  onErrorEvents([child, child.stdout, child.stderr], error => {
    errorListeners.forEach(cb => cb(error))
  })
  return {
    get pid() {
      return child.pid
    },
    send(message) {
      // @@@unhandled-error-event (#4942) — 不带回调时,发送失败由 node **异步地**变成 'error' 事件;
      // 零监听者就是未捕获异常。回调把这条失败收回来,交给下面的 onError 出口。
      child.send(message as Parameters<ChildProcess['send']>[0], error => {
        if (error) errorListeners.forEach(cb => cb(error))
      })
    },
    onError(cb) {
      errorListeners.add(cb)
      return () => errorListeners.delete(cb)
    },
    onMessage(cb) {
      const listener = (message: unknown): void => cb(message)
      child.on('message', listener)
      return () => child.off('message', listener)
    },
    onExit(cb) {
      const listener = (code: number | null, signal: NodeJS.Signals | null): void =>
        cb(toProcessExit(code, signal))
      child.on('exit', listener)
      return () => child.off('exit', listener)
    },
    onStdio(cb) {
      const onStdout = (chunk: Buffer): void => cb('stdout', chunk.toString('utf8'))
      const onStderr = (chunk: Buffer): void => cb('stderr', chunk.toString('utf8'))
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      return () => {
        child.stdout?.off('data', onStdout)
        child.stderr?.off('data', onStderr)
      }
    },
    kill() {
      child.kill('SIGKILL')
    }
  }
}

function toProcessExit(code: number | null, signal: NodeJS.Signals | null): ProcessExit {
  return { code, signal }
}

function isShutdownCompleteSignal(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const record = message as Record<string, unknown>
  return record.kind === 'wire-runtime-signal' && record.event === SHUTDOWN_COMPLETE_EVENT
}

function aliveCount(pid: number): number {
  try {
    process.kill(pid, 0)
    return 1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 0
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return 1
    throw error
  }
}

async function delayedAliveCount(pid: number, delayMs: number): Promise<number> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
  return aliveCount(pid)
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
