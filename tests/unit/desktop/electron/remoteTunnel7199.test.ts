// 远程隧道(owner 2026-10-15「这个功能应该先被启用」):中转坐标、frpc 配置与日志、内嵌 SSH 服务端(用系统 ssh 真连)、
// 桌面那一头的状态机、渲染层的判据。整体说明见 packages/core/src/cloud/remoteTunnel.ts。
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Server as SshServer, utils as sshUtils } from 'ssh2'
import {
  normalizeOpenSshPublicKey,
  noteTunnelActivity,
  parseRelayUrl,
  parseTunnelOpenRequest,
  parseTunnelOpenResponse,
  quietTunnelPort,
  resetTunnelActivityForTest,
  setTunnelRelayUp,
  tunnelActiveAt,
  tunnelRelayUp,
} from '../../../../packages/core/src/cloud/remoteTunnel'
import { resolveDeviceHostInfo } from '../../../../packages/core/src/cloud/deviceHostInfo'
import { classifyFrpcLine, frpcCandidates, frpcConfig, killStaleFrpc, startFrpc } from '../../../../apps/desktop/electron/server/frpc-runner'
import {
  createAuthorizedKeys,
  ensureHostKey,
  execEnv,
  listenTunnelSsh,
} from '../../../../apps/desktop/electron/server/tunnel-endpoint'
import {
  classifyOpenFailure,
  createTunnelMachines,
  quotedOptionPath,
  tunnelSshTarget,
  upsertKnownHost,
  tunnelHostAlias,
} from '../../../../apps/desktop/electron/server/tunnel-machines'
import { sshLinkArgs } from '../../../../apps/desktop/electron/server/ssh-link'
import { asBroadcast, createDeviceLinkHost } from '../../../../apps/desktop/electron/server/device-link-host'
import { sshBatchArgs } from '../../../../apps/desktop/electron/server/ssh-batch'
import { buildForwardSshArgs } from '../../../../apps/desktop/electron/server/ssh-install/logic'
import { tunnelFacts, wantsTunnel, type TunnelState } from '../../../../apps/desktop/src/lib/tunnelMachines'

const RELAY = { serverAddr: 'relay.example.com', serverPort: 30019, token: 'tok_EN-1' }

describe('中转坐标与 tunnel.open 的形状', () => {
  it('frp://令牌@主机:端口 才算数;看不懂的一律 null(❌ 猜一个默认中转)', () => {
    expect(parseRelayUrl('frp://tok_EN-1@relay.example.com:30019')).toEqual(RELAY)
    expect(parseRelayUrl(' frp://abc@203.0.113.10:30019/ ')).toEqual({ serverAddr: '203.0.113.10', serverPort: 30019, token: 'abc' })
    for (const bad of ['', 'http://a@b:1', 'frp://@h:1', 'frp://t@h', 'frp://t@h:0', 'frp://t@h:70000', 'frp://t"x@h:1', 'frp://t@-h:1']) {
      expect(parseRelayUrl(bad)).toBeNull()
    }
  })

  it('frp+wss://令牌@主机[:端口]:躲在 nginx 后面的那种,端口缺省 443;frp:// 不给端口仍是看不懂', () => {
    expect(parseRelayUrl('frp+wss://tok_EN-1@relay.example.test')).toEqual({ serverAddr: 'relay.example.test', serverPort: 443, token: 'tok_EN-1', protocol: 'wss' })
    expect(parseRelayUrl('frp+wss://t@h.example.com:8443/')).toEqual({ serverAddr: 'h.example.com', serverPort: 8443, token: 't', protocol: 'wss' })
    expect(parseRelayUrl('frp://t@h.example.com:30019')).not.toHaveProperty('protocol')
    for (const bad of ['frp+ws://t@h', 'frp+wss://@h', 'frp+wss://t@h:0', 'frp+tls://t@h:1', 'wss://t@h:443']) expect(parseRelayUrl(bad)).toBeNull()
    const answer = {
      relay: { serverAddr: 'relay.example.test', serverPort: 443, token: 't', protocol: 'wss', user: 'u-1', serverName: 'ssh-dev-ab12', secretKey: 'Zm9vYmFyYmF6cXV4cXV1eA' }, // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
      hostKey: 'ssh-ed25519 AAAAC3Nza',
      sshUser: 'gugu',
    }
    // 桌面跟着应答走:wss 原样留下;看不懂的连法整份不收(❌ 当成 TCP 去连 443)。
    expect(parseTunnelOpenResponse(answer)?.relay.protocol).toBe('wss')
    expect(parseTunnelOpenResponse({ ...answer, relay: { ...answer.relay, protocol: 'quic' } })).toBeNull()
  })

  it('公钥只收 `类型 base64`,注释去掉;别的形状 = null', () => {
    expect(normalizeOpenSshPublicKey('ssh-ed25519 AAAAC3Nza  me@mac\n')).toBe('ssh-ed25519 AAAAC3Nza')
    expect(normalizeOpenSshPublicKey('ssh-dss AAAA')).toBeNull()
    expect(normalizeOpenSshPublicKey('ssh-ed25519 not*base64')).toBeNull()
    expect(parseTunnelOpenRequest({ publicKey: 'nope' })).toBeNull()
    expect(parseTunnelOpenRequest({ publicKey: 'ssh-ed25519 AAAA x' })).toEqual({ publicKey: 'ssh-ed25519 AAAA' })
  })

  it('应答里任何一格不对就整份不收(stcp 名字、密钥、主机公钥、用户)', () => {
    const good = {
      relay: { ...RELAY, user: 'u-1', serverName: 'ssh-dev-ab12', secretKey: 'Zm9vYmFyYmF6cXV4cXV1eA' }, // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
      hostKey: 'ssh-ed25519 AAAAC3Nza',
      sshUser: 'gugu',
    }
    expect(parseTunnelOpenResponse(good)).toEqual(good)
    expect(parseTunnelOpenResponse({ ...good, hostKey: 'x' })).toBeNull()
    expect(parseTunnelOpenResponse({ ...good, relay: { ...good.relay, secretKey: 'short' } })).toBeNull()
    expect(parseTunnelOpenResponse({ ...good, relay: { ...good.relay, serverName: 'a b' } })).toBeNull()
    expect(parseTunnelOpenResponse({ ...good, sshUser: '' })).toBeNull()
  })

  it('心跳只在中转通着时报 tunnel_relay(server 才报;桌面不报)', () => {
    const env = { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: os.tmpdir() } as NodeJS.ProcessEnv
    const base = { readText: () => null, platform: () => 'linux', release: () => '6', arch: () => 'x64', uid: () => 1000 }
    expect(resolveDeviceHostInfo(env, { ...base, tunnelRelayUp: () => true }).tunnel_relay).toBe('frp')
    expect(resolveDeviceHostInfo(env, { ...base, tunnelRelayUp: () => false }).tunnel_relay).toBeUndefined()
    expect(resolveDeviceHostInfo({} as NodeJS.ProcessEnv, { ...base, tunnelRelayUp: () => true }).tunnel_relay).toBeUndefined()
    setTunnelRelayUp(true)
    expect(tunnelRelayUp()).toBe(true)
    setTunnelRelayUp(false)
  })

  it('心跳带上隧道最近一次有流量的时刻(server 才报;没有过 = 不报),只往后走', () => {
    const env = { GUGU_SERVER_MODE: '1', GUGU_SERVER_HOME: os.tmpdir() } as NodeJS.ProcessEnv
    const base = { readText: () => null, platform: () => 'linux', release: () => '6', arch: () => 'x64', uid: () => 1000 }
    resetTunnelActivityForTest()
    expect(tunnelActiveAt()).toBeNull()
    expect(resolveDeviceHostInfo(env, base)).not.toHaveProperty('tunnel_active_at')
    noteTunnelActivity(Date.parse('2026-10-15T09:00:00.000Z'))
    noteTunnelActivity(Date.parse('2026-10-15T08:00:00.000Z'))
    expect(tunnelActiveAt()).toBe('2026-10-15T09:00:00.000Z')
    expect(resolveDeviceHostInfo(env, base).tunnel_active_at).toBe('2026-10-15T09:00:00.000Z')
    expect(resolveDeviceHostInfo({} as NodeJS.ProcessEnv, base)).not.toHaveProperty('tunnel_active_at')
    resetTunnelActivityForTest()
  })
})

