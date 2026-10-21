// #6264 编程会话的推理后台(codex app-server / opencode serve / droid daemon)住进 tmux,活过宿主进程重启。
// 真 tmux + 真 codex 的跨重启实测在容器里跑(见 PR 说明);这里钉住每一块的判据。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  backendSessionNameFor,
  buildLaunchScript,
  findTmuxBackend,
  launchTmuxBackend,
  sweepOrphanTmuxBackends,
  TmuxBackend,
  type TmuxBackendDeps,
} from '../../../../apps/desktop/electron/sessionpage/tmux-backend'
import {
  CodexAppServerSession,
  disposeAllCodexAppServerSessions,
  killAllCodexAppServerProcessGroupsSync,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'

const SEP = '|@|'
const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bk6264-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeDeps(overrides: Partial<TmuxBackendDeps> & { alive?: Set<number> } = {}): TmuxBackendDeps & {
  calls: string[][]
  signals: Array<[number, NodeJS.Signals]>
} {
  const alive = overrides.alive ?? new Set<number>()
  const calls: string[][] = []
  const signals: Array<[number, NodeJS.Signals]> = []
  const dir = tempDir()
  return {
    calls,
    signals,
    tmux: overrides.tmux ?? (async (args) => { calls.push(args); return '' }),
    ownServer: overrides.ownServer ?? (() => true),
    isPidAlive: overrides.isPidAlive ?? ((pid) => alive.has(pid)),
    signalGroup: overrides.signalGroup ?? ((pid, signal) => {
      signals.push([pid, signal])
      if (signal === 'SIGTERM' || signal === 'SIGKILL') alive.delete(pid)
    }),
    scratchDir: overrides.scratchDir ?? (() => dir),
    sleep: overrides.sleep ?? (async () => undefined),
  }
}

describe('#6264 后台与终端按名字配对', () => {
  it('gugu-<x> 的后台叫 gugubk-<x>;不是咕咕的终端会话名 → 没有后台可配', () => {
    expect(backendSessionNameFor('gugu-abc')).toBe('gugubk-abc')
    expect(backendSessionNameFor('emdash-abc')).toBeNull()
    expect(backendSessionNameFor('gugu-')).toBeNull()
    expect(backendSessionNameFor(undefined)).toBeNull()
  })

  it('后台的名字不以 gugu- 开头 —— 否则会被当成终端会话去对账 / 回收', () => {
    expect(backendSessionNameFor('gugu-abc')!.startsWith('gugu-')).toBe(false)
  })
})

describe('#6264 启动脚本', () => {
  it('环境只从脚本里来(env -i 清掉 tmux 服务器的那份);读完即删;stderr 进日志', () => {
    const dir = tempDir()
    const script = join(dir, 'launch.sh')
    const out = join(dir, 'out')
    const log = join(dir, 'log')
    const tricky = `it's "quoted" $HOME \`x\`\nsecond line`
    writeFileSync(script, buildLaunchScript({
      command: '/bin/sh',
      args: ['-c', `printf '%s|%s|%s' "$SECRET" "$PWD" "\${LEAK-unset}" > ${out}; echo on-stderr >&2`],
      env: { SECRET: tricky, PATH: '/usr/bin:/bin', 'BAD-NAME': 'skipped', UNDEF: undefined },
      cwd: dir,
    }, log))
    const result = spawnSync('env', ['-i', '/bin/sh', script], { env: { LEAK: 'from-parent' }, encoding: 'utf8' })
    expect(result.status).toBe(0)
    const [secret, pwd, leak] = readFileSync(out, 'utf8').split('|')
    expect(secret).toBe(tricky)
    expect(pwd).toContain(dir.split('/').pop())
    expect(leak).toBe('unset')
    expect(existsSync(script)).toBe(false)
    expect(readFileSync(log, 'utf8')).toBe('on-stderr\n')
  })

  it('HUP / TERM 转成对整组的 TERM —— codex app-server 自己不理 SIGHUP(终端会话一关,tmux 发的就是它)', () => {
    const text = buildLaunchScript({ command: 'x', args: [], env: {}, cwd: '/' }, '/l')
    expect(text).toContain(`trap 'trap - TERM; kill -TERM 0; exit 129' HUP TERM`)
    // 后台 ❌ exec:守着它的 sh 的 0/1/2 留在 pane 的 pty 上,否则 tmux 当 pane 已死、起来即收(实测)。
    expect(text).not.toMatch(/^exec /m)
    expect(text).toMatch(/ &\nwait \$!\n$/)
  })
})

describe('#6264 在 tmux 里起后台', () => {
  it('一条 tmux 调用:建会话、记类型/地址/日志、挂钩子、回 pane pid;环境 ❌ 进命令行', async () => {
    const deps = fakeDeps({ tmux: async (args) => { deps.calls.push(args); return '4242\n' } })
    const backend = await launchTmuxBackend({
      name: 'gugubk-x', kind: 'codex-app-server', endpoint: 'unix:///s.sock',
      command: '/bin/codex', args: ['app-server'], env: { TOKEN: 'sekrit' }, cwd: '/w',
    }, deps)
    expect(backend.pid).toBe(4242)
    const args = deps.calls[0]!
    expect(args.slice(0, 4)).toEqual(['new-session', '-d', '-s', 'gugubk-x'])
    expect(args.join(' ')).not.toContain('sekrit')
    expect(args).toContain('@gugu-backend-endpoint')
    expect(args).toContain('unix:///s.sock')
    expect(args).toContain('session-closed[6264]')
    expect(args.slice(-5)).toEqual(['display-message', '-p', '-t', 'gugubk-x', '#{pane_pid}'])
  })

  it('用户自己的 tmux 服务器(没有套接字标签)上 ❌ 挂全局钩子', async () => {
    const deps = fakeDeps({ ownServer: () => false, tmux: async (args) => { deps.calls.push(args); return '4242' } })
    await launchTmuxBackend({ name: 'gugubk-x', kind: 'opencode-serve', endpoint: 'http://127.0.0.1:1', command: 'c', args: [], env: {}, cwd: '/' }, deps)
    expect(deps.calls[0]).not.toContain('set-hook')
  })

  it('起不来 → 抛,且启动脚本不留在盘上(里面有环境)', async () => {
    const deps = fakeDeps({ tmux: async () => { throw new Error('duplicate session: gugubk-x') } })
    await expect(launchTmuxBackend({ name: 'gugubk-x', kind: 'droid-daemon', endpoint: 'ws://127.0.0.1:1', command: 'c', args: [], env: { T: 'v' }, cwd: '/' }, deps))
      .rejects.toThrow(/duplicate session/)
    const dir = deps.scratchDir()
    expect(spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.trim()).toBe('')
  })
})

describe('#6264 按名字接回 / 启动对账', () => {
  const row = (name: string, pid: number, kind: string, endpoint = 'unix:///s', log = '') => [name, pid, kind, endpoint, log].join(SEP)

  it('找到同名、同类、还活着的那台 → 交回它的地址与 pid', async () => {
    const deps = fakeDeps({ alive: new Set([77]), tmux: async () => `${row('gugu-a', 5, '')}\n${row('gugubk-a', 77, 'codex-app-server', 'unix:///a.sock')}\n` })
    const found = await findTmuxBackend('gugubk-a', 'codex-app-server', deps)
    expect(found?.pid).toBe(77)
    expect(found?.endpoint).toBe('unix:///a.sock')
    expect(await findTmuxBackend('gugubk-a', 'opencode-serve', deps)).toBeNull()
  })

  it('会话在、进程已死 → 关掉那个会话,返回 null(调用方新起)', async () => {
    const deps = fakeDeps({ tmux: async (args) => { deps.calls.push(args); return row('gugubk-a', 77, 'codex-app-server') } })
    expect(await findTmuxBackend('gugubk-a', 'codex-app-server', deps)).toBeNull()
    expect(deps.calls.at(-1)).toEqual(['kill-session', '-t', 'gugubk-a'])
  })

  it('没有 tmux 服务器 / 机器上没有 tmux = 没有后台(读数,不是故障)', async () => {
    const noServer = fakeDeps({ tmux: async () => { throw Object.assign(new Error('x'), { stderr: 'no server running on /tmp/tmux-0/l' }) } })
    expect(await findTmuxBackend('gugubk-a', 'codex-app-server', noServer)).toBeNull()
    const noTmux = fakeDeps({ tmux: async () => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }) } })
    expect(await sweepOrphanTmuxBackends(noTmux)).toEqual({ kept: 0, reaped: [] })
  })

  it('启动对账:终端会话还在的留着,不在的整组收掉并关会话', async () => {
    const alive = new Set([11, 22])
    const deps = fakeDeps({
      alive,
      tmux: async (args) => {
        deps.calls.push(args)
        return args[0] === 'list-sessions'
          ? [row('gugu-kept', 1, ''), row('gugubk-kept', 11, 'codex-app-server'), row('gugubk-orphan', 22, 'opencode-serve'), row('user-own', 3, '')].join('\n')
          : ''
      },
    })
    const result = await sweepOrphanTmuxBackends(deps)
    expect(result).toEqual({ kept: 1, reaped: ['gugubk-orphan'] })
    expect(deps.signals).toEqual([[22, 'SIGTERM']])
    expect(deps.calls).toContainEqual(['kill-session', '-t', 'gugubk-orphan'])
    expect(alive.has(11)).toBe(true)
  })

  it('tmux 调用失败(不是「没有服务器」)→ 一个都不动 —— ❌ 当成空集去收,那会收掉正在用的后台', async () => {
    const deps = fakeDeps({ tmux: async () => { throw Object.assign(new Error('boom'), { stderr: 'lost server' }) } })
    expect(await sweepOrphanTmuxBackends(deps)).toEqual({ kept: 0, reaped: [] })
    expect(deps.signals).toEqual([])
  })

  it('收尾:TERM 不走就 KILL;证明整组没了才关会话', async () => {
    const alive = new Set([9])
    const deps = fakeDeps({
      alive,
      signalGroup: (pid, signal) => { deps.signals.push([pid, signal]); if (signal === 'SIGKILL') alive.delete(pid) },
    })
    await new TmuxBackend('gugubk-z', 'codex-app-server', 'unix:///z', 9, '', deps).terminate(10, 10)
    expect(deps.signals).toEqual([[9, 'SIGTERM'], [9, 'SIGKILL']])
    expect(deps.calls).toEqual([['kill-session', '-t', 'gugubk-z']])
  })
})

