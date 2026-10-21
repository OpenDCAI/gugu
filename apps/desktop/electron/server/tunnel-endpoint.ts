/**
 * 远程隧道 · 那台机器这一头(咕咕 server 的账号进程里跑,见 packages/core/src/cloud/remoteTunnel.ts)。
 *
 * 照 VS Code 远程隧道 / Coder 的形状:中转只搬字节,里面跑 SSH(ssh2 的服务端,内嵌在账号进程里)——
 *  · 只听 127.0.0.1 的一个随机端口,frpc 以 stcp 把它挂到中转上(proxy 名与密钥每次起进程随机生成);
 *  · 只认公钥:哪把钥匙能进,由这台机器的主人经 `tunnel.open`(咕咕云上只有本人进得去的设备频道)当场登记,
 *    只记在内存里 —— 账号进程一重启全部作废,桌面重连时再登记一次;
 *  · 只做桌面要的那三件:执行命令(设备连接 `gugu-server link`、看状态)、本机回环的端口转发(浏览器 / 端口)。
 *    不给交互 shell、不给反向转发、不转发到别的主机。
 * 命令以这个账号进程的身份跑 —— 与经 SSH 登录这台机器的同一个人、同一个系统用户,不多一分权限。
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Server, utils, type Connection, type ServerChannel } from 'ssh2'
import {
  isQuietTunnelPort,
  noteTunnelActivity,
  parseTunnelOpenRequest,
  setTunnelRelayUp,
  TUNNEL_OPEN_RPC_TYPE,
  type RelayEndpoint,
  type TunnelOpenResponse,
} from '@gugu/core/cloud/remoteTunnel'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import { frpcConfig, startFrpc, type FrpcRunner } from './frpc-runner'

/** 桌面登进来用的用户名(只是个标签:命令一律以账号进程的系统用户跑)。 */
export const TUNNEL_SSH_USER = 'gugu'

/** 一个账号进程最多同时记多少把桌面钥匙(超了丢最早登记的)。 */
const MAX_AUTHORIZED_KEYS = 32

/** 等 frpc 挂上中转最多多久(tunnel.open 进来时它可能还在连)。 */
const RELAY_WAIT_MS = 15_000

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

type Log = { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void }

/** 已登记的桌面钥匙(`类型 base64`)。纯数据结构,便于单测。 */
export function createAuthorizedKeys(max = MAX_AUTHORIZED_KEYS) {
  const keys: string[] = []
  return {
    add(publicKey: string): void {
      const at = keys.indexOf(publicKey)
      if (at >= 0) keys.splice(at, 1)
      keys.push(publicKey)
      while (keys.length > max) keys.shift()
    },
    has(algo: string, data: Buffer): boolean {
      return keys.includes(`${algo} ${data.toString('base64')}`)
    },
    size: () => keys.length,
  }
}

/**
 * 执行命令时的环境:照这个账号进程的环境来(PATH、语言…),去掉咕咕自己的内部变量 —— 否则 `gugu-server link`
 * 这类命令会读到账号进程专用的设置(数据目录、应用路径),表现与人经 SSH 登进来执行时不一样。
 * 保留 GUGU_SERVER_HOME(装在非默认目录的 server 靠它找到自己)。纯函数。
 */
export function execEnv(base: NodeJS.ProcessEnv, user: { username: string; homedir: string; shell: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (/^(GUGU_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/.test(key) && key !== 'GUGU_SERVER_HOME') continue
    env[key] = value
  }
  env.HOME = user.homedir
  env.USER = user.username
  env.LOGNAME = user.username
  env.SHELL = user.shell
  const localBin = path.join(user.homedir, '.local', 'bin')
  const parts = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')
  env.PATH = parts.includes(localBin) ? parts.join(':') : [localBin, ...parts].join(':')
  return env
}

/** 私钥 → `类型 base64` 的公钥;ssh2 读不回 = null。交出去的公钥只从这里算(与 SSH 握手时出示的是同一把)。 */
function hostPublicKey(privateKey: string): string | null {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) return null
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  return key ? `${key.type} ${key.getPublicSSH().toString('base64')}` : null
}

/** ssh2 生成器连着给出读不回的钥匙这么多次就认栽(单次约 1/300,8 次连着 ≈ 0)。 */
const HOST_KEY_ATTEMPTS = 8