describe('frpc:配置、日志、进程', () => {
  it('proxy 与 visitor 各一份;字符串按 TOML 转义', () => {
    const proxy = frpcConfig({ relay: RELAY, user: 'u-1', entry: { kind: 'proxy', name: 'ssh-x', secretKey: 'k"1', localPort: 4022 } })
    expect(proxy).toContain('type = "stcp"')
    expect(proxy).toContain('secretKey = "k\\"1"')
    expect(proxy).toContain('localIP = "127.0.0.1"')
    expect(proxy).toContain('localPort = 4022')
    expect(proxy).toContain('loginFailExit = false')
    const visitor = frpcConfig({
      relay: RELAY,
      user: 'u-1',
      entry: { kind: 'visitor', name: 'visit-x', serverUser: 'u-1', serverName: 'ssh-x', secretKey: 'k', bindPort: 5022 },
    })
    expect(visitor).toContain('[[visitors]]')
    expect(visitor).toContain('serverUser = "u-1"')
    expect(visitor).toContain('bindAddr = "127.0.0.1"')
    expect(visitor).not.toContain('[[proxies]]')
    expect(proxy).not.toContain('transport.protocol')
  })

  it('wss 的中转:两份配置都写 transport.protocol = "wss"', () => {
    const relay = { serverAddr: 'relay.example.test', serverPort: 443, token: 't', protocol: 'wss' as const }
    const proxy = frpcConfig({ relay, user: 'u-1', entry: { kind: 'proxy', name: 'ssh-x', secretKey: 'k', localPort: 4022 } })
    const visitor = frpcConfig({ relay, user: 'u-1', entry: { kind: 'visitor', name: 'v', serverUser: 'u-1', serverName: 'ssh-x', secretKey: 'k', bindPort: 5022 } })
    for (const config of [proxy, visitor]) {
      expect(config).toContain('transport.protocol = "wss"')
      expect(config).toContain('serverPort = 443')
    }
  })

  it('认得「挂上了 / 断了 / 被拒」三种(实测 frpc 0.71.1 的原句),别的行不猜', () => {
    expect(classifyFrpcLine('2026-10-15 15:46:14.200 [I] [client/control.go:174] [10ba] [probe-7199] start proxy success')).toBe('up')
    expect(classifyFrpcLine('2026-10-15 15:46:14.164 [I] [visitor/visitor_manager.go:135] [30d9] start visitor success')).toBe('up')
    expect(classifyFrpcLine('[W] [client/service.go:300] login to the server failed: i/o timeout. With loginFailExit enabled, no additional retries will be attempted')).toBe('rejected')
    expect(classifyFrpcLine('[W] [client/service.go:300] login to the server failed: token in login doesn\'t match token from configuration')).toBe('rejected')
    expect(classifyFrpcLine('[I] [client/service.go:288] try to reconnect to server...')).toBe('down')
    // frps 没了时访问端 / proxy 端的原句(本机实测)。
    expect(classifyFrpcLine('2026-10-15 16:11:35.891 [W] [visitor/visitor.go:146] [bfc8] [v] stcp local listener closed')).toBe('down')
    expect(classifyFrpcLine('2026-10-15 16:11:35.892 [I] [client/service.go:335] [bfc8] try to connect to server...')).toBe('down')
    expect(classifyFrpcLine('2026-10-15 16:11:35.892 [W] [client/service.go:346] [bfc8] connect to server error: dial tcp 127.0.0.1:17001: connect: connection refused')).toBe('down')
    expect(classifyFrpcLine('[I] [proxy/proxy_manager.go:183] proxy added: [probe-7199]')).toBeNull()
  })

  it('上次没收掉的 frpc:命令行里确实是这份配置才收(进程号会被复用)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'))
    const pidFile = path.join(dir, 'a.toml.pid')
    const killed: number[] = []
    expect(killStaleFrpc(pidFile, path.join(dir, 'a.toml'), { readCommand: () => 'x', kill: (pid) => killed.push(pid) })).toBe(false)
    fs.writeFileSync(pidFile, '4242\n')
    expect(killStaleFrpc(pidFile, path.join(dir, 'a.toml'), { readCommand: () => '/usr/bin/vim notes.txt', kill: (pid) => killed.push(pid) })).toBe(false)
    expect(killStaleFrpc(pidFile, path.join(dir, 'a.toml'), { readCommand: () => null, kill: (pid) => killed.push(pid) })).toBe(false)
    expect(killStaleFrpc(pidFile, path.join(dir, 'a.toml'), { readCommand: () => `frpc -c ${path.join(dir, 'a.toml')}`, kill: (pid) => killed.push(pid) })).toBe(true)
    expect(killed).toEqual([4242])
  })

  it('打包版在资源目录找,server 包 / 开发在应用目录找,环境变量最先', () => {
    const list = frpcCandidates({ env: { GUGU_FRPC_BIN: '/x/frpc' }, platform: 'darwin', arch: 'arm64', isPackaged: true, resourcesPath: '/R', appPath: '/A' })
    expect(list).toEqual(['/x/frpc', '/R/frpc-bundle/frpc', '/A/frpc-bundle/frpc', '/A/frpc-bundle/mac-arm64/frpc'])
    expect(frpcCandidates({ env: {}, platform: 'win32', arch: 'x64', isPackaged: false, resourcesPath: undefined, appPath: 'C:/A' }).at(-1)).toContain('win-x64')
  })

  it('waitUp:日志说挂上了就 ok;说被拒就当场失败(❌ 等到超时);配置文件 0600、收掉时删掉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-'))
    const fake = () => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => child.emit('exit', null, 'SIGTERM')
      return child
    }
    let child = fake()
    const states: boolean[] = []
    const runner = startFrpc({
      binary: 'frpc',
      configFile: path.join(dir, 'a.toml'),
      config: 'x',
      onState: (up) => states.push(up),
      spawnFrpc: () => child as never,
    })
    expect(fs.statSync(path.join(dir, 'a.toml')).mode & 0o777).toBe(0o600)
    const waiting = runner.waitUp(5_000)
    child.stdout.write('[I] [x] start proxy success\n')
    await expect(waiting).resolves.toEqual({ ok: true })
    child.stdout.write('[I] try to reconnect to server...\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(states).toEqual([true, false])
    runner.stop()
    expect(fs.existsSync(path.join(dir, 'a.toml'))).toBe(false)

    child = fake()
    const rejected = startFrpc({ binary: 'frpc', configFile: path.join(dir, 'b.toml'), config: 'x', spawnFrpc: () => child as never })
    const result = rejected.waitUp(5_000)
    child.stderr.write("[W] login to the server failed: token in login doesn't match token from configuration\n")
    await expect(result).resolves.toMatchObject({ ok: false, reason: 'rejected' })
    rejected.stop()
  })
})

