/**
 * #6264「下次免密」:人用密码登上一台机器、并勾了「以后连这台不用再输密码」时,咕咕替他做一遍 ssh-copy-id。
 *
 * 照谁做的:
 *  · 装到哪、怎么装 —— OpenSSH 自带的 ssh-copy-id(openssh-portable contrib/ssh-copy-id):
 *    `cd; umask 077; mkdir -p .ssh`,末尾没换行先补一个再追加,有 restorecon 就恢复 SELinux 标签;
 *    装之前先看这把钥匙是不是已经在了(它是先拿钥匙试登一次,我们在同一条已认证的连接里按钥匙本体查一遍)。
 *  · 用哪把钥匙 —— Termius「Export to host」:用 App 自己钥匙串里的钥匙,导出后这把钥匙**关联到这台主机**,
 *    以后一点就连(docs.termius.com/keychain/ssh-keys-and-certificates#export-an-ssh-key-to-a-server);
 *    VS Code Remote-SSH 文档也建议给远端开发单独一把钥匙(「Improving your security with a dedicated key」)。
 *    所以咕咕在自己的数据目录里生成**一把只给咕咕用**的 ed25519 钥匙(没有口令 —— 目的就是下次不问),
 *    ❌ 动 ~/.ssh 里用户自己的钥匙、❌ 改 ~/.ssh/config;私钥永远只在这台电脑上,只有公钥那一行交给对方。
 *  · 装完一定验一次(ssh-copy-id 的 filter_ids 同款):只用这把钥匙、不许问任何东西(BatchMode)、
 *    不复用已认证的连接,真握一次手。过了才算「下次免密」,没过就如实说为什么(那台机器不收钥匙登录、
 *    家目录写不进去……),这次的密码登录照旧不受影响。
 *
 * 装进 authorized_keys 的那一行末尾是 `gugu@<这台电脑>`,认得出是谁加的;同一把钥匙已经在了就不再追加。
 */
import { spawn, spawnSync } from '@gugu/core/local/childProcess'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SshKeyInstallOutcome } from '../../src/session/shared/ssh-prompt'
import { describePrompt, type SshTarget } from './ssh-install/logic'
import { quoteShellArg } from '../session/main/utils/shellEscape'
import type { SpawnSsh } from './ssh-install/runner'
import { systemSpawnSsh } from './ssh-install/system'
import { openAskpassWorkspace } from './ssh-prompts'

export type { SshKeyInstallOutcome }

/** 咕咕自己那把钥匙的文件名(放在咕咕数据目录下的 ssh/ 里)。 */
export const GUGU_KEY_FILE = 'id_ed25519'

const ADDED = '__GUGU_KEY_ADDED__'
const PRESENT = '__GUGU_KEY_PRESENT__'
const WRITE_FAILED = '__GUGU_KEY_WRITE_FAILED__'

/**
 * 这台电脑叫什么。macOS 上 os.hostname() 常常是网络给的名字(实测一台 MBP 拿到的是 `192.168.10.98`),
 * 人认不出;用「共享」里那个本地主机名(`scutil --get LocalHostName`,如 Yangs-MacBook-Pro)。其余系统用主机名。
 */
export function computerName(): string {
  if (process.platform === 'darwin') {
    const result = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 1_000 })
    const name = result.status === 0 ? result.stdout.trim() : ''
    if (name) return name
  }
  return os.hostname()
}

/** authorized_keys 那一行的注释:gugu@这台电脑。只留安全字符,❌ 让主机名里的怪字符混进对方的文件。 */
export function guguKeyComment(hostname: string = computerName()): string {
  const name = hostname.replace(/\.local$/i, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
  return `gugu@${name || 'desktop'}`
}

/** `ssh-ed25519 AAAA… 原注释` → 类型与钥匙本体;形状不对 = null。 */
export function parsePublicKey(text: string): { type: string; blob: string } | null {
  const [type, blob] = text.trim().split(/\s+/)
  if (!type || !blob) return null
  if (!/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-[a-z0-9@.-]+)$/.test(type)) return null
  if (!/^[A-Za-z0-9+/]+={0,3}$/.test(blob)) return null
  return { type, blob }
}

/** 装进对方 authorized_keys 的那一行:类型 钥匙本体 gugu@这台电脑。 */
export function authorizedKeyLine(publicKey: string, comment: string): string {
  const key = parsePublicKey(publicKey)
  if (!key) throw new Error('公钥形状不对')
  if (!/^gugu@[A-Za-z0-9._-]+$/.test(comment)) throw new Error('注释形状不对')
  return `${key.type} ${key.blob} ${comment}`
}