// ── codex:接回一台活过宿主的 app-server ────────────────────────────────────────────────
type FakeServer = { server: Server; wss: WebSocketServer; methods: string[]; socket: () => WebSocket | null; closed: Promise<void> }

async function fakeAppServer(socketPath: string): Promise<FakeServer> {
  const methods: string[] = []
  let current: WebSocket | null = null
  let markClosed!: () => void
  const closed = new Promise<void>((resolve) => { markClosed = resolve })
  const server = createServer()
  // 等 listening 或 error:bind 失败(路径上已有 socket 文件 → EADDRINUSE;TMPDIR 太长、超过 sun_path 104 字节 → EINVAL)时
  // listen 只发 error、回调不来(testTimeout 是 0 ⇒ 无限等)。WebSocketServer 要在 listen 成功之后再挂:它挂上时会在 server 上
  // 先登记一个转发 error 的监听，自己又没有 error 监听 ⇒ bind 失败时它先抛，这里的 reject 轮不到。
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject).listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const wss = new WebSocketServer({ server, path: '/rpc' })
  wss.on('connection', (ws) => {
    current = ws
    ws.on('close', () => markClosed())
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: number; method: string; params?: Record<string, unknown> }
      if (msg.id === undefined) return // 通知(initialized)不回
      methods.push(msg.method)
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }))
      const notify = (method: string, params: Record<string, unknown>) => ws.send(JSON.stringify({ method, params }))
      switch (msg.method) {
        case 'initialize': return reply({})
        case 'thread/read': return reply({ thread: { id: 'tid-1', model: 'gpt-x', turns: [] } })
        case 'thread/resume': return reply({ thread: { id: 'tid-1', turns: [] } })
        case 'thread/queue/add': {
          reply({ queuedSubmission: { id: 'sub-1' } })
          const clientId = msg.params?.clientUserMessageId
          setTimeout(() => {
            notify('item/started', { threadId: 'tid-1', turnId: 'turn-1', item: { type: 'userMessage', clientId } })
            notify('turn/started', { threadId: 'tid-1', turn: { id: 'turn-1' } })
            setTimeout(() => notify('turn/completed', { threadId: 'tid-1', turn: { id: 'turn-1', status: 'completed' } }), 30)
          }, 10)
          return
        }
        default: return reply({})
      }
    })
  })
  return { server, wss, methods, socket: () => current, closed }
}