// ── 内嵌 SSH 服务端:用系统的 ssh 真连 ────────────────────────────────────────────

type Run = { code: number | null; stdout: string; stderr: string }
function runSsh(args: string[], timeoutMs = 20_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function keygen(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', file], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(fs.readFileSync(`${file}.pub`, 'utf8')) : reject(new Error(`ssh-keygen ${code}`))))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

describe('主机钥匙:ssh2 的生成器偶尔给出它自己读不回的钥匙(mscdex/ssh2#1390、#1513,1.17.0 约 1/300)', () => {
  // 公钥首字节是 0 时 ssh2 的 keygen 多剥掉一个 0:公钥 31 字节,私钥文件 parseKey 报 Malformed。
  // 拿它当主机钥匙 `new Server` 当场抛错 —— 那台机器这次起不来隧道(tunnel.open 答「远程隧道起不来」)。
  afterEach(() => vi.restoreAllMocks())

  /** 现场从 ssh2 的生成器里撞出一把它自己读不回的钥匙(约 300 次一把;❌ 把私钥原文提交进仓)。 */
  function brokenPairFromSsh2(): { private: string; public: string } {
    for (let i = 0; i < 20_000; i += 1) {
      const pair = sshUtils.generateKeyPairSync('ed25519')
      if (sshUtils.parseKey(pair.private) instanceof Error) return pair
    }
    throw new Error('2 万次都没撞上读不回的钥匙:ssh2 修了这个 bug?那这一组可以删了')
  }

  function serverStarts(privateKey: string): boolean {
    try {
      new SshServer({ hostKeys: [privateKey] }, () => undefined)
      return true
    } catch {
      return false
    }
  }

  function readBack(file: string): string | null {
    const parsed = sshUtils.parseKey(fs.readFileSync(file, 'utf8'))
    if (parsed instanceof Error) return null
    const key = Array.isArray(parsed) ? parsed[0]! : parsed
    return `${key.type} ${key.getPublicSSH().toString('base64')}`
  }

  it('复现:这把钥匙 ssh2 自己读不回,当主机钥匙起不来', () => {
    const broken = brokenPairFromSsh2()
    expect(sshUtils.parseKey(broken.private)).toBeInstanceOf(Error)
    expect(serverStarts(broken.private)).toBe(false)
  })

  it('生成出读不回的就丢掉重来:写下的、交出去的是同一把读得回的钥匙,重读不变,服务端起得来', () => {
    vi.spyOn(sshUtils, 'generateKeyPairSync').mockReturnValueOnce(brokenPairFromSsh2() as never)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-hostkey-')), 'host')
    const first = ensureHostKey(file)
    expect(readBack(file)).toBe(first.publicKey)
    expect(ensureHostKey(file).publicKey).toBe(first.publicKey)
    expect(serverStarts(first.privateKey)).toBe(true)
  })

  it('已经中招的机器(盘上是读不回的钥匙):下次起来换一把读得回的,服务端起得来', () => {
    const broken = brokenPairFromSsh2()
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-hostkey-')), 'host')
    fs.writeFileSync(file, broken.private, { mode: 0o600 })
    // 最坏情况:换的那一把又撞上一次。
    vi.spyOn(sshUtils, 'generateKeyPairSync').mockReturnValueOnce(brokenPairFromSsh2() as never)
    const recovered = ensureHostKey(file)
    expect(readBack(file)).toBe(recovered.publicKey)
    expect(serverStarts(recovered.privateKey)).toBe(true)
  })
})

describe('内嵌 SSH 服务端(只认登记过的咕咕钥匙、只转发本机回环)', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-ssh-'))
    const hostKey = ensureHostKey(path.join(dir, 'host'))
    // 第二次读回同一把(桌面的 known_hosts 不因重启而失效)。
    expect(ensureHostKey(path.join(dir, 'host')).publicKey).toBe(hostKey.publicKey)
    const keys = createAuthorizedKeys()
    const log = { info: () => undefined, warn: () => undefined }
    const { server, port } = await listenTunnelSsh({
      hostPrivateKey: hostKey.privateKey,
      keys,
      log,
      env: () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() }),
    })
    cleanups.push(() => server.close())
    const keyPath = path.join(dir, 'id')
    const publicKey = normalizeOpenSshPublicKey(await keygen(keyPath))!
    const knownHostsFile = path.join(dir, 'known hosts with space')
    fs.writeFileSync(knownHostsFile, upsertKnownHost('', tunnelHostAlias('dev-1'), hostKey.publicKey))
    const target = tunnelSshTarget({ deviceId: 'dev-1', label: 'Linux 1', sshUser: 'gugu', localPort: port, keyPath, knownHostsFile })
    const batch = { ...target, options: ['-o', 'BatchMode=yes', ...(target.options ?? [])] }
    return { dir, keys, publicKey, target: batch, hostKey, knownHostsFile }
  }

  it('登记过的钥匙:执行命令,标准输出与退出码原样回来', async () => {
    const t = await setup()
    t.keys.add(t.publicKey)
    const run = await runSsh(sshBatchArgs(t.target, 'echo "hi-$((1+1))"; echo oops >&2; exit 3', null))
    expect(run.stdout.trim()).toBe('hi-2')
    expect(run.stderr).toContain('oops')
    expect(run.code).toBe(3)
  }, 30_000)

  it('没登记的钥匙进不去(阴性对照:同一条命令、同一个服务端)', async () => {
    const t = await setup()
    const run = await runSsh(sshBatchArgs(t.target, 'echo hi', null))
    expect(run.code).toBe(255)
    expect(run.stdout).toBe('')
    expect(run.stderr).toMatch(/Permission denied/)
  }, 30_000)

  it('主机公钥对不上就不连(❌ 被中转里冒出来的别的服务端骗过去)', async () => {
    const t = await setup()
    t.keys.add(t.publicKey)
    fs.writeFileSync(t.knownHostsFile, upsertKnownHost('', tunnelHostAlias('dev-1'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEC7hmvQEspOSavj1yqsGS4OAAAAAAAAAAAAAAAAAAAA'))
    const run = await runSsh(sshBatchArgs(t.target, 'echo hi', null))
    expect(run.code).toBe(255)
    expect(run.stderr).toMatch(/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/)
  }, 30_000)

  it('端口转发到那台机器的 localhost 能用;转发到别的主机被拒', async () => {
    const t = await setup()
    t.keys.add(t.publicKey)
    const web = http.createServer((_req, res) => res.end('from-remote-localhost')).listen(0, '127.0.0.1')
    await new Promise((resolve) => web.once('listening', resolve))
    cleanups.push(() => web.close())
    const remotePort = (web.address() as net.AddressInfo).port
    const localPort = await freePort()
    const forward = spawn('ssh', buildForwardSshArgs(t.target, { localPort, remotePort }), { stdio: 'ignore' })
    cleanups.push(() => forward.kill('SIGTERM'))
    resetTunnelActivityForTest()
    let body = ''
    for (let i = 0; i < 50 && !body; i += 1) {
      body = await new Promise<string>((resolve) => {
        http.get(`http://127.0.0.1:${localPort}/`, (res) => {
          let text = ''
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve(text))
        }).on('error', () => setTimeout(() => resolve(''), 100))
      })
    }
    expect(body).toBe('from-remote-localhost')
    // 转发上走过字节 = 「在用」(云电脑的管家据此判闲置)。
    expect(tunnelActiveAt()).not.toBeNull()
    const elsewhere = await runSsh(['-W', '192.0.2.1:80', ...t.target.options!, '-p', String(t.target.port), '--', t.target.destination])
    expect(elsewhere.code).not.toBe(0)
    expect(elsewhere.stderr).toMatch(/open failed|administratively prohibited|channel/i)
  }, 40_000)

  it('登记成「安静」的端口(云浏览器的实时画面)上走的字节不算;撤销登记后又算', async () => {
    const t = await setup()
    t.keys.add(t.publicKey)
    const web = http.createServer((_req, res) => res.end('live-frame')).listen(0, '127.0.0.1')
    await new Promise((resolve) => web.once('listening', resolve))
    cleanups.push(() => web.close())
    const remotePort = (web.address() as net.AddressInfo).port
    const localPort = await freePort()
    const forward = spawn('ssh', buildForwardSshArgs(t.target, { localPort, remotePort }), { stdio: 'ignore' })
    cleanups.push(() => forward.kill('SIGTERM'))
    const fetchOnce = async () => {
      let body = ''
      for (let i = 0; i < 50 && !body; i += 1) {
        body = await new Promise<string>((resolve) => {
          // 每次新开一条连接(安静与否在转发通道建立时定;keep-alive 会复用登记期间开的那条)。
          http.get(`http://127.0.0.1:${localPort}/`, { agent: false }, (res) => {
            let text = ''
            res.on('data', (chunk) => (text += chunk))
            res.on('end', () => resolve(text))
          }).on('error', () => setTimeout(() => resolve(''), 100))
        })
      }
      return body
    }
    const unquiet = quietTunnelPort(remotePort)
    resetTunnelActivityForTest()
    expect(await fetchOnce()).toBe('live-frame')
    expect(tunnelActiveAt()).toBeNull()
    unquiet()
    expect(await fetchOnce()).toBe('live-frame')
    expect(tunnelActiveAt()).not.toBeNull()
  }, 40_000)

  it('执行命令的环境:去掉咕咕账号进程自己的变量,留 GUGU_SERVER_HOME,~/.local/bin 在 PATH 里', () => {
    const env = execEnv(
      { PATH: '/usr/bin', GUGU_SERVER_MODE: '1', GUGU_TASK_HOST_USER_DATA: '/d', GUGU_SERVER_HOME: '/h', ELECTRON_RUN_AS_NODE: '1', LANG: 'C.UTF-8' },
      { username: 'alice', homedir: '/home/alice', shell: '/bin/bash' },
    )
    expect(env).toMatchObject({ GUGU_SERVER_HOME: '/h', LANG: 'C.UTF-8', HOME: '/home/alice', USER: 'alice', SHELL: '/bin/bash' })
    expect(env.GUGU_SERVER_MODE).toBeUndefined()
    expect(env.GUGU_TASK_HOST_USER_DATA).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.PATH).toBe('/home/alice/.local/bin:/usr/bin')
  })

  it('钥匙表有上限,最早登记的先丢', () => {
    const keys = createAuthorizedKeys(2)
    keys.add('ssh-ed25519 QQ==')
    keys.add('ssh-ed25519 Qg==')
    keys.add('ssh-ed25519 Qw==')
    expect(keys.size()).toBe(2)
    expect(keys.has('ssh-ed25519', Buffer.from('A'))).toBe(false)
    expect(keys.has('ssh-ed25519', Buffer.from('C'))).toBe(true)
  })
})