/**
 * 在对方机器上跑的那段 sh(经标准输入喂给 `sh -s`,与装机脚本同一个做法)。
 * 照 ssh-copy-id 的 installkeys_sh:回到家目录、umask 077、mkdir -p .ssh、末尾补换行再追加、restorecon。
 * 多做的两件:按钥匙本体查重(已经在了就不追加);把 .ssh 与 authorized_keys 上「组/别人可写」去掉 ——
 * sshd 默认 StrictModes,这两个位在就不认里面的钥匙(VS Code 文档要求 .ssh 700、authorized_keys 600)。
 * ❌ 改动别的权限位、❌ 覆盖整份文件。
 */
export function installAuthorizedKeyScript(line: string): string {
  const key = parsePublicKey(line)
  if (!key) throw new Error('公钥形状不对')
  return [
    'cd || exit 1',
    'umask 077',
    'f=.ssh/authorized_keys',
    `blob=${quoteShellArg(key.blob)}`,
    `line=${quoteShellArg(line)}`,
    `mkdir -p .ssh 2>/dev/null || { echo ${WRITE_FAILED}; exit 0; }`,
    'chmod go-w .ssh 2>/dev/null',
    `if [ -f "$f" ] && grep -qF "$blob" "$f" 2>/dev/null; then echo ${PRESENT}; else`,
    `  { [ -z "$(tail -c 1 "$f" 2>/dev/null)" ] || echo; printf '%s\\n' "$line"; } >> "$f" 2>/dev/null || { echo ${WRITE_FAILED}; exit 0; }`,
    `  echo ${ADDED}`,
    'fi',
    'chmod go-w "$f" 2>/dev/null',
    'if command -v restorecon >/dev/null 2>&1; then restorecon -F .ssh "$f" >/dev/null 2>&1; fi',
    'exit 0',
    '',
  ].join('\n')
}

/** 装的那一步怎么收场:加上了 / 本来就在 / 写不进去 / 没连上(认不出)。 */
export function parseInstallOutput(result: { code: number | null; stdout: string }): 'added' | 'present' | 'write-failed' | 'unknown' {
  if (result.stdout.includes(WRITE_FAILED)) return 'write-failed'
  if (result.stdout.includes(ADDED)) return 'added'
  if (result.stdout.includes(PRESENT)) return 'present'
  return 'unknown'
}

/** 这台机器以后都带上这把钥匙:`-o IdentityFile=<咕咕的钥匙>`,已经有了就不重复加。 */
export function withGuguIdentity(options: readonly string[] | undefined, keyPath: string): string[] {
  const next = [...(options ?? [])]
  const flag = `IdentityFile=${keyPath}`
  for (let i = 0; i < next.length - 1; i++) if (next[i] === '-o' && next[i + 1] === flag) return next
  next.push('-o', flag)
  return next
}

/**
 * 验一次:只用咕咕的钥匙、只走钥匙登录、不许问(BatchMode)、不复用已认证的连接(ControlPath=none),
 * 其余连接选项(端口、跳板、用户给的 -i)照这台机器平时那样带上。
 */
export function verifyKeySshArgs(target: SshTarget, keyPath: string): string[] {
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ControlPath=none',
    '-o', 'ConnectTimeout=15',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'IdentitiesOnly=yes',
    '-o', `IdentityFile=${keyPath}`,
    '-o', 'LogLevel=ERROR',
  ]
  if (target.port !== undefined) args.push('-p', String(target.port))
  if (target.options?.length) args.push(...target.options)
  args.push('--', target.destination, 'exit 0')
  return args
}

/**
 * 装的那一次:能复用刚认证过的那条连接就复用(ControlMaster=no + 同一个 ControlPath,不另开主连接);
 * 没有可复用的(Windows、端口转发那条是独立连接)就重新连一次,要密码时由调用方的 askpass 用刚才那个密码答。
 */
