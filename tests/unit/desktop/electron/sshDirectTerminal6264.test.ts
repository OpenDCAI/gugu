// #6264 behavior「别的机器上的编程只给用 SSH 装上的机器」:桌面这一侧(ssh 命令、断开时的人话、本机映射、
// 直连连法),以及那台机器上几个 CLI 找账号进程的公用部分。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildEnsureMasterArgs,
  buildForwardSshArgs,
  buildMuxControlArgs,
  buildMuxForwardArgs,
  classifyAttachExit,
} from '../../../../apps/desktop/electron/server/ssh-install/logic'
import {
  closeSshMasters,
  configureSshControlScope,
  createDirectTerminalResolver,
  createSshMachineStore,
  sshControlDir,
  findSshMachine,
  parseSshMachines,
  upsertSshMachine,
  type SshMachine,
} from '../../../../apps/desktop/electron/server/ssh-machines'
import { describeConnectError, pickAttachAccount } from '../../../../apps/desktop/electron/server/account-call'
import type { ServerAccount } from '../../../../apps/desktop/electron/server/server-layout'

const UID = '0f8b7c1e-6a3d-4c2b-9e1f-2a3b4c5d6e7f'
const CONV = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

describe('classifyAttachExit(断开 / 连不上:因为什么、会不会自己好)', () => {
  const c = (exitCode: number | null, tail = '') => classifyAttachExit({ exitCode, signal: null, tail })

  it('SSH 自己的错:认证 / 指纹不会自己好;网断、超时、解析不了、被拒(在重启)会', () => {
    expect(c(255, 'alice@box: Permission denied (publickey).')).toEqual({ reason: 'auth', retryable: false })
    expect(c(255, 'Host key verification failed.')).toEqual({ reason: 'host-key-rejected', retryable: false })
    expect(c(255, 'ssh: connect to host box port 22: Connection refused')).toEqual({ reason: 'refused', retryable: true })
    expect(c(255, 'ssh: Could not resolve hostname box: nodename nor servname provided')).toEqual({ reason: 'host-unresolved', retryable: true })
    expect(c(255, 'ssh: connect to host box port 22: Operation timed out')).toEqual({ reason: 'timeout', retryable: true })
    expect(c(255, 'client_loop: send disconnect: Broken pipe')).toEqual({ reason: 'network', retryable: true })
  })

  it('指纹变了:是拒绝不是提问 —— 不会自己好,带上 known_hosts 里的写法与新指纹(界面给删旧记录的命令)', () => {
    const tail = [
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      'The fingerprint for the ED25519 key sent by the remote host is',
      'SHA256:NewNewNew.',
      'Host key for [127.0.0.1]:2222 has changed and you have requested strict checking.',
      'Host key verification failed.',
    ].join('\r\n')
    expect(classifyAttachExit({ exitCode: 255, signal: null, tail }, '[box]:2222')).toEqual({
      reason: 'host-key-changed',
      retryable: false,
      hostKeyChanged: { host: '[127.0.0.1]:2222', fingerprint: 'SHA256:NewNewNew' },
    })
    // 报错里认不出主机时用调用方给的 known_hosts 写法
    expect(classifyAttachExit({ exitCode: 255, signal: null, tail: 'REMOTE HOST IDENTIFICATION HAS CHANGED' }, '[box]:2222'))
      .toMatchObject({ hostKeyChanged: { host: '[box]:2222', fingerprint: null } })
  })

  it('转发正常断开会自己好;别的退出码不认识就照实说不知道', () => {
    expect(c(0)).toEqual({ reason: 'ended', retryable: true })
    expect(c(1)).toEqual({ reason: 'unknown', retryable: true })
  })
})

