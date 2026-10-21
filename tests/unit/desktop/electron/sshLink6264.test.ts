/**
 * #6264 远程 SSH 的机器:这台桌面与它之间的一切只走 SSH(product spec「两个服务，各走各的通道」)。
 * 设备连接的三段:那台机器上的 `gugu-server link`(搬字节)、账号进程里的处理(与云端设备 RPC 同一张表)、
 * 桌面主进程里每台机器一个常驻 ssh 子进程(ssh-link.ts)。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  encodeFrame,
  encodeJsonFrame,
  FRAME,
  FrameDecoder,
  LINK_PROTOCOL_MARK,
  LINK_PROTOCOL_MISMATCH_MARK,
  LINK_READY_MARK,
  parseLinkHello,
} from '../../../../apps/desktop/electron/session/main/core/pty/attach/attach-protocol'
import { linkRefusal, parseLinkArgs, readLinkAck, runLink, watchDir } from '../../../../apps/desktop/electron/server/link-cli'
import { asBroadcast, createDeviceLinkHost } from '../../../../apps/desktop/electron/server/device-link-host'
import {
  afterReadyMark,
  classifyLinkExit,
  createSshLinkManager,
  linkProtocolFromPreamble,
  sshLinkArgs,
} from '../../../../apps/desktop/electron/server/ssh-link'
import { classifySignInExit } from '../../../../apps/desktop/electron/server/ssh-link-ipc'
import { writeServerConnectVia, type ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'
import { readServerConnectVia, serverDeviceLabel } from '../../../../packages/core/src/cloud/serverConnectVia'
import { REMOTE_PROTOCOL_VERSION } from '../../../../packages/core/src/cloud/serverMachineHealth'

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

const ACCOUNT = '11111111-2222-3333-4444-555555555555'

function account(dataDir: string): ServerAccount {
  return {
    userId: ACCOUNT,
    email: 'a@example.com',
    addedAt: null,
    dir: dataDir,
    dataDir,
    homeDir: dataDir,
    signedIn: true,
    signedOut: null,
  }
}

describe('那台机器上:gugu-server link', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-cli-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('参数:--account 与 --adopt-ssh;别的一律用法错', () => {
    expect(parseLinkArgs(['--account', ACCOUNT, '--adopt-ssh'])).toEqual({ account: ACCOUNT, adoptSsh: true })
    expect(parseLinkArgs([])).toEqual({ account: null, adoptSsh: false })
    expect(parseLinkArgs(['--bogus'])).toHaveProperty('error')
    expect(parseLinkArgs(['--account', 'has space'])).toHaveProperty('error')
  })

  it('账号进程的第一帧:空 L = 接上了(后面粘着的字节原样留给桌面);E = 拒绝(老进程)', () => {
    const tail = encodeJsonFrame(FRAME.message, { x: 1 })
    const ack = readLinkAck(Buffer.concat([encodeFrame(FRAME.link), tail]))
    expect(ack).toMatchObject({ ok: true })
    expect((ack as { rest: Buffer }).rest.equals(tail)).toBe(true)
    expect(readLinkAck(Buffer.from([FRAME.link, 0, 0]))).toBeNull()
    expect(readLinkAck(encodeJsonFrame(FRAME.error, { code: 'bad_request', message: 'old' }))).toEqual({
      ok: false,
      error: { code: 'bad_request', message: 'old' },
    })
  })

  it('接上之后:先打一行标记,再把两个方向的字节原样搬过去;--adopt-ssh 把老账号补记成远程 SSH', async () => {
    const socket = new PassThrough() as unknown as net.Socket & PassThrough
    const toServer: Buffer[] = []
    ;(socket as unknown as { write: (chunk: Buffer) => boolean }).write = (chunk: Buffer) => {
      toServer.push(chunk)
      return true
    }
    ;(socket as unknown as { destroy: () => void }).destroy = () => undefined
    ;(socket as unknown as { end: () => void }).end = () => undefined
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const out: Buffer[] = []
    stdout.on('data', (chunk: Buffer) => out.push(chunk))
    const adopted: string[] = []
    const done = runLink(['--account', ACCOUNT, '--adopt-ssh'], { stdin, stdout, stderr: new PassThrough() }, {
      accounts: () => [account(dir)],
      adopt: (a) => adopted.push(a.userId),
      connect: () => socket,
    })
    socket.emit('connect')
    await flush()
    expect(adopted).toEqual([ACCOUNT])
    // 第一帧是 L 打招呼。
    expect(new FrameDecoder().push(Buffer.concat(toServer))[0]).toMatchObject({ type: FRAME.link })
    const pushed = encodeJsonFrame(FRAME.message, { hello: 'desktop' })
    socket.emit('data', Buffer.concat([encodeFrame(FRAME.link), pushed]))
    await flush()
    const text = Buffer.concat(out)
    const after = afterReadyMark(text)
    expect(after?.equals(pushed)).toBe(true)
    // 标记之前报这份 server 说的桌面↔server 协议(明确的版本信号,桌面据此判太旧)。
    expect(linkProtocolFromPreamble(text.subarray(0, text.length - pushed.length))).toBeGreaterThanOrEqual(1)
    toServer.length = 0
    const request = encodeJsonFrame(FRAME.message, { ask: 1 })
    stdin.write(request)
    await flush()
    expect(Buffer.concat(toServer).equals(request)).toBe(true)
    socket.emit('close')
    expect(await done).toBe(0)
  })

  it('账号进程说协议对不上 → 退出码 6 + 标记行(带双方协议号);别的拒绝 → 4,原文照打、❌ 冒充太旧', async () => {
    expect(parseLinkHello(Buffer.from(JSON.stringify({ v: 99 })))).toMatchObject({
      code: 'protocol_mismatch',
      protocol: { server: 1, client: 99 },
    })
    expect(parseLinkHello(Buffer.from('not json'))).toMatchObject({ code: 'bad_request' })
    expect(parseLinkHello(Buffer.from('{}'))).toMatchObject({ code: 'bad_request' })

    const mismatch = linkRefusal({ code: 'protocol_mismatch', message: 'mismatch', protocol: { server: 1, client: 2 } })
    expect(mismatch.code).toBe(6)
    expect(mismatch.stderr).toContain(`${LINK_PROTOCOL_MISMATCH_MARK} server=1 client=2`)
    // 不带协议号的 protocol_mismatch 说不清两边是几:不算版本信号。
    expect(linkRefusal({ code: 'protocol_mismatch', message: 'm' }).code).toBe(4)
    for (const error of [
      { code: 'bad_request' as const, message: 'this process does not accept device links' },
      { code: 'unavailable' as const, message: 'boom' },
      null,
    ]) {
      const refusal = linkRefusal(error)
      expect(refusal.code).toBe(4)
      expect(refusal.stderr).not.toContain(LINK_PROTOCOL_MISMATCH_MARK)
    }

    const socket = new PassThrough() as unknown as net.Socket
    ;(socket as unknown as { destroy: () => void }).destroy = () => undefined
    const stderr = new PassThrough()
    const err: Buffer[] = []
    stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr }
    const run = runLink(['--account', ACCOUNT], io, { accounts: () => [account(dir)], connect: () => socket })
    socket.emit(
      'data',
      encodeJsonFrame(FRAME.error, { code: 'protocol_mismatch', message: 'm', protocol: { server: 1, client: 2 } }),
    )
    expect(await run).toBe(6)
    expect(Buffer.concat(err).toString()).toContain(LINK_PROTOCOL_MISMATCH_MARK)
  })

  it('老账号进程拒绝设备连接 → 退出码 4;没登这个账号 → 5;没在跑 → 3', async () => {
    const refused = new PassThrough() as unknown as net.Socket
    ;(refused as unknown as { destroy: () => void }).destroy = () => undefined
    const stdout = new PassThrough()
    const io = { stdin: new PassThrough(), stdout, stderr: new PassThrough() }
    const r1 = runLink(['--account', ACCOUNT], io, { accounts: () => [account(dir)], connect: () => refused })
    refused.emit('data', encodeJsonFrame(FRAME.error, { code: 'bad_request', message: 'no links here' }))
    expect(await r1).toBe(4)

    expect(await runLink(['--account', ACCOUNT], io, { accounts: () => [] })).toBe(5)

    const dead = new PassThrough() as unknown as net.Socket
    ;(dead as unknown as { destroy: () => void }).destroy = () => undefined
    const r3 = runLink(['--account', ACCOUNT], io, { accounts: () => [account(dir)], connect: () => dead })
    dead.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }))
    expect(await r3).toBe(3)
  })

  // 账号进程正在重起(换版 / 崩了被守护进程拉起):❌ 当场退 3 让桌面按退避重开,等它的套接字出现当场接上。
  it('账号进程没在听 → 等套接字所在目录变化再连,接上照常;变化落在一次连接途中也不漏', async () => {
    const sockets: net.Socket[] = []
    const fake = () => {
      const socket = new PassThrough() as unknown as net.Socket
      ;(socket as unknown as { destroy: () => void }).destroy = () => undefined
      sockets.push(socket)
      return socket
    }
    let onChange: (() => void) | null = null
    let watchStopped = false
    const stdout = new PassThrough()
    const out: Buffer[] = []
    stdout.on('data', (chunk: Buffer) => out.push(chunk))
    const run = runLink(['--account', ACCOUNT], { stdin: new PassThrough(), stdout, stderr: new PassThrough() }, {
      accounts: () => [account(dir)],
      connect: fake,
      watch: (_dir, cb) => {
        onChange = cb
        return () => {
          watchStopped = true
        }
      },
    })
    sockets[0]!.emit('error', Object.assign(new Error('gone'), { code: 'ECONNREFUSED' }))
    // 挂上监听后马上再试一次(监听之前它可能刚好起来了)。
    expect(onChange).not.toBeNull()
    expect(sockets).toHaveLength(2)
    // 这一次还在路上时目录又变了(旧套接字删掉、新的建好):这一次失败后要再试,❌ 等下一次变化。
    onChange!()
    sockets[1]!.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' }))
    expect(sockets).toHaveLength(3)
    sockets[2]!.emit('connect')
    sockets[2]!.emit('data', encodeFrame(FRAME.link))
    await flush()
    expect(afterReadyMark(Buffer.concat(out))).not.toBeNull()
    expect(watchStopped).toBe(true)
    sockets[2]!.emit('close')
    expect(await run).toBe(0)
  })

  // 复核 146:目录监听出错 ❌ 让进程崩成退出码 1(桌面归成「连不上」);当成一次变化,再连一次。
  it('目录监听出错 → 当成一次变化去再连,❌ 抛出', () => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
    const watch = vi.spyOn(fs, 'watch').mockReturnValue(watcher as unknown as fs.FSWatcher)
    const changes: string[] = []
    const stop = watchDir(dir, () => changes.push('change'))
    // 没挂 'error' 的 EventEmitter emit('error') 会直接抛:这一条就是在钉「挂上了」。
    expect(() => watcher.emit('error', new Error('EPERM'))).not.toThrow()
    expect(changes).toEqual(['change'])
    stop()
    expect(watcher.close).toHaveBeenCalled()
    watch.mockRestore()
  })

  it('等满了账号进程还是没起来 → 退出码 3(没在跑),说清等了多久', async () => {
    const dead = new PassThrough() as unknown as net.Socket
    ;(dead as unknown as { destroy: () => void }).destroy = () => undefined
    const stderr = new PassThrough()
    const err: Buffer[] = []
    stderr.on('data', (chunk: Buffer) => err.push(chunk))
    const run = runLink(['--account', ACCOUNT], { stdin: new PassThrough(), stdout: new PassThrough(), stderr }, {
      accounts: () => [account(dir)],
      connect: () => dead,
      watch: () => () => undefined,
      waitMs: 20,
    })
    dead.emit('error', Object.assign(new Error('gone'), { code: 'ENOENT' }))
    expect(await run).toBe(3)
    expect(Buffer.concat(err).toString()).toContain('等了')
  })

  it('怎么登上的记在账号目录里:登录时写;补记只在没记过时写(已记成远程隧道的不改)', () => {
    expect(readServerConnectVia(dir)).toBeNull()
    expect(writeServerConnectVia(dir, 'ssh', { onlyIfUnknown: true })).toBe(true)
    expect(readServerConnectVia(dir)?.via).toBe('ssh')
    writeServerConnectVia(dir, 'tunnel')
    expect(writeServerConnectVia(dir, 'ssh', { onlyIfUnknown: true })).toBe(false)
    expect(readServerConnectVia(dir)?.via).toBe('tunnel')
    writeServerConnectVia(dir, 'ssh')
    expect(readServerConnectVia(dir)?.via).toBe('ssh')
  })

  it('经 SSH 登上时记下人填的名字,账号进程随心跳报它;没有名字报空(库里取 Linux N)', () => {
    const env = { GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: dir }
    expect(serverDeviceLabel(env)).toBe('')
    writeServerConnectVia(dir, 'ssh', { name: 'd22' })
    expect(readServerConnectVia(dir)).toMatchObject({ via: 'ssh', name: 'd22' })
    expect(serverDeviceLabel(env)).toBe('d22')
    writeServerConnectVia(dir, 'tunnel', { name: null })
    expect(serverDeviceLabel(env)).toBe('')
  })
})

describe('账号进程里:设备连接用与咕咕云同一张处理表', () => {
  it('请求上的 user_id 换成这个账号自己;应答与推送都包成 Realtime 广播的外壳;断开时处理器收掉', async () => {
    const seen: Array<{ payload: unknown; userId: string }> = []
    const dispose = vi.fn()
    const factory = createDeviceLinkHost({
      userId: () => ACCOUNT,
      createHandlers: () => ({
        handlers: {
          'demo.echo': (payload, ctx) => {
            seen.push({ payload, userId: ctx.request.user_id })
            void ctx.publishEvent({ type: 'demo.event', n: 1 })
            return { result: { echoed: payload } }
          },
        },
        dispose,
      }),
    })
    const sent: unknown[] = []
    const session = factory((message) => sent.push(message))
    session.handle(asBroadcast({ type: 'demo.echo', request_id: 'r1', user_id: 'someone-else', payload: { type: 'inner', a: 1 } }))
    await flush()
    // 请求自己的 payload 里带 type 也不会被当成信封读(外壳就是为此)。
    expect(seen).toEqual([{ payload: { type: 'inner', a: 1 }, userId: ACCOUNT }])
    expect(sent).toEqual([
      asBroadcast({ type: 'demo.event', n: 1 }),
      asBroadcast({ type: 'demo.echo:reply', request_id: 'r1', result: { echoed: { type: 'inner', a: 1 } }, error: undefined }),
    ])
    session.dispose()
    session.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('还没登录的账号不接', () => {
    const factory = createDeviceLinkHost({ userId: () => null, createHandlers: () => ({ handlers: {}, dispose: () => undefined }) })
    expect(() => factory(() => undefined)).toThrow()
  })
})

/** 一个 ssh 子进程的替身:标准输入输出是内存流,能让它「退出」。 */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    kill: (signal?: string) => void
    killed: string[]
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = []
  child.kill = (signal = 'SIGTERM') => {
    child.killed.push(signal)
    setImmediate(() => child.emit('close', null))
  }
  return child
}