export function installKeySshArgs(target: SshTarget, controlPath: string | null): string[] {
  const args = ['-T', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR']
  if (controlPath) args.push('-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`)
  else args.push('-o', 'ControlPath=none')
  if (target.port !== undefined) args.push('-p', String(target.port))
  if (target.options?.length) args.push(...target.options)
  args.push('--', target.destination, 'sh', '-s')
  return args
}

/** 验证没过时认出是哪一种:对方不收这把钥匙(改了配置 / 钥匙文件在别处 / 权限不对)还是压根没连上。 */
export function classifyVerifyFailure(stderr: string): 'not-accepted' | 'unreachable' {
  return /Permission denied|Too many authentication failures|Authentication failed|no more authentication methods/i.test(stderr)
    ? 'not-accepted'
    : 'unreachable'
}

export type GuguKeyDeps = {
  /** 放咕咕钥匙的目录(咕咕数据目录下的 ssh/)。 */
  dir: string
  /** 跑 ssh-keygen;找不到它 = 拒绝。 */
  keygen?: (args: string[]) => Promise<{ code: number | null; stderr: string }>
}

function defaultKeygen(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh-keygen', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < 16_384) stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

/**
 * 咕咕自己那把钥匙:有就用,没有就生成一把(ssh-keygen 自己按平台把私钥权限设对,Windows 上也一样)。
 * 私钥坏了 / 只剩一半:❌ 覆盖(那可能是别人正在用的东西)—— 如实失败。
 */
export async function ensureGuguKey(deps: GuguKeyDeps & { comment: string }): Promise<{ keyPath: string; publicKey: string }> {
  const keyPath = path.join(deps.dir, GUGU_KEY_FILE)
  const pubPath = `${keyPath}.pub`
  if (!fs.existsSync(keyPath) && !fs.existsSync(pubPath)) {
    fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
    const result = await (deps.keygen ?? defaultKeygen)(['-q', '-t', 'ed25519', '-N', '', '-C', deps.comment, '-f', keyPath])
    if (result.code !== 0) throw new Error(`ssh-keygen 失败:${result.stderr.trim()}`)
  }
  const publicKey = fs.readFileSync(pubPath, 'utf8').trim()
  if (!fs.existsSync(keyPath) || !parsePublicKey(publicKey)) throw new Error('咕咕的钥匙不完整')
  return { keyPath, publicKey }
}

/**
 * 装一次 + 验一次。只报结果,❌ 抛错:这件事做不成不影响这次已经用密码连上的那条连接。
 *  · spawnSsh 的环境里要有 askpass(复用不了连接时重新登录要答密码);
 *  · 结果 installed 才把钥匙关联到这台机器(调用方做)。
 */
export async function installGuguKey(options: {
  target: SshTarget
  controlPath: string | null
  spawnSsh: SpawnSsh
  key: GuguKeyDeps
  comment?: string
  timeoutMs?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}): Promise<SshKeyInstallOutcome & { keyPath?: string }> {
  const comment = options.comment ?? guguKeyComment()
  const log = options.log ?? (() => undefined)
  let key: { keyPath: string; publicKey: string }
  try {
    key = await ensureGuguKey({ ...options.key, comment })
  } catch (error) {
    log('生成咕咕的 SSH 钥匙失败', { err: error instanceof Error ? error.message : String(error) })
    return { status: 'failed', reason: 'no-key' }
  }
  const run = (args: string[], stdin: string) =>
    options.spawnSsh(args, { stdin, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) }).catch((error: unknown) => ({
      code: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }))

  const line = authorizedKeyLine(key.publicKey, comment)
  const installed = await run(installKeySshArgs(options.target, options.controlPath), installAuthorizedKeyScript(line))
  const wrote = parseInstallOutput(installed)
  if (wrote === 'write-failed') {
    log('那台机器的 authorized_keys 写不进去', { target: options.target.display })
    return { status: 'failed', reason: 'write-failed' }
  }
  if (wrote === 'unknown') {
    log('装钥匙那一步没连上', { target: options.target.display, code: installed.code, stderr: installed.stderr.slice(-500) })
    return { status: 'failed', reason: 'unreachable' }
  }
  const verified = await run(verifyKeySshArgs(options.target, key.keyPath), '')
  if (verified.code === 0) {
    log('咕咕的钥匙已装好并验证通过', { target: options.target.display, already: wrote === 'present' })
    return { status: 'installed', keyPath: key.keyPath }
  }
  const reason = classifyVerifyFailure(verified.stderr)
  log('钥匙装上了,但用它登不上', { target: options.target.display, reason, stderr: verified.stderr.slice(-500) })
  return { status: 'failed', reason }
}

/**
 * 真跑的那一份:装钥匙那一下复用不了已认证的连接时要重新登录,由一个只认密码提问的 askpass
 * 用人刚才答的那个密码答一次(别的提问 —— 验证码、指纹 —— 一律不答,装不上就如实报)。密码只在内存里过这一手。
 */
export async function installGuguKeyWithPassword(options: {
  target: SshTarget
  controlPath: string | null
  password: string
  keyDir: string
  log?: (message: string, detail?: Record<string, unknown>) => void
}): Promise<SshKeyInstallOutcome & { keyPath?: string }> {
  let answered = false
  const workspace = await openAskpassWorkspace(async ({ prompt, mode }) => {
    if (answered || describePrompt(prompt, mode).kind !== 'password') return null
    answered = true
    return options.password
  })
  try {
    return await installGuguKey({
      target: options.target,
      controlPath: options.controlPath,
      spawnSsh: systemSpawnSsh({ ...process.env, ...workspace.env }),
      key: { dir: options.keyDir },
      log: options.log,
    })
  } finally {
    await workspace.close()
  }
}

/** 咕咕钥匙放在哪:咕咕数据目录下的 ssh/(❌ ~/.ssh —— 那是用户自己的)。 */
export function guguKeyDir(userData: string): string {
  return path.join(userData || os.homedir(), 'ssh')
}