describe('这台桌面上用 SSH 装上的机器(本机映射)', () => {
  const machine = (over: Partial<SshMachine> = {}): SshMachine => ({
    deviceId: 'dev-1', ownerUserId: UID, destination: 'alice@box', display: 'alice@box', addedAt: '2026-09-23T00:00:00Z', ...over,
  })

  it('同一台设备再装一次覆盖旧的;换了号的那条不算数', () => {
    const list = upsertSshMachine([machine(), machine({ deviceId: 'dev-2' })], machine({ destination: 'alice@box2', port: 2200 }))
    expect(list.map((m) => [m.deviceId, m.destination])).toEqual([['dev-2', 'alice@box'], ['dev-1', 'alice@box2']])
    expect(findSshMachine(list, 'dev-1', UID)?.port).toBe(2200)
    expect(findSshMachine(list, 'dev-1', 'someone-else')).toBeNull()
  })

  it('读盘:坏文件、坏条目(以 - 开头的目的地)一律丢掉', () => {
    expect(parseSshMachines('not json')).toEqual([])
    expect(parseSshMachines(JSON.stringify({ machines: [machine(), machine({ destination: '-oProxyCommand=x' }), { deviceId: 1 }] }))).toEqual([machine()])
  })

  it('落盘 0600、只存目的地不存凭据;变了通知渲染层', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-machines-'))
    try {
      const file = path.join(dir, 'ssh-machines.json')
      const store = createSshMachineStore(file)
      const changed = vi.fn()
      store.onChange(changed)
      store.remember(machine())
      expect(changed).toHaveBeenCalledTimes(1)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).machines[0]).sort()).toEqual(['addedAt', 'destination', 'deviceId', 'display', 'ownerUserId'])
      expect(createSshMachineStore(file).list()).toEqual([machine()])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('直连连法:只给当前登着的人、只给记过的设备;给出的是 ssh 命令与人话翻译', async () => {
    const store = { list: () => [machine({ port: 2222, display: 'alice@box:2222' })], remember: vi.fn(), onChange: () => () => {} }
    const askpass = { env: {}, onPrompt() {}, onSettled() {}, answer: () => false, newRound() {}, cancelAll() {}, close: async () => {} }
    const resolver = createDirectTerminalResolver({ store, currentUserId: async () => UID, controlPath: () => null, askpass: async () => askpass })
    const FWD = { kind: 'forward' as const, localPort: 4000, remotePort: 3000 }
    const spec = await resolver({ deviceId: 'dev-1', sessionId: CONV, purpose: FWD })
    expect(spec?.command).toBe('ssh')
    expect(spec?.args).toContain('alice@box')
    expect(spec?.label).toBe('alice@box:2222')
    expect(spec?.classifyExit({ exitCode: 0, signal: null, tail: '' })).toEqual({ reason: 'ended', retryable: true })
    // ssh 的提问走咕咕的 askpass(与添加机器同一套);指纹变了时认得出是哪台(非 22 端口写成 [主机]:端口)
    expect(spec?.askpass).toBe(askpass)
    expect(spec?.classifyExit({ exitCode: 255, signal: null, tail: 'REMOTE HOST IDENTIFICATION HAS CHANGED' }))
      .toMatchObject({ reason: 'host-key-changed', hostKeyChanged: { host: '[box]:2222' } })
    expect(await resolver({ deviceId: 'dev-other', sessionId: CONV, purpose: FWD })).toBeNull()
    // askpass 开不出来:照样给终端(ssh 退回在终端里自己问),并报一声
    const errors: unknown[] = []
    const noAskpass = createDirectTerminalResolver({
      store, currentUserId: async () => UID, controlPath: () => null,
      askpass: async () => { throw new Error('mkdtemp failed') }, onAskpassError: (e) => errors.push(e),
    })
    const bare = await noAskpass({ deviceId: 'dev-1', sessionId: CONV, purpose: FWD })
    expect(bare?.command).toBe('ssh')
    expect(bare?.askpass).toBeUndefined()
    expect(errors).toHaveLength(1)
    const signedOut = createDirectTerminalResolver({ store, currentUserId: async () => null, controlPath: () => null })
    expect(await signedOut({ deviceId: 'dev-1', sessionId: CONV, purpose: FWD })).toBeNull()
  })
})