describe.skipIf(process.platform === 'win32')('#6264 codex:新宿主接回 tmux 里的 app-server', () => {
  const servers: FakeServer[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      for (const client of s.wss.clients) client.terminate()
      s.wss.close()
      s.server.closeAllConnections()
      await new Promise<void>((resolve) => s.server.close(() => resolve()))
    }
  })

  async function adopted() {
    const dir = tempDir()
    const sock = join(dir, 'cx.sock')
    const fake = await fakeAppServer(sock)
    servers.push(fake)
    const terminate = vi.fn(async () => undefined)
    const backend = Object.assign(new TmuxBackend('gugubk-a', 'codex-app-server', `unix://${sock}`, 4242, '', fakeDeps({ alive: new Set([4242]) })), { terminate })
    const lifecycle: string[] = []
    const session = new CodexAppServerSession('agent-1', '/unused/codex', (l) => lifecycle.push(l.type), { sessionId: 'conv-1', tmuxBackendName: 'gugubk-a' })
    const threadId = await session.adopt('/w', backend, { threadId: 'tid-1' })
    return { session, fake, backend, terminate, lifecycle, threadId }
  }

  it('不起进程:连上原地址 → initialize → 读 thread 设置 → 按序接入(thread/resume);接回即可投递', async () => {
    const { session, fake, threadId } = await adopted()
    expect(threadId).toBe('tid-1')
    expect(fake.methods).toEqual(['initialize', 'thread/read', 'thread/resume'])
    expect(session.isLive()).toBe(true)
    expect(session.isTmuxHosted()).toBe(true)
    // 重拉 TUI 时仍是 `resume <同一条 thread>`,连的是同一个地址。
    expect(session.remoteTuiArgs().join(' ')).toMatch(/--remote unix:\/\/.*cx\.sock resume .*tid-1( |$)/)
    session.detach()
  })

  it('接回时调用方递来同一份 threadConfig:重拉的 TUI 照样带 code mode 直接命名空间(#6960 回归)', async () => {
    const dir = tempDir()
    const sock = join(dir, 'cx.sock')
    const fake = await fakeAppServer(sock)
    servers.push(fake)
    const backend = Object.assign(new TmuxBackend('gugubk-b', 'codex-app-server', `unix://${sock}`, 4243, '', fakeDeps({ alive: new Set([4243]) })), { terminate: vi.fn(async () => undefined) })
    const session = new CodexAppServerSession('agent-2', '/unused/codex', undefined, { sessionId: 'conv-2', tmuxBackendName: 'gugubk-b' })
    await session.adopt('/w', backend, {
      threadId: 'tid-1',
      threadConfig: { 'features.code_mode.direct_only_tool_namespaces': ['mcp__gugu', 'mcp__omnisearch'] },
    })
    const argv = session.remoteTuiArgs()
    const pin = argv.indexOf('features.code_mode.direct_only_tool_namespaces=["mcp__gugu","mcp__omnisearch"]')
    expect(pin).toBeGreaterThan(argv.indexOf('resume'))
    expect(argv[pin - 1]).toBe('-c')
    expect(pin).toBeLessThan(argv.indexOf('tid-1'))
    session.detach()
  })

  it('接回之后投一轮:经 codex 队列起轮,开始与结束都收得到', async () => {
    const { session, lifecycle } = await adopted()
    const ref = await session.deliver('ping 2')
    const turnId = ref.queued ? await ref.dispatched! : ref.turnId
    await session.waitForTurnCompletion(turnId)
    expect(turnId).toBe('turn-1')
    expect(lifecycle).toEqual(['start', 'stop'])
    session.detach()
  })

  it('宿主关停(disposeAll)与信号路径(同步收组)都 ❌ 杀 tmux 里那台 —— 只断开连接', async () => {
    const { session, fake, terminate } = await adopted()
    killAllCodexAppServerProcessGroupsSync()
    expect(session.isLive()).toBe(true)
    await disposeAllCodexAppServerSessions()
    await fake.closed
    expect(terminate).not.toHaveBeenCalled()
    expect(session.isTmuxHosted()).toBe(false)
  })

  it('会话真结束(dispose)→ 整组收掉、关 tmux 会话', async () => {
    const { session, terminate } = await adopted()
    await session.dispose()
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('进程已死(pid 探不到)→ 不算 live,重开时不会把死地址交给 TUI', async () => {
    const { session, backend } = await adopted()
    vi.spyOn(backend, 'isAlive').mockReturnValue(false)
    expect(session.isLive()).toBe(false)
    session.detach()
  })
})