describe('桌面那一头:SshTarget、设备连接参数', () => {
  it('不读用户的 ~/.ssh/config、只用咕咕钥匙、严格核对主机公钥;带空格的路径加引号', () => {
    const target = tunnelSshTarget({ deviceId: 'd1', label: 'L', sshUser: 'gugu', localPort: 5022, keyPath: '/k/id', knownHostsFile: '/a b/kh' })
    expect(target).toMatchObject({ destination: 'gugu@127.0.0.1', port: 5022, display: 'L' })
    expect(target.options).toEqual(expect.arrayContaining(['-F', 'none', '-i', '/k/id', 'StrictHostKeyChecking=yes', 'HostKeyAlias=gugu-tunnel-d1', 'UserKnownHostsFile="/a b/kh"']))
    expect(() => quotedOptionPath('/a"b')).toThrow()
  })

  it('known_hosts 里只换这台那一行', () => {
    const text = upsertKnownHost('gugu-tunnel-a ssh-ed25519 AAA\ngugu-tunnel-b ssh-ed25519 BBB\n', 'gugu-tunnel-a', 'ssh-ed25519 NEW')
    expect(text).toBe('gugu-tunnel-b ssh-ed25519 BBB\ngugu-tunnel-a ssh-ed25519 NEW\n')
  })

  it('经远程隧道的设备连接 ❌ 带 --adopt-ssh(那会把它记成远程 SSH)', () => {
    const target = { destination: 'gugu@127.0.0.1', port: 5022, display: 'L' }
    expect(sshLinkArgs(target, { controlPath: null, accountUserId: 'u1', adoptSsh: false }).at(-1)).toBe('exec ~/.local/bin/gugu-server link --account u1')
    expect(sshLinkArgs(target, { controlPath: null, accountUserId: 'u1' }).at(-1)).toBe('exec ~/.local/bin/gugu-server link --account u1 --adopt-ssh')
  })

  it('tunnel.open 的失败按原因分', () => {
    expect(classifyOpenFailure({ error: { code: 'unknown_method', message: '' } })).toBe('unsupported')
    expect(classifyOpenFailure({ error: { code: 'relay_down', message: '' } })).toBe('relayDown')
    expect(classifyOpenFailure(null)).toBe('unreachable')
  })
})