describe('桌面主进程:每台机器一条设备连接', () => {
  const target = { destination: 'alice@box', port: 2222, display: 'alice@box:2222', options: ['-i', '/k/id'] }

  it('ssh 参数:不弹问(BatchMode)、骑在共享连接上、带上添加时的选项,那头只跑 link 并补记远程 SSH', () => {
    const args = sshLinkArgs(target, { controlPath: '/tmp/cm-%C', accountUserId: ACCOUNT })
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ControlPath=/tmp/cm-%C')
    expect(args).toEqual(expect.arrayContaining(['-p', '2222', '-i', '/k/id']))
    expect(args.at(-1)).toBe(`exec ~/.local/bin/gugu-server link --account ${ACCOUNT} --adopt-ssh`)
    expect(() => sshLinkArgs(target, { controlPath: null, accountUserId: 'bad id' })).toThrow()
  })

  it('还没接上就结束:按退出码与报错说清原因(要登录 / 指纹变了 / 太旧 / 没在跑 / 没登 / 没装 / 连不上)', () => {
    expect(classifyLinkExit({ code: 255, stderr: 'alice@box: Permission denied (publickey,password).' }).reason).toBe('signInRequired')
    expect(classifyLinkExit({ code: 255, stderr: 'Host key verification failed.' }).reason).toBe('signInRequired')
    expect(classifyLinkExit({ code: 255, stderr: 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!' }).reason).toBe('hostKeyChanged')
    expect(classifyLinkExit({ code: 255, stderr: 'ssh: connect to host box port 22: Connection refused' }).reason).toBe('unreachable')
    // 版本信号:老版本不认 link;账号进程说协议对不上(退出码 6 + 标记行,缺一不算)。
    expect(classifyLinkExit({ code: 2, stderr: '不认识的命令:link' }).reason).toBe('outdated')
    expect(classifyLinkExit({ code: 6, stderr: `${LINK_PROTOCOL_MISMATCH_MARK} server=1 client=2\nm` }).reason).toBe('outdated')
    // 其它一律照实报,❌ 归成太旧(owner 2026-09-25:「升级只能是因为版本问题,而不是因为连不上」)。
    expect(classifyLinkExit({ code: 6, stderr: 'something else exited 6' }).reason).toBe('unreachable')
    expect(classifyLinkExit({ code: 2, stderr: '用法:gugu-server link [--account <账号 id>] [--adopt-ssh]' }).reason).toBe('unreachable')
    expect(classifyLinkExit({ code: 4, stderr: 'bad_request: this process does not accept device links' }).reason).toBe('refused')
    expect(classifyLinkExit({ code: 4, stderr: '' }).reason).toBe('refused')
    expect(classifyLinkExit({ code: 1, stderr: 'Segmentation fault' }).reason).toBe('unreachable')
    expect(classifyLinkExit({ code: null, stderr: '' }).reason).toBe('unreachable')
    expect(classifyLinkExit({ code: 3, stderr: '' }).reason).toBe('notRunning')
    expect(classifyLinkExit({ code: 5, stderr: '' }).reason).toBe('notSignedIn')
    expect(classifyLinkExit({ code: 127, stderr: 'gugu-server: not found' }).reason).toBe('notInstalled')
    expect(classifySignInExit(0, '')).toEqual({ ok: true })
    expect(classifySignInExit(255, 'Permission denied')).toEqual({ ok: false, reason: 'signInRequired' })
    expect(classifySignInExit(255, 'Network is unreachable')).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('标记之前是 rc 打的字:丢掉;之后的帧交给渲染层;写出去的是帧;同一台只开一条', async () => {
    const children: ReturnType<typeof fakeChild>[] = []
    const messages: unknown[] = []
    const machineFor = vi.fn(async () => ({ target, accountUserId: ACCOUNT }))
    const links = createSshLinkManager({
      machineFor,
      controlPath: () => '/tmp/cm-%C',
      onMessage: (_id, message) => messages.push(message),
      onClosed: vi.fn(),
      spawnSsh: () => {
        const child = fakeChild()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    const opening = links.open('dev1')
    const again = links.open('dev1')
    await flush()
    expect(children).toHaveLength(1)
    const reply = encodeJsonFrame(FRAME.message, asBroadcast({ type: 'x:reply', request_id: 'r1', result: 1 }))
    children[0]!.stdout.write(Buffer.concat([Buffer.from(`conda activated\nwelcome`), Buffer.from(`\n${LINK_READY_MARK}\n`), reply]))
    expect(await opening).toEqual({ ok: true })
    expect(await again).toEqual({ ok: true })
    await flush()
    expect(messages).toEqual([asBroadcast({ type: 'x:reply', request_id: 'r1', result: 1 })])
    const written: Buffer[] = []
    children[0]!.stdin.on('data', (chunk: Buffer) => written.push(chunk))
    expect(links.send('dev1', { ask: 1 })).toBe(true)
    await flush()
    expect(new FrameDecoder().push(Buffer.concat(written))).toEqual([
      { type: FRAME.message, payload: Buffer.from(JSON.stringify({ ask: 1 })) },
    ])
    expect(links.send('other', { ask: 1 })).toBe(false)
  })

  it('接上之后断了 → 报「断了」;主动收掉 ❌ 报;没接上就结束 → 回原因、不留记录', async () => {
    const children: ReturnType<typeof fakeChild>[] = []
    const onClosed = vi.fn()
    const links = createSshLinkManager({
      machineFor: async (id) => (id === 'unmapped' ? null : { target, accountUserId: ACCOUNT }),
      controlPath: () => null,
      onMessage: () => undefined,
      onClosed,
      spawnSsh: () => {
        const child = fakeChild()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    expect(await links.open('unmapped')).toMatchObject({ ok: false, reason: 'unmapped' })

    const a = links.open('a')
    await flush()
    children[0]!.stdout.write(`${LINK_READY_MARK}\n`)
    await a
    children[0]!.stderr.write('Connection to box closed by remote host.')
    children[0]!.emit('close', 255)
    await flush()
    expect(onClosed).toHaveBeenCalledWith('a', expect.objectContaining({ reason: 'unreachable' }))
    expect(links.isOpen('a')).toBe(false)

    const b = links.open('b')
    await flush()
    children[1]!.stdout.write(`${LINK_READY_MARK}\n`)
    await b
    links.close('b')
    await flush()
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(children[1]!.killed).toEqual(['SIGTERM'])

    const c = links.open('c')
    await flush()
    children[2]!.stderr.write('alice@box: Permission denied (publickey).')
    children[2]!.emit('close', 255)
    expect(await c).toMatchObject({ ok: false, reason: 'signInRequired' })
    expect(links.openDeviceIds()).toEqual([])
  })

  it('接上前报的协议号低于这台桌面要求的 → 太旧(明确的版本信号);报得够 / 老版本不报 → 照常接上', async () => {
    const children: ReturnType<typeof fakeChild>[] = []
    const links = createSshLinkManager({
      machineFor: async () => ({ target, accountUserId: ACCOUNT }),
      controlPath: () => null,
      onMessage: () => undefined,
      onClosed: () => undefined,
      spawnSsh: () => {
        const child = fakeChild()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    const old = links.open('old')
    await flush()
    children[0]!.stdout.write(`rc banner\n${LINK_PROTOCOL_MARK} 0\n${LINK_READY_MARK}\n`)
    expect(await old).toMatchObject({ ok: false, reason: 'outdated' })
    expect(children[0]!.killed).toEqual(['SIGTERM'])

    const fine = links.open('fine')
    await flush()
    children[1]!.stdout.write(`${LINK_PROTOCOL_MARK} ${REMOTE_PROTOCOL_VERSION}\n${LINK_READY_MARK}\n`)
    expect(await fine).toEqual({ ok: true })

    const legacy = links.open('legacy')
    await flush()
    children[2]!.stdout.write(`${LINK_READY_MARK}\n`)
    expect(await legacy).toEqual({ ok: true })

    expect(linkProtocolFromPreamble(Buffer.from(`${LINK_PROTOCOL_MARK} garbage\n`))).toBeNull()
  })

  it('一直等不到「接上了」:超时收掉', async () => {
    const children: ReturnType<typeof fakeChild>[] = []
    const links = createSshLinkManager({
      machineFor: async () => ({ target, accountUserId: ACCOUNT }),
      controlPath: () => null,
      onMessage: () => undefined,
      onClosed: () => undefined,
      openTimeoutMs: 20,
      spawnSsh: () => {
        const child = fakeChild()
        children.push(child)
        return child as unknown as ChildProcessWithoutNullStreams
      },
    })
    expect(await links.open('slow')).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(children[0]!.killed).toEqual(['SIGTERM'])
  })
})

