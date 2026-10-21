import { createRequire } from 'node:module'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { awaitFact } from '../../../support/awaitFact'
import { cachedFixtureExecutable } from '../../../support/cachedFixtureExecutable'
import { CodexAppServerRegistry, CodexAppServerSession } from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import { HarnessStartupError } from '@gugu/session-core/agents/plugins'
import type { WindowsShimReader } from '@gugu/session-core/exec'
import { startupFailureForUser } from '../../../../apps/desktop/electron/session/main/core/sessions/spawn-failure'
import {
  createCodexAppServerEndpoint,
  removeCodexAppServerEndpoint,
  resolveCodexAppServerSpawn,
  waitForCodexAppServerEndpoint,
  waitForCodexAppServerProcessClose
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-transport'

const require = createRequire(import.meta.url)
const sessions = new Set<CodexAppServerSession>()
const NON_TIMEOUT_STARTUP_TIMEOUT_MS = 60_000
// 就绪期限是从 spawn 起算的真 wall-clock(产品侧 waitForCodexAppServerEndpoint 没有可注入的时钟),
// 所以它天然在和假 codex 的解释器冷启动赛跑。1s 本身不是问题 —— 用 node 当假 codex 才是:
// 见下面 windows-timeout 那条改用 /bin/sh 的理由。余量已有两三个数量级,❌ 别再靠调大这个数字
// 去盖时序问题,那只是给每次 CI 白加秒数。
const READINESS_TIMEOUT_MS = 1_000
const FIXTURE_SIDE_EFFECT_DELAY_MS = 1_000

afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.dispose()))
  sessions.clear()
})