// ── droid:本机没有 droid,只能钉住「接回」这一段的判据 ─────────────────────────────────────
describe.skipIf(process.platform === 'win32')('#6264 droid:新宿主连回 tmux 里的 daemon', () => {
  it('同一个端口连回、只做认证不重做 initialize_session;宿主关停只断开不收', async () => {
    const { DroidDaemonSessionDelivery, setDroidTmuxBackendDepsForTest } = await import(
      '../../../../apps/desktop/electron/sessionpage/droid-daemon-session-delivery'
    )
    const methods: string[] = []
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    const port = (wss.address() as { port: number }).port
    wss.on('connection', (ws) => ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string }
      methods.push(msg.method)
      ws.send(JSON.stringify({ id: msg.id, result: {} }))
    }))
    const alive = new Set([5150])
    const deps = fakeDeps({
      alive,
      tmux: async (args) => {
        deps.calls.push(args)
        return args[0] === 'list-sessions'
          ? [`gugubk-dr`, 5150, 'droid-daemon', `ws://127.0.0.1:${port}`, ''].join(SEP)
          : ''
      },
    })
    setDroidTmuxBackendDepsForTest(deps)
    try {
      const delivery = new DroidDaemonSessionDelivery()
      const env = await delivery.startSession({
        agentUserId: 'a', sessionId: 'c', providerId: 'droid', providerSessionId: 's', cwd: '/w', tmuxSessionName: 'gugu-dr',
      })
      expect(env.FACTORY_DAEMON_PORT).toBe(String(port))
      expect(methods).not.toContain('daemon.initialize_session')
      await delivery.dispose()
      expect(deps.signals).toEqual([])
      expect(alive.has(5150)).toBe(true)
    } finally {
      setDroidTmuxBackendDepsForTest(undefined)
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })
})