/**
 * 主机钥匙:有就读,没有就生成一把(0600)。桌面每次 tunnel.open 都拿到它的公钥,写进自己的 known_hosts 严格核对。
 * ssh2 1.17.0 的 ed25519 生成器在公钥首字节为 0 时多剥一个 0,写出它自己 parseKey 都读不回的私钥(mscdex/ssh2#1390、
 * #1513,约 1/300):拿它当主机钥匙 `new Server` 当场抛错。所以生成后先读一遍,读不回就丢掉重来。
 * 已有的文件读不回(旧版本写下的坏钥匙)同样换一把:新公钥随下一次 tunnel.open 交给桌面,known_hosts 跟着换。
 */
export function ensureHostKey(file: string): { privateKey: string; publicKey: string } {
  if (fs.existsSync(file)) {
    const privateKey = fs.readFileSync(file, 'utf8')
    const publicKey = hostPublicKey(privateKey)
    if (publicKey) return { privateKey, publicKey }
  }
  for (let attempt = 0; attempt < HOST_KEY_ATTEMPTS; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519')
    const publicKey = hostPublicKey(pair.private)
    if (!publicKey) continue
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, pair.private, { mode: 0o600 })
    return { privateKey: pair.private, publicKey }
  }
  throw new Error(`ssh2 连着 ${HOST_KEY_ATTEMPTS} 次生成的主机钥匙都读不回`)
}

function handleConnection(client: Connection, deps: {
  keys: ReturnType<typeof createAuthorizedKeys>
  env: () => NodeJS.ProcessEnv
  shell: string
  cwd: string
  log: Log
}): void {
  client.on('authentication', (ctx) => {
    if (ctx.method !== 'publickey' || ctx.username !== TUNNEL_SSH_USER) return ctx.reject(['publickey'])
    if (!deps.keys.has(ctx.key.algo, ctx.key.data)) return ctx.reject(['publickey'])
    // 不带签名 = 只是问「这把钥匙认不认」;带签名的那次才真验。
    if (ctx.signature) {
      const key = utils.parseKey(ctx.key.data)
      if (key instanceof Error || (Array.isArray(key) ? key[0] : key).verify(ctx.blob ?? Buffer.alloc(0), ctx.signature, ctx.hashAlgo) !== true) {
        return ctx.reject(['publickey'])
      }
    }
    ctx.accept()
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('env', (accept) => accept?.())
      session.on('pty', (_accept, reject) => reject?.())
      session.on('shell', (_accept, reject) => reject?.())
      session.on('subsystem', (_accept, reject) => reject?.())
      session.on('exec', (accept, _reject, info) => {
        const stream = accept()
        runExec(stream, info.command, deps)
      })
    })
    client.on('tcpip', (accept, reject, info) => {
      // 只转发到这台机器自己的回环地址(浏览器 / 端口打开的是那台机器上的 localhost)。
      if (!LOOPBACK.has(info.destIP) || !Number.isInteger(info.destPort) || info.destPort <= 0 || info.destPort > 65535) return reject()
      const socket = net.connect({ host: info.destIP === 'localhost' ? 'localhost' : info.destIP, port: info.destPort })
      socket.once('connect', () => {
        const channel = accept()
        // 浏览器 / 端口:任何一个字节都算「在用」(云电脑的管家据此判闲置;只是开着转发、没人访问 = 没有字节)。
        // 登记成安静的端口除外(云浏览器的实时画面:它自己只在接管后的输入上记),见 core/cloud/remoteTunnel.ts。
        if (!isQuietTunnelPort(info.destPort)) {
          socket.on('data', () => noteTunnelActivity())
          channel.on('data', () => noteTunnelActivity())
        }
        socket.pipe(channel).pipe(socket)
        channel.on('close', () => socket.destroy())
        socket.on('close', () => channel.close())
      })
      socket.once('error', () => {
        try {
          reject()
        } catch {
          // 已经 accept 过了:通道随 socket 关掉
        }
      })
    })
    client.on('request', (_accept, reject) => reject?.())
    client.on('openssh.streamlocal', (_accept, reject) => reject())
  })
  client.on('error', (error) => deps.log.warn('tunnel ssh client error', { error: error.message }))
}