function makeTempDir(prefix: string): string {
  const raw = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(raw, { recursive: true })
  return realpathSync(raw)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 会话此刻持有的 codex 子进程(还没 spawn 就是 undefined)。读私有字段的理由见 waitForSpawnedPid。 */
function sessionProc(session: CodexAppServerSession): ChildProcess | undefined {
  return (session as unknown as { proc: ChildProcess | null }).proc ?? undefined
}

/**
 * 等文件出现再读。用于「子进程启动后才会写出来」的记录文件 —— 见 @@@no-wallclock。
 * 给了 `session` 就把它的 codex 子进程当产出者:子进程先退出而文件没出现,立刻红。
 */
function readWhenPresent(path: string, session?: CodexAppServerSession): Promise<string> {
  return awaitFact(`fake Codex 记录文件 ${path}`, () => {
    try {
      const contents = readFileSync(path, 'utf8')
      if (contents.length === 0) {
        throw new Error(`fake Codex 记录文件 ${path} 已出现，但内容为空。写入方必须原子发布完整内容。`)
      }
      return contents
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }, { producer: session && sessionProc(session) })
}

async function installSignalHandler(
  requestPath: string,
  installedPath: string
): Promise<void> {
  writeFileSync(requestPath, '')
  await readWhenPresent(installedPath)
}

/**
 * @@@no-wallclock — 等「进程从进程表里消失」这个事件,❌ 不设 deadline(#4357)。
 * 进程收到信号到真正消失要排队,忙机器上排多久不由我们决定;真没杀掉就一直等,
 * 由 CI job 的上限收场,`[awaiting-fact]` 行报出是哪个 pid。
 */
async function waitForProcessExit(pid: number): Promise<void> {
  await awaitFact(`fake Codex process ${pid} exit`, () => (isProcessAlive(pid) ? undefined : true), { intervalMs: 25 })
}

/**
 * 取会话内部已 spawn 的子进程 pid。
 *
 * @@@no-race — 进程一 spawn，`proc.pid` 当场就有值：**不需要子进程被 OS 调度，更不需要它执行到
 * 脚本第一行**。windows-timeout 那条用例原先靠「假 codex 自己写 record.json」来告知 pid，等于要求
 * 子进程在 1s 就绪期限内跑完「调度 + 解释器启动 + 写文件」——mac1 八槽并发下这个前提不成立，
 * 期限先到、进程被杀，record.json 于是**永不出现**，readWhenPresent 空转 15s 报错（run 31248564582
 * 即此，同一条用例本地 1.6s 稳过）。从这里取 pid，那场赛跑就不存在了。
 *
 * 读私有字段是刻意的：这条用例要断言的就是「那个具体进程被杀掉了」，绕不开进程句柄。字段若改名，
 * 测试会**确定性地**红（而不是变成时快时慢的 flake），那是可接受的失败方式。
 */
async function waitForSpawnedPid(session: CodexAppServerSession, start?: Promise<unknown>): Promise<number> {
  // @@@no-wallclock — 等「会话 spawn 出子进程」这个事件;能证明它再也不会发生的事件是 start 已落定。
  let settled = false
  start?.then(() => { settled = true }, () => { settled = true })
  return awaitFact('会话 spawn 出 codex 子进程', () => {
    const done = settled
    const pid = sessionProc(session)?.pid
    if (typeof pid === 'number') return pid
    if (done) throw new Error('会话的 start 已落定却没有 spawn 出子进程 —— 卡在 spawn 之前（如端点创建），不是时序抖动。')
    return undefined
  }, { intervalMs: 5 })
}

// @@@4918 正文里**不许**出现 per-test 路径 —— 它是 cachedFixtureExecutable 的内容寻址键。
// 台账写到自己的 cwd 下:产品 spawn 传的 cwd 就是 session.start(dir) 的 dir
// (codex-app-server-delivery.ts:968-969),而每个调用点的 recordPath 都是 join(dir,'record.json')。
function fakeCodexAppServer(recordDelayMs = 0, paginateAfterFirstTurn = false, failDuringInterrupt = false): string {
  const wsPath = require.resolve('ws')
  return `#!/usr/bin/env node
const http = require('node:http')
const { renameSync, writeFileSync } = require('node:fs')
const { WebSocketServer } = require(${JSON.stringify(wsPath)})

const argv = process.argv.slice(2)
const record = { argv, pid: process.pid, guguTestToken: process.env.GUGU_TEST_TOKEN, rpc: [] }
const recordDelayMs = ${recordDelayMs}
let threadMaterialized = false
let recordFlushTimer
const recordPath = require('node:path').join(process.cwd(), 'record.json')
const recordTempPath = recordPath + '.tmp'
const writeRecord = () => {
  writeFileSync(recordTempPath, JSON.stringify(record))
  renameSync(recordTempPath, recordPath)
}
const flushRecord = () => {
  if (recordDelayMs === 0) {
    writeRecord()
    return
  }
  if (!record.rpc.some(({ method }) => method === 'thread/start')) return
  clearTimeout(recordFlushTimer)
  recordFlushTimer = setTimeout(writeRecord, recordDelayMs)
}
// @@@engine-preflight (#3685) — 真 codex 会回答 \`--version\`，宿主在 spawn 前拿它证明引擎跑得起来。
// 桩必须一样能回答，否则它模拟的是一个「装了但跑不起来」的引擎，而那正是宿主该拒绝的东西。
//
// ⚠️ 这一段必须排在 flushRecord() **之前**:预检那次 spawn(assertCodexExecutable,
// codex-app-server-transport.ts:219)**不传 cwd**,继承的是测试进程的 cwd = 仓库根。
// 台账改成 cwd 相对之后,让它在这里写就等于每跑一次往工作树丢一个 record.json。
// 预检那次的台账本来也没人要 —— 真正那次跑起来会覆盖掉它。
if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.155.1\\n')
  process.exit(0)
}
flushRecord()
const listenIndex = argv.indexOf('--listen')
const listenUrl = listenIndex >= 0 ? argv[listenIndex + 1] : ''
if (!listenUrl.startsWith('ws://') && !listenUrl.startsWith('unix://')) {
  process.stderr.write('expected an app-server endpoint, received: ' + listenUrl + '\\n')
  process.exit(2)
}

const server = http.createServer((_request, response) => {
  response.writeHead(404)
  response.end()
})
const sockets = new WebSocketServer({ noServer: true })
server.on('upgrade', (request, socket, head) => {
  sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit('connection', websocket))
})
sockets.on('connection', (websocket) => {
  websocket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    record.rpc.push({ method: message.method, params: message.params })
    flushRecord()
    if (message.method === 'initialize') {
      websocket.send(JSON.stringify({ id: message.id, result: { userAgent: 'fake-codex' } }))
    } else if (message.method === 'thread/start') {
      websocket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-transport' } } }))
    } else if (message.method === 'thread/resume') {
      websocket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-transport' } } }))
    } else if (message.method === 'thread/read') {
      if (!threadMaterialized && message.params?.includeTurns === true) {
        websocket.send(JSON.stringify({
          id: message.id,
          error: {
            code: -32600,
            message: 'thread thread-transport is not materialized yet; includeTurns is unavailable before first user message',
          },
        }))
      } else if (${paginateAfterFirstTurn} && threadMaterialized && message.params?.includeTurns === true) {
        websocket.send(JSON.stringify({
          id: message.id,
          error: { code: -32600, message: 'paginated threads do not support thread/read(includeTurns=true)' },
        }))
      } else {
        websocket.send(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-transport', turns: [] } } }))
      }
    } else if (message.method === 'turn/start') {
      threadMaterialized = true
      websocket.send(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-first' } } }))
    } else if (message.method === 'fixture/start-active-turn') {
      websocket.send(JSON.stringify({ method: 'turn/started', params: {
        threadId: 'thread-transport', turn: { id: 'turn-active' },
      } }))
      websocket.send(JSON.stringify({ id: message.id, result: {} }))
    } else if (message.method === 'fixture/exit' || (message.method === 'turn/interrupt' && ${failDuringInterrupt})) {
      // Failure injection terminates only this fixture itself; never signals a discovered process.
      process.exit(17)
    } else if (message.method === 'fixture/disconnect') {
      websocket.close()
    } else if (message.method === 'thread/queue/start') {
      // 空闲 add 已被服务端自动派发(codex 0.155.1 实测):显式起那一条被以「已有待起的轮」拒绝。
      websocket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: 'thread already has an active or pending turn' } }))
    } else if (message.method === 'thread/queue/list') {
      websocket.send(JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } }))
    } else if (message.method === 'thread/queue/add') {
      // @@@6112 空闲投递走 codex 自己的队列;服务端起轮后 thread 才算落盘。
      threadMaterialized = true
      websocket.send(JSON.stringify({ id: message.id, result: { queuedSubmission: { id: 'queued-first', clientUserMessageId: message.params?.clientUserMessageId, input: message.params?.input } } }))
    }
  })
})
if (listenUrl.startsWith('ws://')) {
  const endpoint = new URL(listenUrl)
  server.listen(Number(endpoint.port), endpoint.hostname)
} else {
  server.listen(listenUrl.slice('unix://'.length))
}

const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`
}

describe('Codex app-server Windows transport (#2808)', () => {
  it.each(['exit', 'disconnect', 'interrupt-exit'] as const)(
    '#5954 recovers the original thread on the first reload after %s',
    async (failure) => {
      const dir = makeTempDir('gugu-codex-recovery-5954')
      const agent = `recovery-${dir}`
      const lifecycle = vi.fn()
      const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer(0, false, failure === 'interrupt-exit'))
      const session = new CodexAppServerSession(agent, codexBin, lifecycle, {
        platform: process.platform,
        startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
      })
      sessions.add(session)
      const threadId = await session.start(dir)
      if (!threadId) throw new Error('codex app-server start returned no thread id')
      const originalPid = await waitForSpawnedPid(session)
      const registry = new CodexAppServerRegistry()
      registry.register(agent, session, 'codex')
      const client = (session as unknown as {
        client: { rpc: (method: string, params: unknown) => Promise<unknown> }
      }).client
      await client.rpc('fixture/start-active-turn', {})
      expect(session.isTurnInFlight()).toBe(true)
      // Attach rejection handlers before failure injection, so the turn cannot become unhandled.
      const completion = session.waitForTurnCompletion('turn-active').then(
        () => { throw new Error('a lost turn must not be reported as successful') },
        (error: Error) => error,
      )
      const starting = session.waitForTurnLive('turn-not-started').catch((error: Error) => error)
      if (failure !== 'interrupt-exit') {
        await expect(client.rpc(`fixture/${failure}`, {})).rejects.toThrow('连接已关闭')
        if (failure === 'disconnect') expect(isProcessAlive(originalPid)).toBe(true)
        expect(session.isLive()).toBe(false)
        expect(session.isTurnInFlight()).toBe(false)
        await expect(session.waitForTurnCompletion('late-waiter')).rejects.toThrow(/closed|exited/)
      }
      // Same stop-then-start contract as manual reload. One unregister must be enough.
      await expect(registry.unregister(agent)).resolves.toBeUndefined()
      expect((await completion).message).toMatch(/control connection closed|app-server exited/)
      expect(await starting).toMatchObject({ message: expect.stringMatching(/control connection closed|app-server exited/) })
      await waitForProcessExit(originalPid)
      // #6448:生命周期回调收的是边对象(`{ type, outcome?, waitKind?, waitId? }`),不再是字符串。
      expect(lifecycle.mock.calls.filter(([edge]) => (edge as { type?: string } | undefined)?.type === 'error')).toHaveLength(1)
      sessions.delete(session)

      const resumed = new CodexAppServerSession(agent, codexBin, undefined, {
        platform: process.platform,
        startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
      })
      sessions.add(resumed)
      await expect(resumed.start(dir, { resumeThreadId: threadId })).resolves.toBe(threadId)
      const resumedRecord = JSON.parse(await readWhenPresent(join(dir, 'record.json'), resumed)) as {
        rpc: Array<{ method: string; params: unknown }>
      }
      expect(resumedRecord.rpc).toContainEqual({ method: 'thread/resume', params: expect.objectContaining({ threadId }) })
      expect(resumedRecord.rpc.some(({ method }) => method === 'thread/start')).toBe(false)
      // @@@6112 空闲投递走 codex 队列(thread/queue/add),不再 turn/start。
      await expect(resumed.deliver('after recovery')).resolves.toMatchObject({ turnId: 'queued-first', queued: true })
      await resumed.dispose()
      sessions.delete(resumed)
      rmSync(dir, { recursive: true, force: true })
    },
  )
  it('does not treat a Unix socket path placeholder as a ready app-server', async () => {
    const endpoint = await createCodexAppServerEndpoint(
      `placeholder-${Date.now()}-${Math.random()}`,
      'darwin'
    )
    removeCodexAppServerEndpoint(endpoint)
    if (endpoint.kind !== 'unix') throw new Error('expected a Unix endpoint')

    writeFileSync(endpoint.socketPath, 'not-listening')
    const child = new EventEmitter() as ChildProcess
    const readiness = waitForCodexAppServerEndpoint(endpoint, child, 15_000)
    let readinessResolved = false
    void readiness.then(() => {
      readinessResolved = true
    })
    let server: Server | undefined

    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(readinessResolved).toBe(false)

      rmSync(endpoint.socketPath, { force: true })
      server = createServer((_request, response) => {
        response.writeHead(404)
        response.end()
      })
      server.on('upgrade', (request, socket) => {
        if (request.url !== '/rpc') return socket.destroy()
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      })
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(endpoint.socketPath, resolve)
      })
      await expect(readiness).resolves.toBeUndefined()
    } finally {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()))
      }
      removeCodexAppServerEndpoint(endpoint)
    }
  })

  it('does not accept an HTTP readyz response without the real RPC WebSocket', async () => {
    const endpoint = await createCodexAppServerEndpoint(
      `legacy-readyz-${Date.now()}-${Math.random()}`,
      'darwin'
    )
    removeCodexAppServerEndpoint(endpoint)
    if (endpoint.kind !== 'unix') throw new Error('expected a Unix endpoint')
    const child = new EventEmitter() as ChildProcess
    const server = createServer((request, response) => {
      response.writeHead(request.url === '/readyz' ? 200 : 404)
      response.end()
    })
    server.on('upgrade', (_request, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint.socketPath, resolve)
    })

    try {
      await expect(waitForCodexAppServerEndpoint(endpoint, child, 250)).rejects.toThrow(
        'endpoint 未在 250ms 内就绪'
      )
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      removeCodexAppServerEndpoint(endpoint)
    }
  })

  it('uses one loopback WebSocket endpoint for listen, RPC, and remote TUI', async () => {
    const dir = makeTempDir('gugu-codex-windows-ws')
    const recordPath = join(dir, 'record.json')
    const codexBin = cachedFixtureExecutable('codex.exe', fakeCodexAppServer())

    const session = new CodexAppServerSession('windows-agent', codexBin, undefined, {
      platform: 'win32',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    await expect(session.start(dir)).resolves.toBe('thread-transport')
    const remoteArgs = session.remoteTuiArgs()
    expect(remoteArgs).toEqual([
      // 全量精确比对:放松成 arrayContaining 的话,以后多塞进来的参数就再没人看着了。
      '--remote',
      expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+$/),
      'resume',
      'thread-transport',
      // #6186:关更新的 `-c` 落在 resume 子命令里(#6186 的读数:放在根级,启动更新菜单照弹)
      '-c',
      'check_for_update_on_startup=false',
    ])

    const record = JSON.parse(await readWhenPresent(recordPath, session)) as { argv: string[]; pid: number }
    const listenUrl = record.argv[record.argv.indexOf('--listen') + 1]
    expect(listenUrl).toBe(remoteArgs[remoteArgs.indexOf('--remote') + 1])

    await session.dispose()
    sessions.delete(session)
    await waitForProcessExit(record.pid)
  })

  it('keeps Unix sessions on their socket endpoint', async () => {
    const dir = makeTempDir('gugu-codex-unix-socket')
    const recordPath = join(dir, 'record.json')
    // Keep this side effect asynchronous so a synchronous record read is a deterministic mutation.
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer(FIXTURE_SIDE_EFFECT_DELAY_MS))

    // Unix endpoints live in global tmp, so concurrent test processes need distinct socket keys.
    const session = new CodexAppServerSession(`unix-agent-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    await expect(session.start(dir)).resolves.toBe('thread-transport')
    const remoteArgs = session.remoteTuiArgs()
    expect(remoteArgs).toEqual([
      // 全量精确比对:放松成 arrayContaining 的话,以后多塞进来的参数就再没人看着了。
      '--remote',
      expect.stringMatching(/^unix:\/\/.+\.sock$/),
      'resume',
      'thread-transport',
      // #6186:关更新的 `-c` 落在 resume 子命令里(#6186 的读数:放在根级,启动更新菜单照弹)
      '-c',
      'check_for_update_on_startup=false',
    ])

    const record = JSON.parse(await readWhenPresent(recordPath, session)) as { argv: string[]; pid: number }
    expect(record.argv[record.argv.indexOf('--listen') + 1]).toBe(remoteArgs[remoteArgs.indexOf('--remote') + 1])

    await session.dispose()
    sessions.delete(session)
    await waitForProcessExit(record.pid)
  })

  it('passes the declared context window to the visible remote TUI', async () => {
    const dir = makeTempDir('gugu-codex-context-window-tui')
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer())
    const session = new CodexAppServerSession('context-window-agent', codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
    })
    sessions.add(session)

    await expect(session.start(dir, {
      extraArgs: ['-c', 'model_context_window=1000000'],
    })).resolves.toBe('thread-transport')
    expect(session.remoteTuiArgs()).toEqual([
      '-c',
      'model_context_window=1000000',
      '--remote',
      expect.stringMatching(/^unix:\/.+\.sock$/),
      'resume',
      'thread-transport',
      '-c',
      'check_for_update_on_startup=false',
    ])

    await session.dispose()
    sessions.delete(session)
  })

  // #6960 回归(0.2.53-beta.55.1):direct_only 只进了 app-server 的进程级 `-c`,TUI 自己建的 thread 拿不到 ——
  // 咕咕工具全被关进 code mode 的 exec 沙箱,模型的工具表上一个都没有。算出来的那张单子(咕咕的 + 直接列出的
  // App)两条 TUI argv 都要带:新建在根级,resume 放进子命令,和 codexSelfUpdateArgs 同一处(#6186 的读数)。
  const DIRECT_ONLY = 'features.code_mode.direct_only_tool_namespaces'
  const directList = { [DIRECT_ONLY]: ['mcp__gugu', 'mcp__omnisearch'] }

  it('pins the materializer\'s direct-only list on the TUI that creates the thread (#6960 regression)', async () => {
    const dir = makeTempDir('gugu-codex-direct-only-create')
    const recordPath = join(dir, 'record.json')
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer())
    const session = new CodexAppServerSession(`direct-only-create-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
    })
    sessions.add(session)

    await expect(session.start(dir, { tuiLoads: 'create', threadConfig: directList })).resolves.toBeNull()
    expect(session.remoteTuiArgs()).toEqual([
      '-c',
      `${DIRECT_ONLY}=["mcp__gugu","mcp__omnisearch"]`,
      '-C',
      dir,
      '--remote',
      expect.stringMatching(/^unix:\/.+\.sock$/),
      '-c',
      'check_for_update_on_startup=false',
    ])
    // Both ends carry the same list, so a thread whichever side builds it sees the same tool table.
    const record = JSON.parse(await readWhenPresent(recordPath, session)) as { argv: string[] }
    expect(record.argv).toContain(`${DIRECT_ONLY}=["mcp__gugu","mcp__omnisearch"]`)

    await session.dispose()
    sessions.delete(session)
  })

  it('pins the same list inside the resume subcommand of the TUI that reopens the thread (#6960 regression)', async () => {
    const dir = makeTempDir('gugu-codex-direct-only-resume')
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer())
    const session = new CodexAppServerSession(`direct-only-resume-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
    })
    sessions.add(session)

    await expect(session.start(dir, { threadConfig: directList })).resolves.toBe('thread-transport')
    expect(session.remoteTuiArgs()).toEqual([
      '--remote',
      expect.stringMatching(/^unix:\/.+\.sock$/),
      'resume',
      '-c',
      `${DIRECT_ONLY}=["mcp__gugu","mcp__omnisearch"]`,
      'thread-transport',
      '-c',
      'check_for_update_on_startup=false',
    ])

    await session.dispose()
    sessions.delete(session)
  })

  // @@@6112 空闲时投递 = `thread/queue/add`(官方给外部程序往会话送消息的路),❌ 不 turn/start。
  it('queues the first fresh delivery without reading turns from an unmaterialized thread', async () => {
    const dir = makeTempDir('gugu-codex-first-delivery')
    const recordPath = join(dir, 'record.json')
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer())

    const session = new CodexAppServerSession(`first-delivery-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    await expect(session.start(dir)).resolves.toBe('thread-transport')
    await expect(session.deliver('first real envelope')).resolves.toMatchObject({ turnId: 'queued-first', queued: true })

    const record = JSON.parse(await readWhenPresent(recordPath, session)) as {
      pid: number
      rpc: Array<{ method: string }>
    }
    expect(record.rpc.map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'thread/queue/add',
      // 起咕咕自己那一条:服务端已自动派发 → 拒绝,以队列此刻的事实确认它已不在队列。
      'thread/queue/start',
      'thread/queue/list',
    ])

    await session.dispose()
    sessions.delete(session)
    await waitForProcessExit(record.pid)
  })

  // owner 2026-09-04 实机:「第一个对话百分百能回,第二个百分百回不了」。根因是 thread 一旦分页,
  // codex 就永久拒绝 `thread/read(includeTurns=true)`,而容错只认「尚未 materialize」那一种说法,
  // 另一种被当故障抛出 ⇒ 第一轮之后每一轮都挂。判据:第二次投递必须照常起 turn。
  it('keeps delivering after the thread paginates and codex refuses includeTurns', async () => {
    const dir = makeTempDir('gugu-codex-paginated')
    const recordPath = join(dir, 'record.json')
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer(0, true))

    const session = new CodexAppServerSession(`paginated-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    await expect(session.start(dir)).resolves.toBe('thread-transport')
    const queued = { turnId: 'queued-first', queued: true }
    await expect(session.deliver('first envelope')).resolves.toMatchObject(queued)
    await expect(session.deliver('second envelope')).resolves.toMatchObject(queued)
    await expect(session.deliver('third envelope')).resolves.toMatchObject(queued)

    const record = JSON.parse(await readWhenPresent(recordPath, session)) as {
      pid: number
      rpc: Array<{ method: string }>
    }
    // 被拒绝的读法只问一次:分页是不可逆的,再问就是每轮白烧一次 RPC。
    expect(record.rpc.filter(({ method }) => method === 'thread/read')).toHaveLength(1)
    expect(record.rpc.filter(({ method }) => method === 'thread/queue/add')).toHaveLength(3)

    await session.dispose()
    sessions.delete(session)
    await waitForProcessExit(record.pid)
  })

  it('materializes a resumed thread whose persisted id predates its first user message', async () => {
    const dir = makeTempDir('gugu-codex-resume-before-first-delivery')
    const recordPath = join(dir, 'record.json')
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer())

    const session = new CodexAppServerSession(`resume-before-first-delivery-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    await expect(session.start(dir, { resumeThreadId: 'thread-transport' })).resolves.toBe('thread-transport')
    await expect(session.deliver('first real envelope after reopen')).resolves.toMatchObject({ turnId: 'queued-first', queued: true })

    const record = JSON.parse(await readWhenPresent(recordPath, session)) as {
      pid: number
      rpc: Array<{ method: string }>
    }
    expect(record.rpc.map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'thread/read',
      'thread/queue/add',
      'thread/queue/start',
      'thread/queue/list',
    ])

    await session.dispose()
    sessions.delete(session)
    await waitForProcessExit(record.pid)
  })

  it('sets developer instructions on the native thread-open RPC', async () => {
    const dir = makeTempDir('gugu-codex-developer-instructions')
    const recordPath = join(dir, 'record.json')
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer())

    const session = new CodexAppServerSession(`prompt-agent-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    await expect(session.start(dir, {
      developerInstructions: 'Gugu identity',
    })).resolves.toBe('thread-transport')
    const record = JSON.parse(await readWhenPresent(recordPath, session)) as {
      pid: number
      rpc: Array<{ method: string; params?: Record<string, unknown> }>
    }
    expect(record.rpc.map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'thread/start'
    ])
    expect(record.rpc[2]?.params).toMatchObject({
      cwd: dir,
      developerInstructions: 'Gugu identity',
    })
    // #3907 session-TUI cannot consume model-level dynamic tools.
    expect(record.rpc[2]?.params).not.toHaveProperty('dynamicTools')

    await session.dispose()
    sessions.delete(session)
    await waitForProcessExit(record.pid)
  })

  it('passes MCP values through the app-server environment, not argv', async () => {
    const dir = makeTempDir('gugu-codex-mcp-env')
    const recordPath = join(dir, 'record.json')
    const token = 'synthetic-child-env-token'
    const codexBin = cachedFixtureExecutable('codex', fakeCodexAppServer())

    const session = new CodexAppServerSession(`mcp-env-agent-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    await expect(
      session.start(dir, {
        extraArgs: ['-c', 'mcp_servers.gugu.env_vars=["GUGU_TEST_TOKEN"]'],
        // `env` 现在是**完整**的那一份(#5702):引擎进程不再自己铺 `...process.env`,
        // 而是照单收下宿主算好的环境。真会话里那一份由 `composeAgentSpawnEnv` 产出、带着
        // 白名单里的 PATH;这里的夹具要同样完整,否则连 `#!/usr/bin/env node` 都找不到 node。
        env: { ...process.env, GUGU_TEST_TOKEN: token } as Record<string, string>
      })
    ).resolves.toBe('thread-transport')

    const record = JSON.parse(await readWhenPresent(recordPath, session)) as {
      argv: string[]
      pid: number
      guguTestToken: string
    }
    expect(record.argv).toContain('mcp_servers.gugu.env_vars=["GUGU_TEST_TOKEN"]')
    expect(record.argv.join(' ')).not.toContain(token)
    expect(record.guguTestToken).toBe(token)

    await session.dispose()
    sessions.delete(session)
    await waitForProcessExit(record.pid)
  })

  it('includes the Codex stderr tail when startup exits before readiness', async () => {
    const dir = makeTempDir('gugu-codex-windows-stderr')
    const codexBin = cachedFixtureExecutable(
      'codex.exe',
      '#!/usr/bin/env node\nif (process.argv.slice(2).includes("--version")) { process.stdout.write("codex-cli 0.155.1\\n"); process.exit(0) }\nprocess.stderr.write("bind failed on Windows loopback\\n")\nprocess.exit(2)\n'
    )

    const session = new CodexAppServerSession('windows-stderr', codexBin, undefined, {
      platform: 'win32',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS
    })
    sessions.add(session)

    const failure = session.start(dir)
    await expect(failure).rejects.toThrow('bind failed on Windows loopback')
    await expect(failure).rejects.not.toThrow('Codex stderr 可能不完整')
  })

  // #5635 平台会话要先写 codex 的 model catalog(跑一次 `codex debug models --bundled`)。
  // 那一步必须排在「引擎跑得起来」的判定之后:codex 不在 PATH 上时,用户该看到的是找不到可执行文件 +
  // PATH 的去向,而不是一句「请升级 Codex」—— 后者会把人指去升级一个根本没装上的东西。
  const PLATFORM_FACTS = JSON.stringify([
    { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high'] },
  ])

  it('#5635 platform session, codex not on PATH: executable-not-found with PATH, never the catalog/upgrade message', async () => {
    const dir = makeTempDir('gugu-codex-catalog-missing-bin')
    const session = new CodexAppServerSession('catalog-missing-bin', join(dir, 'no-such-codex'), undefined, {
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
    })
    sessions.add(session)
    const failure = session.start(dir, { env: { PATH: '/usr/bin:/bin', GUGU_PLATFORM_MODELS: PLATFORM_FACTS } })
    await expect(failure).rejects.toThrow('找不到可执行文件')
    await expect(failure).rejects.toThrow(/PATH/)
    await expect(failure).rejects.not.toThrow(/debug models|升级 Codex/)
  })

  it('#5635 [control] codex runs but cannot report its catalog: the catalog step is reached and says so', async () => {
    const dir = makeTempDir('gugu-codex-catalog-old-bin')
    const codexBin = cachedFixtureExecutable(
      'codex-no-debug-models',
      '#!/usr/bin/env node\nif (process.argv.slice(2).includes("--version")) { process.stdout.write("codex-cli 0.155.1\\n"); process.exit(0) }\nprocess.stderr.write("error: unrecognized subcommand\\n")\nprocess.exit(2)\n'
    )
    const session = new CodexAppServerSession('catalog-old-bin', codexBin, undefined, {
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
    })
    sessions.add(session)
    const failure = session.start(dir, { env: { ...process.env, GUGU_PLATFORM_MODELS: PLATFORM_FACTS } })
    await expect(failure).rejects.toThrow(/codex debug models --bundled/)
    await expect(failure).rejects.toThrow('unrecognized subcommand')
  })

  it('waits for process-group terminal so delayed Codex stderr is complete', async () => {
    const dir = makeTempDir('gugu-codex-stderr-close-timeout')
    const recordPath = join(dir, 'record.json')
    const installHandlerPath = join(dir, 'install-handler')
    const handlerInstalledPath = join(dir, 'handler-installed')
    const allowEndpointPath = join(dir, 'allow-endpoint')
    const codexBin = cachedFixtureExecutable(
      'codex',
      `#!/usr/bin/env node
const http = require('node:http')
const { existsSync, renameSync, writeFileSync } = require('node:fs')
const argv = process.argv.slice(2)
if (argv.includes('--version')) { process.stdout.write('codex-cli 0.155.1\\n'); process.exit(0) }
// 所有落地物都写到自己的 cwd 下 —— 产品 spawn 传的 cwd 就是 session.start(dir) 的 dir。
// ❌ 别把 dir 拼进正文:那样内容每跑一次都不同,内容寻址的缓存就白设了。
const here = (name) => require('node:path').join(process.cwd(), name)
const listenIndex = argv.indexOf('--listen')
const listenUrl = listenIndex >= 0 ? argv[listenIndex + 1] : ''
const recordTempPath = here('record.json.tmp')
writeFileSync(recordTempPath, '')
setTimeout(() => {
  writeFileSync(recordTempPath, JSON.stringify({ pid: process.pid }))
  renameSync(recordTempPath, here('record.json'))
}, ${FIXTURE_SIDE_EFFECT_DELAY_MS})

function delayStderr() {
  process.removeListener('SIGTERM', delayStderr)
  setTimeout(() => {
    process.stderr.write('late Codex startup failure\\n')
    process.exit(2)
  }, ${FIXTURE_SIDE_EFFECT_DELAY_MS})
}

function waitForHandlerRequest() {
  if (!existsSync(here('install-handler'))) {
    setTimeout(waitForHandlerRequest, 10)
    return
  }
  setTimeout(() => {
    process.on('SIGTERM', delayStderr)
    const installedTempPath = here('handler-installed.tmp')
    writeFileSync(installedTempPath, 'installed')
    renameSync(installedTempPath, here('handler-installed'))
  }, 1_000)
}
waitForHandlerRequest()

const server = http.createServer((_request, response) => {
  response.writeHead(404)
  response.end()
})
let upgradeCount = 0
server.on('upgrade', (_request, socket) => {
  upgradeCount += 1
  if (upgradeCount === 1) {
    socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n')
  }
})
function waitForEndpointRelease() {
  if (!existsSync(here('allow-endpoint'))) {
    setTimeout(waitForEndpointRelease, 10)
    return
  }
  server.listen(listenUrl.slice('unix://'.length))
}
waitForEndpointRelease()
setInterval(() => {}, 1_000)
`
    )

    const session = new CodexAppServerSession(`stderr-close-timeout-${dir}`, codexBin, undefined, {
      platform: 'darwin',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
      handshakeTimeoutMs: 250
    })
    sessions.add(session)

    const failure = session.start(dir)
    const record = JSON.parse(await readWhenPresent(recordPath, session)) as { pid: number }
    await installSignalHandler(installHandlerPath, handlerInstalledPath)
    writeFileSync(allowEndpointPath, '')

    await expect(failure).rejects.toThrow('late Codex startup failure')
    await expect(failure).rejects.not.toThrow('Codex stderr 可能不完整')
    // #7103 归类:咕咕先握手超时、再拆进程,拆的时候 codex 打的那一行只进原文与日志 ——
    // 这一次是咕咕的错,到界面是「咕咕这边出错了」,❌ 把那一行当成 codex 的原话。
    const error = await failure.then(() => null, (thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(HarnessStartupError)
    expect(String(startupFailureForUser(error))).toBe('Error: gugu-models:service-unavailable')
    await waitForProcessExit(record.pid)
  })

  it('recognizes an already signal-closed process with ended stderr as closed', async () => {
    const proc = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: 'SIGTERM',
      stderr: { readableEnded: true }
    }) as unknown as ChildProcess

    await expect(waitForCodexAppServerProcessClose(proc)).resolves.toEqual({ status: 'closed' })
  })

  it('fails a ready endpoint when the WebSocket handshake stalls', async () => {
    const dir = makeTempDir('gugu-codex-windows-handshake-timeout')
    const recordPath = join(dir, 'record.json')
    const codexBin = cachedFixtureExecutable(
      'codex.exe',
      `#!/usr/bin/env node
const http = require('node:http')
const { renameSync, writeFileSync } = require('node:fs')
const argv = process.argv.slice(2)
if (argv.includes('--version')) { process.stdout.write('codex-cli 0.155.1\\n'); process.exit(0) }
// 所有落地物都写到自己的 cwd 下 —— 产品 spawn 传的 cwd 就是 session.start(dir) 的 dir。
// ❌ 别把 dir 拼进正文:那样内容每跑一次都不同,内容寻址的缓存就白设了。
const here = (name) => require('node:path').join(process.cwd(), name)
const listenIndex = argv.indexOf('--listen')
const endpoint = new URL(argv[listenIndex + 1])
const sockets = new Set()
const server = http.createServer((_request, response) => {
  response.writeHead(404)
  response.end()
})
let upgradeCount = 0
server.on('upgrade', (_request, socket) => {
  upgradeCount += 1
  if (upgradeCount === 1) {
    socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n')
    return
  }
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
server.listen(Number(endpoint.port), endpoint.hostname, () => {
  const recordTempPath = here('record.json.tmp')
  writeFileSync(recordTempPath, JSON.stringify({ pid: process.pid }))
  renameSync(recordTempPath, here('record.json'))
})
const stop = () => {
  for (const socket of sockets) socket.destroy()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`
    )

    const session = new CodexAppServerSession('windows-handshake-timeout', codexBin, undefined, {
      platform: 'win32',
      startupTimeoutMs: NON_TIMEOUT_STARTUP_TIMEOUT_MS,
      handshakeTimeoutMs: 250
    })
    sessions.add(session)

    await expect(session.start(dir)).rejects.toThrow('WS 握手未在 250ms 内完成')
    const record = JSON.parse(await readWhenPresent(recordPath, session)) as { pid: number }
    await waitForProcessExit(record.pid)
  })

  it('kills a still-running Codex process after a readiness timeout', async () => {
    const dir = makeTempDir('gugu-codex-windows-timeout')
    // 被测的就是就绪期限本身,而那个期限从 spawn 起算,没有可以插进去的同步点(隔壁 stderr 那条能
    // 改用 handshakeTimeout,是因为握手期限从「端点已就绪」才起算)。
    //
    // 这条用例曾经**必然**和假进程赛跑:它靠假 codex 自己写 record.json 来告知 pid,于是要求子进程
    // 在 1s 期限内跑完「OS 调度 + 解释器启动 + 写文件」。先用 node、后换 /bin/sh 压小另一头,都只是
    // 把概率往下压 —— mac1 八槽并发下照样期限先到、脚本第一行没执行就被杀,record.json 永不出现
    // (run 31218563448、31248564582 两次红都是这样,而同一条用例本地 1.6s 稳过)。
    //
    // 现在 pid 改从会话持有的进程句柄取(waitForSpawnedPid):spawn 一返回就有值,不需要子进程被调度、
    // 更不需要它执行任何一行 —— 赛跑不是被压小,是**不存在了**。假 codex 因此也不用再写记录文件,
    // 连带去掉了「`>` 先把目标截空、readWhenPresent 只看存在不看内容」那个自造的次生 flake。
    const codexBin = cachedFixtureExecutable(
      'codex.exe',
      `#!/bin/sh
# @@@engine-preflight (#3685) — 这条用例要测的是【就绪期限】，而不是「引擎装没装」。
# 宿主现在会先用 --version 证明引擎跑得起来，所以桩必须先过那一关，
# 才能走到它真正要模拟的那一格：起来了、但端点一直不就绪。
case " $* " in *" --version "*) printf 'codex-cli 0.155.1\\n'; exit 0;; esac
printf 'listener remained pending on Windows loopback\\n' >&2
while :; do sleep 1; done
`
    )

    const session = new CodexAppServerSession('windows-timeout', codexBin, undefined, {
      platform: 'win32',
      startupTimeoutMs: READINESS_TIMEOUT_MS
    })
    sessions.add(session)

    const failure = session.start(dir)
    // 先挂上 catch:下面要先去取 pid,期间这个 promise 会先 reject,没人接住就是 unhandled rejection。
    // 同一个 promise 可以被多次消费,后面的 expect(...).rejects 仍然照常断言。
    failure.catch(() => {})
    const pid = await waitForSpawnedPid(session, failure)

    await expect(failure).rejects.toThrow(`endpoint 未在 ${READINESS_TIMEOUT_MS}ms 内就绪`)
    await waitForProcessExit(pid)
  })

  it('wraps generic batch launchers without routing native exe files through a shell', () => {
    const command = String.raw`C:\Program Files\Gugu\gugu.exe`
    const args = [
      'app-server',
      '--listen',
      'ws://127.0.0.1:3210',
      '-c',
      `mcp_servers.gugu.command=${JSON.stringify(command)}`,
      '-c',
      'mcp_servers.gugu.env_vars=["GUGU_ACCESS_TOKEN"]'
    ]
    const cmdLaunch = resolveCodexAppServerSpawn(
      String.raw`C:\Tools\custom-codex.cmd`,
      args,
      'win32',
      { ComSpec: String.raw`C:\Windows\System32\cmd.exe` }
    )
    expect(cmdLaunch).toMatchObject({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: ['/d', '/s', '/c', expect.stringContaining('custom-codex.cmd')],
      windowsVerbatimArguments: true
    })
    expect(cmdLaunch.args[3]).toContain('mcp_servers.gugu.env_vars')

    const codexBin = String.raw`C:\Users\tester\AppData\Roaming\npm\codex.cmd`
    const codexNode = String.raw`C:\Users\tester\AppData\Roaming\npm\node.exe`
    const codexEntry = String.raw`C:\Users\tester\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`
    const shimReader: WindowsShimReader = {
      readShim: (path) => path.toLowerCase() === codexBin.toLowerCase()
        ? [
          '@ECHO off',
          'SETLOCAL',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          ')',
          'endLocal & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
        ].join('\r\n')
        : null,
      exists: (path) => [codexNode, codexEntry].some((candidate) => candidate.toLowerCase() === path.toLowerCase())
    }
    expect(resolveCodexAppServerSpawn(codexBin, args, 'win32', {}, shimReader)).toEqual({
      command: codexNode,
      args: [codexEntry, ...args]
    })

    expect(
      resolveCodexAppServerSpawn(
        String.raw`C:\Tools\custom-codex.bat`,
        args,
        'win32',
        { ComSpec: String.raw`C:\Windows\System32\cmd.exe` }
      )
    ).toMatchObject({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: ['/d', '/s', '/c', expect.stringContaining('custom-codex.bat')],
      windowsVerbatimArguments: true
    })

    expect(
      resolveCodexAppServerSpawn(
        String.raw`C:\Users\tester\AppData\Roaming\npm\codex.ps1`,
        args,
        'win32'
      )
    ).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        String.raw`C:\Users\tester\AppData\Roaming\npm\codex.ps1`,
        ...args
      ]
    })

    expect(
      resolveCodexAppServerSpawn(
        String.raw`C:\Program Files\CodexStack\Codex\codex.exe`,
        args,
        'win32'
      )
    ).toEqual({
      command: String.raw`C:\Program Files\CodexStack\Codex\codex.exe`,
      args
    })
  })

  it.runIf(process.platform === 'win32')(
    'preserves config argv through a generic batch launcher on Windows',
    () => {
      const dir = makeTempDir('gugu-codex-cmd-forwarding')
      const launcherDir = join(dir, 'launcher with spaces')
      mkdirSync(launcherDir, { recursive: true })
      const recordPath = join(dir, 'argv.json')
      const recorderPath = join(launcherDir, 'record.cjs')
      const codexBin = join(launcherDir, 'custom-codex.cmd')
      writeFileSync(
        recorderPath,
        "require('node:fs').writeFileSync(process.env.GUGU_ARGV_RECORD, JSON.stringify(process.argv.slice(2)))\n"
      )
      writeFileSync(codexBin, '@echo off\r\nnode "%~dp0\\record.cjs" %*\r\n')
      const mcpCommand = String.raw`C:\Program Files\Gugu\gugu.exe`
      const mcpArgs = [String.raw`C:\Program Files\Gugu\gugu-im-server.mjs`, 'A&B']
      const args = [
        'app-server',
        '--listen',
        'ws://127.0.0.1:3210',
        '-c',
        `mcp_servers.gugu.command=${JSON.stringify(mcpCommand)}`,
        '-c',
        `mcp_servers.gugu.args=${JSON.stringify(mcpArgs)}`,
        '-c',
        'mcp_servers.gugu.env_vars=["GUGU_ACCESS_TOKEN"]'
      ]
      const launch = resolveCodexAppServerSpawn(codexBin, args, 'win32', process.env)
      const result = spawnSync(launch.command, launch.args, {
        env: { ...process.env, GUGU_ARGV_RECORD: recordPath },
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments
      })

      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(args)
    }
  )
})