// #6264 会话右侧工作区的「浏览器」打开那台机器的 localhost:端口转发走这条直连(只给用 SSH 装上的机器)。
describe('直连只剩端口转发(终端与会话走那台机器的设备连接)', () => {
  const target = { destination: 'alice@box', port: 2222, display: 'alice@box:2222', options: ['-i', '/k/id'] }

  it('转发:只监听本机回环、独立连接(进程没了转发就没了)、转不成就退出', () => {
    const args = buildForwardSshArgs(target, { localPort: 3001, remotePort: 3000 })
    expect(args).toEqual(expect.arrayContaining(['-N', '-T', 'ExitOnForwardFailure=yes', 'ControlPath=none']))
    expect(args.slice(-4)).toEqual(['-L', '127.0.0.1:3001:localhost:3000', '--', 'alice@box'])
    expect(() => buildForwardSshArgs(target, { localPort: 0, remotePort: 3000 })).toThrow()
    expect(() => buildForwardSshArgs(target, { localPort: 3000, remotePort: 70000 })).toThrow()
  })

  it('连法只给转发:没说用途(旧的「接会话终端」「开 shell」)一律没有', async () => {
    const machine = (over: Partial<SshMachine> = {}): SshMachine => ({
      deviceId: 'dev-1', ownerUserId: UID, destination: 'alice@box', display: 'alice@box', addedAt: '2026-09-23T00:00:00Z', ...over,
    })
    const store = { list: () => [machine({ port: 2222, display: 'alice@box:2222' })], remember: vi.fn(), onChange: () => () => {} }
    const resolver = createDirectTerminalResolver({ store, currentUserId: async () => UID, controlPath: () => '/tmp/cm-%C' })
    const forward = await resolver({ deviceId: 'dev-1', sessionId: CONV, purpose: { kind: 'forward', localPort: 4000, remotePort: 3000 } })
    expect(forward?.args).toContain('127.0.0.1:4000:localhost:3000')
    expect(await resolver({ deviceId: 'dev-1', sessionId: CONV })).toBeNull()
    // 远程隧道的机器(没记过直连):没有。
    expect(await resolver({ deviceId: 'dev-tunnel', sessionId: CONV, purpose: { kind: 'forward', localPort: 4000, remotePort: 3000 } })).toBeNull()
  })

})