describe('桌面那一头:状态机', () => {
  const okResponse = {
    result: {
      relay: { ...RELAY, user: 'me', serverName: 'ssh-d1-0001', secretKey: 'Zm9vYmFyYmF6cXV4cXV1eA' }, // gitleaks:allow -- synthetic credential for redaction/protocol regression tests
      hostKey: 'ssh-ed25519 AAAAC3Nza',
      sshUser: 'gugu',
    },
  }
  function deps(overrides: Partial<Parameters<typeof createTunnelMachines>[0]> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-desk-'))
    const configs: string[] = []
    return {
      configs,
      deps: {
        currentUserId: async () => 'me',
        callCloud: async () => okResponse,
        ensureKey: async () => ({ keyPath: path.join(dir, 'id'), publicKey: 'ssh-ed25519 AAAA' }),
        frpcBinary: () => '/bin/frpc',
        stateDir: () => dir,
        controlPath: () => path.join(dir, 'cm-%C'),
        log: () => undefined,
        freePort: async () => 5555,
        runSsh: async () => ({ code: 0, stderr: '' }),
        startFrpc: ((input: { config: string }) => {
          configs.push(input.config)
          return { isUp: () => true, waitUp: async () => ({ ok: true as const }), stop: () => undefined }
        }) as never,
        ...overrides,
      } satisfies Parameters<typeof createTunnelMachines>[0],
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('重启即收掉本 profile 的遗留访问端和配置,不必再次请求那台机器,别的 profile 不动', async () => {
    const { deps: d } = deps()
    const dir = d.stateDir()
    const config = path.join(dir, 'frpc-offline-device.toml')
    const other = path.join(dir, 'other-profile')
    fs.mkdirSync(other)
    fs.writeFileSync(config, 'synthetic relay configuration')
    fs.writeFileSync(path.join(other, 'frpc-other.toml'), 'another profile')
    fs.writeFileSync(path.join(dir, 'tunnel_known_hosts'), 'keep known hosts')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', config], { stdio: 'ignore' })
    const exited = once(child, 'exit')
    try {
      await once(child, 'spawn')
      fs.writeFileSync(`${config}.pid`, String(child.pid))
      const cloud = vi.fn(d.callCloud)
      const machines = createTunnelMachines({ ...d, callCloud: cloud })
      expect(fs.existsSync(config)).toBe(false)
      expect(fs.existsSync(`${config}.pid`)).toBe(false)
      expect(fs.readFileSync(path.join(other, 'frpc-other.toml'), 'utf8')).toBe('another profile')
      expect(fs.readFileSync(path.join(dir, 'tunnel_known_hosts'), 'utf8')).toBe('keep known hosts')
      expect(cloud).not.toHaveBeenCalled()
      expect(machines.state().ready).toEqual([])
      expect(await exited).toEqual([null, 'SIGTERM'])
      machines.closeAll()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('问到 → 起访问端 → ssh 通了才算连上;给出经 127.0.0.1:端口 的 SshTarget', async () => {
    const { deps: d, configs } = deps()
    const machines = createTunnelMachines(d)
    const seen: TunnelState[] = []
    machines.onChange((state) => seen.push(state))
    machines.want([{ deviceId: 'd1', label: 'Linux 1' }])
    await settle()
    expect(machines.state()).toEqual({ ready: ['d1'], problems: {} })
    expect(machines.linkMachine('d1')).toMatchObject({ accountUserId: 'me', target: { destination: 'gugu@127.0.0.1', port: 5555 } })
    expect(configs[0]).toContain('serverName = "ssh-d1-0001"')
    expect(configs[0]).toContain('bindPort = 5555')
    machines.want([])
    expect(machines.state()).toEqual({ ready: [], problems: {} })
    expect(machines.linkMachine('d1')).toBeNull()
    machines.closeAll()
  })

  it('那台机器太旧(不认 tunnel.open):记 unsupported,不算连上', async () => {
    const { deps: d } = deps({ callCloud: async () => ({ error: { code: 'unknown_method', message: 'unknown device RPC type' } }) })
    const machines = createTunnelMachines(d)
    machines.want([{ deviceId: 'd1', label: 'L' }])
    await settle()
    expect(machines.state()).toEqual({ ready: [], problems: { d1: 'unsupported' } })
    machines.closeAll()
  })

  it('SSH 进不去:记 sshFailed;那台机器登的不是这个人:不连', async () => {
    const failing = createTunnelMachines(deps({ runSsh: async () => ({ code: 255, stderr: 'Permission denied (publickey).' }) }).deps)
    failing.want([{ deviceId: 'd1', label: 'L' }])
    await settle()
    expect(failing.state().problems).toEqual({ d1: 'sshFailed' })
    failing.closeAll()
    const other = createTunnelMachines(deps({ currentUserId: async () => 'someone-else' }).deps)
    other.want([{ deviceId: 'd1', label: 'L' }])
    await settle()
    expect(other.state()).toEqual({ ready: [], problems: { d1: 'unsupported' } })
    other.closeAll()
  })

  it('建连途中掉出单子又回来:旧的那次作废 —— ❌ 再起一个 frpc、❌ 留下没人收的进程、❌ 写原因', async () => {
    // 第一次问 tunnel.open 卡住;期间这台掉出去又回来,新的一次先连上;旧的那次随后才拿到应答。
    for (const late of [okResponse, { error: { code: 'relay_down', message: 'down' } }]) {
      let releaseFirst: (value: unknown) => void = () => undefined
      let calls = 0
      const started: { stopped: boolean }[] = []
      const { deps: d } = deps({
        callCloud: (async () => {
          calls += 1
          return calls === 1 ? new Promise((resolve) => (releaseFirst = resolve)) : okResponse
        }) as never,
        startFrpc: (() => {
          const frpc = { stopped: false }
          started.push(frpc)
          return { isUp: () => true, waitUp: async () => ({ ok: true as const }), stop: () => void (frpc.stopped = true) }
        }) as never,
      })
      const machines = createTunnelMachines(d)
      machines.want([{ deviceId: 'd1', label: 'L' }])
      await settle()
      machines.want([])
      machines.want([{ deviceId: 'd1', label: 'L' }])
      await settle()
      expect(machines.state()).toEqual({ ready: ['d1'], problems: {} })
      releaseFirst(late)
      await settle()
      expect(machines.state()).toEqual({ ready: ['d1'], problems: {} })
      expect(started).toHaveLength(1)
      machines.closeAll()
      expect(started.every((frpc) => frpc.stopped)).toBe(true)
    }
  })

  it('publishes a failure event when local auth is unavailable, releasing tunnel waiters', async () => {
    const machines = createTunnelMachines(deps({ currentUserId: async () => null }).deps)
    try {
      const changed = new Promise<TunnelState>((resolve) => { machines.onChange(resolve) })
      machines.want([{ deviceId: 'd1', label: 'L' }])
      await expect(changed).resolves.toEqual({ ready: [], problems: { d1: 'unreachable' } })
    } finally {
      machines.closeAll()
    }
  })

  it('登录态一时没就绪:过一会儿自己重试连上(❌ 停在「正在连接」)', async () => {
    vi.useFakeTimers()
    try {
      let signedIn = false
      const { deps: d } = deps({ currentUserId: async () => (signedIn ? 'me' : null) })
      const machines = createTunnelMachines(d)
      machines.want([{ deviceId: 'd1', label: 'L' }])
      await vi.advanceTimersByTimeAsync(50)
      expect(machines.state()).toEqual({ ready: [], problems: { d1: 'unreachable' } })
      signedIn = true
      await vi.advanceTimersByTimeAsync(5_000)
      expect(machines.state()).toEqual({ ready: ['d1'], problems: {} })
      machines.closeAll()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('渲染层:哪几台要经远程隧道连、界面说什么', () => {
  const device = (over: Record<string, unknown> = {}) =>
    ({ device_id: 'd1', is_online: true, is_current_device: false, capabilities: { terminals: [], runtimes: [], tunnel_relay: 'frp' }, ...over }) as never
  const none: TunnelState = { ready: [], problems: {} }

  it('在线、报了中转通着、这台电脑没有它的 SSH 映射 → 要连', () => {
    expect(wantsTunnel(device(), new Set())).toBe(true)
    expect(wantsTunnel(device(), new Set(['d1']))).toBe(false)
    expect(wantsTunnel(device({ is_online: false }), new Set())).toBe(false)
    expect(wantsTunnel(device({ capabilities: { terminals: [], runtimes: [] } }), new Set())).toBe(false)
    expect(wantsTunnel(device({ is_current_device: true }), new Set())).toBe(false)
  })

  it('正在连 / 连不上的原因 / 没开 / 连通了 / 手机上:各说各的', () => {
    expect(tunnelFacts(device(), new Set(), none, true)).toEqual({ tunnel: 'connecting' })
    expect(tunnelFacts(device(), new Set(), { ready: [], problems: { d1: 'relayDown' } }, true)).toEqual({ tunnel: 'relayDown' })
    expect(tunnelFacts(device({ capabilities: { terminals: [], runtimes: [] } }), new Set(), none, true)).toEqual({ tunnel: 'off' })
    expect(tunnelFacts(device(), new Set(), { ready: ['d1'], problems: {} }, true)).toEqual({})
    expect(tunnelFacts(device(), new Set(), none, false)).toEqual({})
  })
})

describe('设备连接上的「在用」:白名单,只认终端的输入与输出(总控 10-15 定)', () => {
  // 「光连着不算」:连着时桌面自动发的东西(心跳、状态轮询、刚连上的订阅与打开)、机器推来的变动都 ❌ 算。
  // 10-15 实测:测试号云电脑没人用,却被云浏览器每 20 秒一次的 cloudBrowser.status、机器推的 files:changes 一直顶着醒。
  const frame = (message: unknown) => ({ f: JSON.stringify(message) })
  const hb = frame({ t: 'hb' })
  const termIn = frame({ t: 'invoke', id: 7, channel: 'pty.sendInput', args: ['s', 'ls\r'] })
  const termOut = frame({ t: 'event', channel: 'pty:data.p:c:s', data: 'total 0\r\n' })

  /** 一条请求(桌面 → 机器)或一条推送(机器 → 桌面)过一遍设备连接,回答它算不算「在用」;应答照发但从不算。 */
  async function counts(kind: 'request' | 'push', type: string, frames: unknown[], payload: Record<string, unknown> = {}): Promise<boolean> {
    let activity = 0
    let push: unknown = null
    const factory = createDeviceLinkHost({
      userId: () => 'u-1',
      onActivity: () => (activity += 1),
      createHandlers: () => ({
        handlers: {
          [type]: (_payload: unknown, ctx: { publishEvent(payload: unknown): unknown }) => {
            if (push) void ctx.publishEvent(push)
            return { result: { ok: true } }
          },
          'taskhost.frame': (_payload: unknown, ctx: { publishEvent(payload: unknown): unknown }) => {
            if (push) void ctx.publishEvent(push)
            return { result: { ok: true } }
          },
        },
        dispose: () => undefined,
      }),
    })
    const sent: unknown[] = []
    const session = factory((message) => sent.push(message))
    if (kind === 'request') {
      session.handle(asBroadcast({ type, request_id: 'r1', user_id: 'u-1', payload: { client: 'c1234567', seq: 1, frames, ...payload } }))
    } else {
      push = { type, client: 'c1234567', seq: 2, frames }
      session.handle(asBroadcast({ type: 'taskhost.frame', request_id: 'r2', user_id: 'u-1', payload: { client: 'c1234567', seq: 1, frames: [hb] } }))
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent.length).toBeGreaterThan(0) // 应答照发
    session.dispose()
    return activity > 0
  }

  it('心跳(请求与推送)不算', async () => {
    expect(await counts('request', 'taskhost.frame', [hb])).toBe(false)
    expect(await counts('push', 'taskhost.frame', [hb, hb])).toBe(false)
  })

  it('终端输入算:pty.sendInput(和心跳一起来也算)', async () => {
    expect(await counts('request', 'taskhost.frame', [termIn])).toBe(true)
    expect(await counts('request', 'taskhost.frame', [hb, termIn])).toBe(true)
  })

  it('终端输出算:pty:data 推送;大帧拆成几片时看第一片', async () => {
    expect(await counts('push', 'taskhost.frame', [termOut])).toBe(true)
    const big = JSON.stringify({ t: 'event', channel: 'pty:data.p:c:s', data: 'x'.repeat(400) })
    expect(await counts('push', 'taskhost.frame', [{ f: big.slice(0, 200), p: 0, n: 2 }])).toBe(true)
    expect(await counts('push', 'taskhost.frame', [{ f: big.slice(200), p: 1, n: 2 }])).toBe(false)
  })

  it('状态轮询不算:taskhost.call cloudBrowser.status(云浏览器每 20 秒一次)', async () => {
    expect(await counts('request', 'taskhost.call', [], { channel: 'cloudBrowser.status', args: [] })).toBe(false)
    expect(await counts('request', 'taskhost.frame', [frame({ t: 'invoke', id: 3, channel: 'cloudBrowser.status', args: [] })])).toBe(false)
  })

  it('刚连上那批不算:打开窗口、订阅(哪怕订的是终端输出)、别的调用', async () => {
    expect(await counts('request', 'taskhost.open', [])).toBe(false)
    expect(await counts('request', 'taskhost.frame', [frame({ t: 'sub', channel: 'pty:data.p:c:s' })])).toBe(false)
    expect(await counts('request', 'taskhost.frame', [frame({ t: 'invoke', id: 4, channel: 'sessions.list', args: [] })])).toBe(false)
  })

  it('机器推来的变动不算:files:changes、会话事件', async () => {
    expect(await counts('push', 'taskhost.frame', [frame({ t: 'event', channel: 'files:changes', data: { projectId: 'p' } })])).toBe(false)
    expect(await counts('push', 'taskhost.frame', [frame({ t: 'event', channel: 'sessions:changed', data: {} })])).toBe(false)
  })

  it('二进制片(粘贴的文件块)与坏片不算', async () => {
    expect(await counts('request', 'taskhost.frame', [{ b: 'AAAA' }])).toBe(false)
    expect(await counts('request', 'taskhost.frame', [{ f: 'not json' }, null, 3])).toBe(false)
  })
})