function runExec(stream: ServerChannel, command: string, deps: { env: () => NodeJS.ProcessEnv; shell: string; cwd: string; log: Log }): void {
  const child = spawn(deps.shell, ['-c', command], { cwd: deps.cwd, env: deps.env(), stdio: ['pipe', 'pipe', 'pipe'] })
  stream.pipe(child.stdin)
  child.stdout.pipe(stream, { end: false })
  child.stderr.pipe(stream.stderr, { end: false })
  child.stdin.on('error', () => undefined)
  let exited = false
  child.on('error', (error) => {
    deps.log.warn('tunnel exec spawn failed', { error: error.message })
    stream.stderr.write(`${error.message}\n`)
    stream.exit(127)
    stream.end()
  })
  child.on('close', (code, signal) => {
    exited = true
    if (signal) stream.exit(signal.replace(/^SIG/, ''), false, '')
    else stream.exit(code ?? 0)
    stream.end()
  })
  // 桌面那头关了(设备连接收掉、ssh 断了):命令跟着结束。
  stream.on('close', () => {
    if (!exited) child.kill('SIGTERM')
  })
}

/** 只听 127.0.0.1 的随机端口的那个 SSH 服务端(frpc 把它挂到中转上)。 */
export async function listenTunnelSsh(input: {
  hostPrivateKey: string
  keys: ReturnType<typeof createAuthorizedKeys>
  log: Log
  env?: () => NodeJS.ProcessEnv
}): Promise<{ server: Server; port: number }> {
  const user = os.userInfo()
  const shell = user.shell || '/bin/sh'
  const server = new Server({ hostKeys: [input.hostPrivateKey], ident: 'gugu-tunnel' }, (client) =>
    handleConnection(client, {
      keys: input.keys,
      env: input.env ?? (() => execEnv(process.env, { username: user.username, homedir: user.homedir, shell })),
      shell,
      cwd: user.homedir,
      log: input.log,
    }),
  )
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  return { server, port }
}

export type TunnelEndpoint = {
  rpcHandlers(): DeviceRpcHandlers
  stop(): void
}

/**
 * 起这个账号的远程隧道端点。中转没配(这个构建没烘、环境里也没给)或者包里没有 frpc ⇒ 不起、如实记一笔 ——
 * 聊天与会话照旧走咕咕云,只是别的电脑上没有终端 / 浏览器 / 端口。
 */
export async function startTunnelEndpoint(input: {
  dataDir: string
  accountUserId: string
  deviceId: () => Promise<string | null>
  relay: RelayEndpoint
  frpcBinary: string
  log: Log
}): Promise<TunnelEndpoint> {
  const dir = path.join(input.dataDir, 'tunnel')
  const hostKey = ensureHostKey(path.join(dir, 'host_ed25519'))
  const keys = createAuthorizedKeys()
  const { server, port } = await listenTunnelSsh({ hostPrivateKey: hostKey.privateKey, keys, log: input.log })
  const deviceId = await input.deviceId()
  if (!deviceId) throw new Error('这台机器还没有设备 id')
  const serverName = `ssh-${deviceId}-${crypto.randomBytes(4).toString('hex')}`.slice(0, 128)
  const secretKey = crypto.randomBytes(24).toString('base64url')
  const frpc: FrpcRunner = startFrpc({
    binary: input.frpcBinary,
    configFile: path.join(dir, 'frpc.toml'),
    config: frpcConfig({
      relay: input.relay,
      user: input.accountUserId,
      entry: { kind: 'proxy', name: serverName, secretKey, localPort: port },
    }),
    onState: (up) => {
      setTunnelRelayUp(up)
      input.log.info(up ? 'tunnel relay up' : 'tunnel relay down', { serverName })
    },
    log: (message, fields) => input.log.warn(message, fields),
  })
  input.log.info('tunnel endpoint started', { port, serverName })

  return {
    rpcHandlers: () => ({
      [TUNNEL_OPEN_RPC_TYPE]: async (payload) => {
        const request = parseTunnelOpenRequest(payload)
        if (!request) return { error: { code: 'invalid_payload', message: 'tunnel.open 要带这台电脑的公钥' } }
        keys.add(request.publicKey)
        const relay = await frpc.waitUp(RELAY_WAIT_MS)
        if (!relay.ok) {
          return { error: { code: 'relay_down', message: `这台机器连不上远程隧道的中转(${relay.reason}):${relay.detail}` } }
        }
        const result: TunnelOpenResponse = {
          relay: { ...input.relay, user: input.accountUserId, serverName, secretKey },
          hostKey: hostKey.publicKey,
          sshUser: TUNNEL_SSH_USER,
        }
        return { result }
      },
    }),
    stop() {
      frpc.stop()
      setTunnelRelayUp(false)
      server.close()
    },
  }
}