// #6264 一台机器一条认证过的连接(照 VS Code Remote-SSH):终端、文件、端口转发都骑在它上面,咕咕开着就一直在。
describe('共享连接', () => {
  const target = { destination: 'alice@box', port: 2222, display: 'alice@box:2222', options: ['-J', 'jump'] }

  it('确保连接在:ControlMaster=auto + 一直留着;转发 / 撤掉 = -O forward|cancel,选项与主机照带(%C 要对得上)', () => {
    const ensure = buildEnsureMasterArgs(target, '/tmp/d/cm-%C')
    expect(ensure).toEqual(expect.arrayContaining(['ControlMaster=auto', 'ControlPath=/tmp/d/cm-%C', 'ControlPersist=yes', '-p', '2222', '-J', 'jump']))
    expect(ensure.slice(-3)).toEqual(['--', 'alice@box', 'exit 0'])
    const forward = buildMuxForwardArgs(target, { controlPath: '/tmp/d/cm-%C', localPort: 4000, remotePort: 3000, op: 'forward' })
    expect(forward).toEqual(expect.arrayContaining(['-O', 'forward', '-L', '127.0.0.1:4000:localhost:3000', '-p', '2222', '-J', 'jump']))
    expect(forward.slice(-2)).toEqual(['--', 'alice@box'])
    expect(buildMuxForwardArgs(target, { controlPath: '/c', localPort: 4000, remotePort: 3000, op: 'cancel' })).toContain('cancel')
    expect(() => buildMuxForwardArgs(target, { controlPath: '/c', localPort: 0, remotePort: 3000, op: 'forward' })).toThrow()
    expect(buildMuxControlArgs(target, '/c', 'exit')).toEqual(expect.arrayContaining(['-O', 'exit', '-p', '2222', '-J', 'jump']))
  })

  it('端口转发:有复用连接就骑在上面(给 mux);没有(Windows)就单开一条', async () => {
    const machine: SshMachine = { deviceId: 'dev-1', ownerUserId: UID, destination: 'alice@box', display: 'alice@box', addedAt: '2026-09-23T00:00:00Z' }
    const store = { list: () => [machine], remember: vi.fn(), onChange: () => () => {} }
    const withMux = createDirectTerminalResolver({ store, currentUserId: async () => UID, controlPath: () => '/tmp/cm-%C' })
    const forward = await withMux({ deviceId: 'dev-1', sessionId: CONV, purpose: { kind: 'forward', localPort: 4000, remotePort: 3000 } })
    expect(forward?.mux?.ensureArgs).toContain('ControlPersist=yes')
    expect(forward?.mux?.forwardArgs).toContain('127.0.0.1:4000:localhost:3000')
    expect(forward?.mux?.cancelArgs).toContain('cancel')
    const attach = await withMux({ deviceId: 'dev-1', sessionId: CONV })
    expect(attach?.mux).toBeUndefined()
    const windows = createDirectTerminalResolver({ store, currentUserId: async () => UID, controlPath: () => null })
    expect((await windows({ deviceId: 'dev-1', sessionId: CONV, purpose: { kind: 'forward', localPort: 4000, remotePort: 3000 } }))?.mux).toBeUndefined()
  })

  it('套接字目录按数据目录分开(并行的几个咕咕各管各的);收的时候只收自己目录里的每一条', () => {
    configureSshControlScope('/Users/a/Library/Application Support/gugu-dev-1')
    const one = sshControlDir()
    configureSshControlScope('/Users/a/Library/Application Support/gugu-dev-2')
    const two = sshControlDir()
    configureSshControlScope('')
    expect(one).not.toBe(two)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cm-'))
    fs.writeFileSync(path.join(dir, 'cm-aaa'), '')
    fs.writeFileSync(path.join(dir, 'cm-bbb'), '')
    fs.writeFileSync(path.join(dir, 'other'), '')
    const calls: string[][] = []
    expect(closeSshMasters(dir, (args) => calls.push(args))).toBe(2)
    expect(calls.map((a) => a.find((x) => x.startsWith('ControlPath=')))).toEqual(
      expect.arrayContaining([`ControlPath=${path.join(dir, 'cm-aaa')}`, `ControlPath=${path.join(dir, 'cm-bbb')}`]),
    )
    expect(calls.every((a) => a.includes('-O') && a.includes('exit'))).toBe(true)
    expect(closeSshMasters(path.join(dir, 'missing'), () => undefined)).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('经本机套接字找账号进程(link / open-url / match-version 共用)', () => {
  const account = (over: Partial<ServerAccount> = {}): ServerAccount => ({
    userId: UID, email: 'a@b.c', addedAt: null, dir: '/x', dataDir: '/x/data', homeDir: '/x/home', signedIn: true, signedOut: null, ...over,
  })

  it('挑账号:写了就必须是登着的那个;没写且只登着一个就是他;好几个就要写', () => {
    const other = account({ userId: '11111111-2222-4333-8444-555555555555', email: 'o@p.q' })
    expect(pickAttachAccount([account(), other], UID)).toMatchObject({ userId: UID })
    expect(pickAttachAccount([account({ signedIn: false })], UID)).toHaveProperty('error')
    expect(pickAttachAccount([account()], null)).toMatchObject({ userId: UID })
    expect(pickAttachAccount([account(), other], null)).toHaveProperty('error')
    expect(pickAttachAccount([], null)).toHaveProperty('error')
  })

  it('进程没在跑(套接字不在):人话', () => {
    expect(describeConnectError(Object.assign(new Error('x'), { code: 'ENOENT' }), 'a@b.c')).toContain('未运行')
  })
})
