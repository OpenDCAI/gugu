/**
 * #6264「从桌面用 SSH 一步装好」的纯逻辑:解析用户填的地址、读 ssh 配置、拼 ssh 参数与远端脚本、读远端输出。
 * 不碰进程与文件系统,全部可单测;真正 spawn ssh 的在 runner.ts / system.ts。
 *
 * 连法照 VS Code Remote-SSH / Zed:用**本机的 ssh 程序**,所以 ~/.ssh/config、密钥、ssh-agent、跳板机
 * 全都照本机来(behavior「连 SSH 用的是本机自己的 SSH 设置」)。❌ 自己实现 SSH 协议(ssh2)——那样
 * 用户配好的 ProxyJump / Match / 硬件密钥都要我们重新支持一遍。
 *
 * 远端脚本一律经 SSH 的**标准输入**喂给 `sh -s`,命令行上只有 `sh -s` 三个字:
 *  - 对方登录 shell 是 bash / zsh / fish / csh 都一样能解析,不用为各家 shell 的引号规则操心;
 *  - 登录凭证(device_code)只出现在标准输入里,由 sh 的内建 printf 递给 gugu-server,
 *    ❌ 不进任何进程的命令行参数(ps 看得见)、❌ 不进环境变量。
 */
import type {
  ServerSshInstallFailureReason,
  ServerSshInstallPrompt,
  ServerSshInstallWarning,
  SshConfigHost,
} from '../../../src/lib/serverSshInstall'
import type { DirectTerminalReason } from '../../../src/session/shared/direct-terminal-link'
import { MACHINE_LIMIT_ERROR, parseMachineLimitRefusal, type MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { serverProtocolTooOld } from '@gugu/core/cloud/serverMachineHealth'
import { isIpLikeLabel } from '@gugu/core/shared/ipLikeLabel'
import { isServerVersion } from '@gugu/core/cloud/serverDesktopVersions'
import { quoteShellArg } from '../../session/main/utils/shellEscape'
import { INCOMING_DIR, MATCH_MARK, versionManifestUrl } from '../server-account-versions'

// ── 用户填的地址 ───────────────────────────────────────────────────────────────

export type SshTarget = {
  /** 交给 ssh 的目的地:`别名`、`主机`、`用户@主机`。 */
  destination: string
  port?: number
  /** 给人看的一串(`用户@主机:端口`)。 */
  display: string
  /**
   * 从整条 `ssh …` 命令里带过来的连接选项(已按白名单校验、规范成 `-i x` / `-J x` / `-o K=V` / `-4`),
   * 原样放在目的地之前。只收「怎么连过去」的选项;能在本机执行命令的(ProxyCommand、LocalCommand、-F)一律不收。
   */
  options?: string[]
}

export type SshTargetProblem = { problem: 'invalid' | 'unsupportedOption' | 'command'; option?: string }

const HOST_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]*[A-Za-z0-9_])?$/
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const IPV6_RE = /^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?$/
/** `-J` 的跳板:`[用户@]主机[:端口]`,可逗号连多跳。 */
const JUMP_RE = /^[A-Za-z0-9_[][A-Za-z0-9_.@:%[\],-]*$/
// eslint-disable-next-line no-control-regex -- 就是要拒控制字符
const CONTROL_RE = /[\x00-\x1f\x7f]/

/**
 * `-o 键=值` 里收哪些键(不分大小写)。只收「怎么连过去」的;❌ ProxyCommand / LocalCommand /
 * PermitLocalCommand / KnownHostsCommand —— 它们会在**本机**执行任意命令,真需要的人写进 ~/.ssh/config。
 */
const SAFE_OPTION_KEYS = new Map(
  [
    'Port', 'User', 'HostName', 'IdentityFile', 'IdentitiesOnly', 'CertificateFile', 'ProxyJump', 'HostKeyAlias',
    'UserKnownHostsFile', 'CheckHostIP', 'PubkeyAuthentication', 'PasswordAuthentication',
    'KbdInteractiveAuthentication', 'PreferredAuthentications', 'AddKeysToAgent', 'IdentityAgent',
    'ServerAliveInterval', 'ServerAliveCountMax', 'ConnectTimeout', 'ConnectionAttempts', 'Compression',
    'AddressFamily', 'IPQoS', 'StrictHostKeyChecking', 'UpdateHostKeys',
  ].map((key) => [key.toLowerCase(), key]),
)
/** 带一个参数、与装机无关、直接丢掉的选项(端口转发之类)。 */
const IGNORED_WITH_VALUE = new Set(['L', 'R', 'D', 'W', 'w', 'e', 'm', 'c', 'b', 'B', 'E', 'O', 'Q', 'S'])
/** 不带参数、与装机无关、直接丢掉的开关。 */
const IGNORED_FLAGS = new Set(['A', 'a', 'f', 'G', 'g', 'K', 'k', 'M', 'N', 'n', 'q', 's', 'T', 't', 'V', 'v', 'X', 'x', 'Y', 'y'])
/** 不带参数、要带给 ssh 的开关。 */
const KEPT_FLAGS = new Set(['4', '6', 'C'])

/** 把一行拆成词:认单双引号(粘过来的命令里 `-i "~/My Keys/id"` 很常见),不认 shell 的其他语法。 */
function tokenize(text: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let inToken = false
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
    } else if (ch === ' ' || ch === '\t') {
      if (inToken) tokens.push(current)
      current = ''
      inToken = false
    } else {
      current += ch
      inToken = true
    }
  }
  if (quote) return null
  if (inToken) tokens.push(current)
  return tokens
}

function parseDestination(text: string): { user?: string; host: string; port?: number } | null {
  if (!text || text.startsWith('-')) return null
  let rest = text.startsWith('ssh://') ? text.slice('ssh://'.length).replace(/\/$/, '') : text
  let user: string | undefined
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
    if (!USER_RE.test(user)) return null
  }
  let host: string
  let port: number | undefined
  const bracket = rest.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (bracket) {
    host = bracket[1]
    if (!IPV6_RE.test(host)) return null
    if (bracket[2]) port = Number(bracket[2])
  } else {
    const colon = rest.match(/^([^:]+):(\d+)$/)
    if (colon) {
      host = colon[1]
      port = Number(colon[2])
    } else {
      host = rest
    }
    if (!HOST_RE.test(host)) return null
  }
  return { user, host, port }
}

const validPort = (port: number | undefined) => port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65535)

/**
 * 认 `别名`、`主机`、`用户@主机`、`用户@主机:端口`、`用户@[IPv6]:端口`、`ssh://用户@主机:端口`,
 * 也认从别处整条粘过来的 `ssh -p 2222 -i ~/.ssh/k -J jump 用户@主机`(VS Code / Zed 同样认)。
 *
 * 安全:目的地不许以 `-` 开头、不许有空白与控制字符 —— 它最后是 ssh 的一个参数,
 * 以 `-` 开头会被当成选项(`-oProxyCommand=…` 就能在本机执行任意命令)。拼参数时另有 `--` 兜底;
 * 整条命令里的选项按白名单收,能在本机执行命令的一律拒绝并说出是哪一个。
 */
export function parseSshCommand(input: string): SshTarget | SshTargetProblem {
  const text = input.trim()
  if (!text || CONTROL_RE.test(text)) return { problem: 'invalid' }
  const tokens = tokenize(text)
  if (!tokens || tokens.length === 0) return { problem: 'invalid' }
  if (tokens[0] === 'ssh') tokens.shift()

  const options: string[] = []
  let destination: string | null = null
  let port: number | undefined
  let loginUser: string | undefined

  const takeValue = (index: number, inline: string): { value: string; next: number } | null => {
    if (inline) return { value: inline, next: index }
    const value = tokens[index + 1]
    return value === undefined ? null : { value, next: index + 1 }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (destination !== null) return { problem: 'command' }
    if (!token.startsWith('-') || token === '-') {
      destination = token
      continue
    }
    if (token === '--') {
      const rest = tokens.slice(i + 1)
      if (rest.length !== 1) return rest.length === 0 ? { problem: 'invalid' } : { problem: 'command' }
      destination = rest[0]
      break
    }
    const flag = token[1]
    const inline = token.slice(2)
    if (flag === 'p' || flag === 'l' || flag === 'i' || flag === 'J' || flag === 'o' || IGNORED_WITH_VALUE.has(flag)) {
      const taken = takeValue(i, inline)
      if (!taken) return { problem: 'invalid' }
      i = taken.next
      const value = taken.value
      if (CONTROL_RE.test(value)) return { problem: 'invalid' }
      if (flag === 'p') {
        if (!/^\d+$/.test(value)) return { problem: 'invalid' }
        port = Number(value)
      } else if (flag === 'l') {
        if (!USER_RE.test(value)) return { problem: 'invalid' }
        loginUser = value
      } else if (flag === 'i') {
        if (!value || value.startsWith('-')) return { problem: 'invalid' }
        options.push('-i', value)
      } else if (flag === 'J') {
        if (!JUMP_RE.test(value)) return { problem: 'invalid' }
        options.push('-J', value)
      } else if (flag === 'o') {
        const kv = value.match(/^([A-Za-z]+)\s*(?:=\s*|\s+)(.+)$/)
        if (!kv) return { problem: 'invalid' }
        const key = SAFE_OPTION_KEYS.get(kv[1].toLowerCase())
        if (!key) return { problem: 'unsupportedOption', option: kv[1] }
        const optionValue = kv[2].trim()
        if (key === 'Port') {
          if (!/^\d+$/.test(optionValue)) return { problem: 'invalid' }
          port = Number(optionValue)
        } else if (key === 'User') {
          if (!USER_RE.test(optionValue)) return { problem: 'invalid' }
          loginUser = optionValue
        } else {
          options.push('-o', `${key}=${optionValue}`)
        }
      }
      // IGNORED_WITH_VALUE:端口转发等与装机无关,连值一起丢掉。
      continue
    }
    // 一串开关(`-4C`、`-tt`)。
    for (const ch of token.slice(1)) {
      if (KEPT_FLAGS.has(ch)) {
        if (!options.includes(`-${ch}`)) options.push(`-${ch}`)
      } else if (!IGNORED_FLAGS.has(ch)) {
        return { problem: 'unsupportedOption', option: `-${ch}` }
      }
    }
  }

  if (destination === null) return { problem: 'invalid' }
  const parsed = parseDestination(destination)
  if (!parsed) return { problem: 'invalid' }
  // 地址里写的端口优先于 -p(`host:2222` 不是 ssh 自己的语法,是我们认的简写,写了就是这个意思)。
  const finalPort = parsed.port ?? port
  if (!validPort(finalPort)) return { problem: 'invalid' }
  const user = parsed.user ?? loginUser
  const hostPart = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host
  // ssh 的目的地里 IPv6 不带方括号(`user@::1`),端口一律走 -p。
  const target: SshTarget = {
    destination: user ? `${user}@${parsed.host}` : parsed.host,
    port: finalPort,
    display: `${user ? `${user}@` : ''}${hostPart}${finalPort !== undefined ? `:${finalPort}` : ''}`,
  }
  if (options.length) target.options = options
  return target
}

/**
 * 存过盘又读回来的连接选项(ssh-machines.json)再过一遍同一张白名单:这份文件被改过也 ❌ 能塞进 ProxyCommand。
 * 形状只认 parseSshCommand 规范出来的那几种。
 */
export function isSafeSshOptionList(options: readonly unknown[]): boolean {
  for (let i = 0; i < options.length; i += 1) {
    const flag = options[i]
    if (typeof flag !== 'string') return false
    if (flag === '-4' || flag === '-6' || flag === '-C') continue
    const value = options[i + 1]
    if (typeof value !== 'string' || CONTROL_RE.test(value) || !value) return false
    i += 1
    if (flag === '-i') {
      if (value.startsWith('-')) return false
    } else if (flag === '-J') {
      if (!JUMP_RE.test(value)) return false
    } else if (flag === '-o') {
      const key = value.match(/^([A-Za-z]+)=/)?.[1]
      const known = key ? SAFE_OPTION_KEYS.get(key.toLowerCase()) : undefined
      if (!known || known !== key || key === 'Port' || key === 'User') return false
    } else {
      return false
    }
  }
  return true
}

/** 只要一个能用的目的地;看不懂就是 null。 */
export function parseSshTarget(input: string): SshTarget | null {
  const parsed = parseSshCommand(input)
  return 'problem' in parsed ? null : parsed
}

// ── ~/.ssh/config ─────────────────────────────────────────────────────────────

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/** 一行 `Key value` / `Key=value`;ssh_config 的关键字不分大小写。 */
function splitDirective(line: string): [string, string] | null {
  const match = line.match(/^([A-Za-z]+)\s*(?:=\s*|\s+)(.+)$/)
  return match ? [match[1].toLowerCase(), match[2].trim()] : null
}

/** 从 `Include` 那一行取出各个路径模式(已去引号)。 */
export function includePatterns(line: string): string[] | null {
  const directive = splitDirective(line.trim())
  if (!directive || directive[0] !== 'include') return null
  return (directive[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(stripQuotes)
}

/**
 * 列出配好的具体主机别名,给「从本机 SSH 配置里挑」用。尽力而为:只为了列名字和一行说明,
 * 真正连的时候一切以 ssh 自己解析为准(所以 Match、通配、变量展开这里都不管)。
 * 含 `*` / `?` / `!` 的模式不是一台机器,不列;`Match` 块里的设置不归前一个 Host。
 */
export function parseSshConfigHosts(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  const seen = new Set<string>()
  let current: SshConfigHost[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const directive = splitDirective(line)
    if (!directive) continue
    const [key, value] = directive
    if (key === 'host') {
      current = []
      for (const alias of (value.match(/"[^"]*"|\S+/g) ?? []).map(stripQuotes)) {
        if (!alias || /[*?!]/.test(alias)) continue
        if (seen.has(alias)) continue
        seen.add(alias)
        const host: SshConfigHost = { alias }
        hosts.push(host)
        current.push(host)
      }
      continue
    }
    if (key === 'match') {
      current = []
      continue
    }
    // 同一个关键字 ssh 只认第一次出现的值,这里同样只记第一次。
    for (const host of current) {
      if (key === 'hostname' && host.hostname === undefined) host.hostname = stripQuotes(value)
      else if (key === 'user' && host.user === undefined) host.user = stripQuotes(value)
      else if (key === 'port' && host.port === undefined && /^\d+$/.test(value)) host.port = Number(value)
    }
  }
  return hosts
}

// ── ssh 参数 ───────────────────────────────────────────────────────────────────

/**
 * #6264 一台机器一条认证过的连接,咕咕开着就一直在(照 VS Code Remote-SSH:一个窗口连一台机器只认证一次,
 * 之后的终端、文件、端口转发都走这条连接)。所以复用连接不设空闲超时(ControlPersist=yes):
 * 以前的 600 秒让人离开十分钟、或重开咕咕之后,再开一个终端又要输一遍密码。
 * 收掉它的是咕咕自己:退出时、机器被移除时(见 ssh-machines.ts 的 closeSshMasters / closeMachineMaster);
 * 网断了它自己会死(心跳),下次用时重新认证一次。
 */
export const SHARED_CONTROL_PERSIST = 'yes'

/** 第一次连接(握手 + 认证 + 看一眼系统)最多等多久;等人回答提问的时间不算(Zed / JetBrains 都是 60 秒)。 */
export const CONNECT_TIMEOUT_MS = 60_000

/**
 * 拼一次 ssh 调用的参数。每一步(探测、下载、注册、登录)各是一次 ssh,靠 ControlMaster 复用
 * **同一条连接**:密码只问一次;有的集群每次登录随机落到不同节点,复用连接保证几步落在同一台机器上。
 * Windows 自带的 OpenSSH 不支持 ControlMaster,那里不开(每步各连一次,要密码时会多问几次)。
 *
 * `LogLevel=VERBOSE`:让 ssh 在认证通过时打一行「Authenticated to …」—— 界面据此把「连接」与「识别系统」
 * 分开亮,卡住时也分得清是没连上、还是连上之后被对方的登录脚本拖住;这些输出都进「查看详情」。
 *
 * ❌ 不关主机指纹检查(StrictHostKeyChecking=no):第一次连的机器由 ssh 自己经 askpass 问人确认指纹。
 */
export function buildSshArgs(
  target: SshTarget,
  options: {
    controlPath?: string | null
    remoteCommand?: string
    /** 复用连接收尾后留多久:装机自己的临时连接 120 秒;用的是这台机器那条共享连接时一直留着(SHARED_CONTROL_PERSIST)。 */
    persist?: string
    /** 后台自己发起的(版本太旧时替它升级):没有人可问,要密码 = 此刻走不通,❌ 挂着等。 */
    batch?: boolean
  },
): string[] {
  const args = [
    '-T',
    ...(options.batch ? ['-o', 'BatchMode=yes'] : []),
    '-o', 'ConnectTimeout=20',
    // 心跳:每 5 秒问一声,连着 3 声没回就判断线(约 15 秒,对齐 VS Code 的 5s 心跳 / 20s 超时)——
    // 这条主连接也被直连终端复用;睡眠醒来、换 Wi-Fi 之后要靠它尽快发现链路已经死了,再由桌面自动重连。
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=VERBOSE',
  ]
  if (options.controlPath) {
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${options.controlPath}`, '-o', `ControlPersist=${options.persist ?? '120'}`)
  }
  if (target.port !== undefined) args.push('-p', String(target.port))
  if (target.options?.length) args.push(...target.options)
  // `--` 之后才是目的地:即便地址校验漏了什么,它也不可能再被当成 ssh 的选项。
  args.push('--', target.destination)
  if (options.remoteCommand) args.push(options.remoteCommand)
  else args.push('sh', '-s')
  return args
}

// ── SSH 的提问 ─────────────────────────────────────────────────────────────────

/**
 * 把 ssh 经 askpass 问的一句话认成界面上的一种提问。`mode` 是 ssh 给 askpass 的 SSH_ASKPASS_PROMPT:
 * `none` = 只是提醒人去做件事(碰一下安全密钥),ssh 不等回答。`home` 用来把密钥路径缩成 `~/…`。
 */
export function describePrompt(message: string, mode = '', home = ''): Omit<ServerSshInstallPrompt, 'id' | 'retry'> {
  const firstLine = message.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
  const lastLine = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() ?? ''
  if (mode === 'none') return { kind: 'notice', message, label: firstLine }
  if (/continue connecting|\(yes\/no|Please type 'yes', 'no'/i.test(message)) {
    const host = message.match(/authenticity of host '([^']+)'/)?.[1]?.replace(/\s*\(.*\)$/, '') ?? ''
    const key = message.match(/(\S+) key fingerprint is:?\s*(\S+?)\.?\s*$/m)
    return {
      kind: 'hostKey',
      message,
      ...(host || key ? { hostKey: { host, keyType: key?.[1] ?? '', fingerprint: key?.[2] ?? '' } } : {}),
    }
  }
  const passphrase = message.match(/passphrase for (?:key )?'([^']+)'/i)
  if (passphrase) {
    const file = home && passphrase[1].startsWith(`${home}/`) ? `~${passphrase[1].slice(home.length)}` : passphrase[1]
    return { kind: 'passphrase', message, subject: file }
  }
  const password = lastLine.match(/^(?:\(([^)]+)\)\s*)?(?:(\S+?)'s\s+)?password:?\s*$/i)
  if (password && (password[1] || password[2] || /^password/i.test(lastLine))) {
    return { kind: 'password', message, ...(password[1] || password[2] ? { subject: password[1] ?? password[2] } : {}) }
  }
  return { kind: 'otp', message, label: lastLine || firstLine }
}

// ── 远端脚本(经标准输入喂给 sh -s)──────────────────────────────────────────────


export const PROBE_BEGIN = '__GUGU_PROBE_BEGIN__'
export const PROBE_END = '__GUGU_PROBE_END__'
/** 与 electron/server/server-login.ts 同名常量一致;那边打、这边读。 */
export const LOGIN_RESULT_MARK = '__GUGU_LOGIN_RESULT__'
export const LOGIN_ERROR_MARK = '__GUGU_LOGIN_ERROR__'
/** 下载脚本打给桌面看的机器可读行。 */
export const BYTES_MARK = '__GUGU_BYTES__'
export const TOTAL_MARK = '__GUGU_TOTAL__'
export const MANIFEST_MARK = '__GUGU_MANIFEST__'
export const NO_INTERNET_MARK = '__GUGU_NO_INTERNET__'
const ALIVE_MARK = '__GUGU_ALIVE__'
/** 下载脚本连不上下载站时的退出码(桌面据此改走「本机下载后传过去」)。 */
export const NO_INTERNET_EXIT = 3

const SERVER_BIN = '"$HOME/.local/bin/gugu-server"'
const SERVER_HOME = '"${GUGU_SERVER_HOME:-$HOME/.gugu-server}"'
/** 本机下载好的包经 SSH 传到那台机器上的落点(相对家目录,登录 shell 的起点就是家目录)。 */
export const UPLOAD_FILE = '.gugu-server-upload.tar.gz'

/** 咕咕 server 带的 Node 官方构建要求 glibc ≥ 2.28(Debian 10 / Ubuntu 18.10 / RHEL 8 起)。 */
export const MIN_GLIBC: readonly [number, number] = [2, 28]
/** 装一次要的空间:包约 110MB,解开约 350MB,下载(或传过来的包及其副本)与解包同时在盘上。 */
export const MIN_FREE_KB = 700 * 1024

/**
 * 第一步:连上去看一眼。输出夹在两行标记之间 —— 对方的 .bashrc 往 stdout 打字也不会混进来。
 * `grant=1` 表示已装的 gugu-server 认得 `login --grant-stdin`(太旧的就得先升级)。
 * 同时看清会不会装到一半才失败的几件事:C 库、家目录能不能写、能不能执行、还剩多少空间;以及这台机器上已经登着谁。
 */
export function probeScript(): string {
  return [
    `echo ${PROBE_BEGIN}`,
    'echo "os=$(uname -s 2>/dev/null)"',
    'echo "arch=$(uname -m 2>/dev/null)"',
    'echo "user=$(id -un 2>/dev/null)"',
    'echo "hostname=$(hostname 2>/dev/null || uname -n 2>/dev/null)"',
    'if [ "$(uname -s 2>/dev/null)" = Darwin ]; then',
    '  echo "distro=macOS $(sw_vers -productVersion 2>/dev/null)"',
    'else',
    '  ( . /etc/os-release 2>/dev/null; echo "distro=${PRETTY_NAME:-$NAME}" )',
    '  L="$(getconf GNU_LIBC_VERSION 2>/dev/null)"',
    '  if [ -z "$L" ] && { ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; }; then L=musl; fi',
    '  echo "libc=$L"',
    'fi',
    `H=${SERVER_HOME}`,
    `B=${SERVER_BIN}`,
    'if [ -x "$B" ]; then',
    '  echo "installed=$(cat "$H/current/version" 2>/dev/null || echo unknown)"',
    '  if "$B" help 2>/dev/null | grep -q -- "--grant-stdin"; then echo grant=1; fi',
    // #6264 认得 match-version = 每个账号能各跑各的版本(换版只重启那一个账号);不认得的老 server 只能整台换。
    '  if "$B" help 2>/dev/null | grep -q -- "match-version"; then echo match=1; fi',
    // 这份说哪一版桌面↔server 协议。分清三种:报出来了 / 老版本明确不认这条命令(退出码 2 + 「不认识的命令」)/
    // 其它失败(崩溃、超时、权限)—— 只有前两种能判「太旧」,第三种照实报失败,❌ 当太旧去重装(installedServerTooOld)。
    '  if command -v timeout >/dev/null 2>&1; then PO="$(timeout 20 "$B" protocol 2>&1)"; else PO="$("$B" protocol 2>&1)"; fi',
    '  PC=$?',
    '  echo "protocol_exit=$PC"',
    // 标准错误合在一起(分开要落临时文件):取最后一行纯数字,前面的告警行不碍事。
    '  if [ "$PC" = 0 ]; then echo "protocol=$(printf \'%s\\n\' "$PO" | tr -d \'\\r\' | grep -E \'^[0-9]+$\' | tail -n 1)"; fi',
    `  if [ "$PC" = 2 ] && printf '%s' "$PO" | grep -qF '${unknownCommandLine('protocol')}'; then echo protocol_unknown=1; fi`,
    '  echo "protocol_err=$(printf \'%s\\n\' "$PO" | tail -n 1 | tr -d \'\\r\' | cut -c1-200)"',
    'fi',
    'P="$(cat "$H/data/server.lock" 2>/dev/null)"',
    'if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then echo running=1; fi',
    'for d in "$H"/accounts/*/; do',
    '  [ -f "${d}data/server-session.enc" ] || continue',
    '  e="$(sed -n \'s/.*"email": *"\\([^"]*\\)".*/\\1/p\' "${d}account.json" 2>/dev/null | head -n 1)"',
    '  echo "account=$(basename "$d") $e"',
    'done',
    'if command -v curl >/dev/null 2>&1; then echo fetcher=curl; elif command -v wget >/dev/null 2>&1; then echo fetcher=wget; fi',
    'echo "freekb=$(df -Pk "$HOME" 2>/dev/null | awk \'NR==2{print $4}\')"',
    'X="$HOME/.gugu-exec-test.$$"',
    "if printf '#!/bin/sh\\necho ok\\n' > \"$X\" 2>/dev/null; then",
    '  chmod 700 "$X" 2>/dev/null',
    '  if [ "$("$X" 2>/dev/null)" = ok ]; then echo exec=1; else echo exec=0; fi',
    '  rm -f "$X"',
    'else',
    '  echo writable=0',
    'fi',
    `echo ${PROBE_END}`,
    '',
  ].join('\n')
}

export type ProbeResult = {
  os: string
  arch: string
  user: string
  hostname: string
  distro: string
  libc: string
  installedVersion: string | null
  supportsGrant: boolean
  /** 装着的那份认得 `match-version`(每个账号各跑各的版本)。 */
  supportsMatch: boolean
  /** 装着的那份说的桌面↔server 协议版本;没报出来(不认这条命令 / 命令失败 / 没装)= null。 */
  installedProtocol: number | null
  /**
   * 问装着的那份「说哪一版协议」的结果:ok = 报出来了;unknownCommand = 老版本明确不认这条命令(版本信号);
   * failed = 别的失败(崩溃、超时、权限、答非所问 —— ❌ 版本信号);没装 = null。
   */
  protocolCheck: 'ok' | 'unknownCommand' | 'failed' | null
  /** protocolCheck 为 failed 时:退出码与那条命令最后一行输出(只进详情)。 */
  protocolError: string | null
  running: boolean
  fetcher: 'curl' | 'wget' | null
  /** 家目录所在盘还剩多少 KB;读不到为 null。 */
  freeKb: number | null
  writable: boolean
  /** 家目录里能不能执行程序(noexec 挂载时不能);没测成为 null。 */
  exec: boolean | null
  accounts: Array<{ userId: string; email: string | null }>
}

export function parseProbeOutput(stdout: string): ProbeResult | null {
  const begin = stdout.lastIndexOf(PROBE_BEGIN)
  const end = stdout.indexOf(PROBE_END, begin)
  if (begin < 0 || end < 0) return null
  const fields = new Map<string, string>()
  const accounts: ProbeResult['accounts'] = []
  for (const line of stdout.slice(begin + PROBE_BEGIN.length, end).split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'account') {
      const [userId, ...rest] = value.split(' ')
      if (/^[A-Za-z0-9_-]{1,128}$/.test(userId)) accounts.push({ userId, email: rest.join(' ').trim() || null })
      continue
    }
    fields.set(key, value)
  }
  const fetcher = fields.get('fetcher')
  const freeKb = Number(fields.get('freekb'))
  const installedProtocol = /^\d{1,6}$/.test(fields.get('protocol') ?? '') ? Number(fields.get('protocol')) : null
  const protocolCheck: ProbeResult['protocolCheck'] = !fields.get('installed')
    ? null
    : installedProtocol !== null
      ? 'ok'
      : fields.get('protocol_unknown') === '1'
        ? 'unknownCommand'
        : 'failed'
  const exec = fields.get('exec')
  return {
    os: fields.get('os') ?? '',
    arch: fields.get('arch') ?? '',
    user: fields.get('user') ?? '',
    hostname: fields.get('hostname') ?? '',
    distro: fields.get('distro') ?? '',
    libc: fields.get('libc') ?? '',
    installedVersion: fields.get('installed') || null,
    supportsGrant: fields.get('grant') === '1',
    supportsMatch: fields.get('match') === '1',
    installedProtocol,
    protocolCheck,
    protocolError: protocolCheck === 'failed' ? `exit ${fields.get('protocol_exit') ?? '?'}: ${fields.get('protocol_err') ?? ''}`.trim() : null,
    running: fields.get('running') === '1',
    fetcher: fetcher === 'curl' || fetcher === 'wget' ? fetcher : null,
    freeKb: fields.get('freekb') && Number.isFinite(freeKb) ? freeKb : null,
    writable: fields.get('writable') !== '0',
    exec: exec === '1' ? true : exec === '0' ? false : null,
    accounts,
  }
}

/**
 * 与 electron/server-entry.ts 对不认识的命令打的那一句逐字相同(退出码 2):老版本据此明确说「我不认这条命令」。
 */
export function unknownCommandLine(command: string): string {
  return `不认识的命令:${command}`
}

/**
 * 装着的那份太旧、这台桌面跟它说不上话(与设备行上「版本太旧」同一个判据,见 serverProtocolTooOld):
 * 装机时照常下载安装并当场切过去,❌ 以「已经装过」跳过、留一个连不上的旧 server。没装 = false(本来就要装)。
 * 只认明确的版本信号(owner 2026-09-25:「升级只能是因为版本问题」):老版本明确不认 `protocol` 这条命令,
 * 或报出的协议号低于这台桌面要求的。那条命令崩溃 / 超时 / 没权限 ❌ 算太旧(见 installedProtocolUnreadable)。
 */
export function installedServerTooOld(probe: Pick<ProbeResult, 'installedVersion' | 'installedProtocol' | 'protocolCheck'>): boolean {
  if (!probe.installedVersion) return false
  if (probe.protocolCheck === 'unknownCommand') return true
  return serverProtocolTooOld(probe.installedProtocol, { unknownIsTooOld: false })
}

/**
 * 装着一份、却问不出它说哪一版协议(那条命令崩溃 / 超时 / 没权限,不是「不认识」):照实报失败,
 * ❌ 当太旧去重装(那只会在一台本来好好的机器上盖掉正在用的版本)。
 */
export function installedProtocolUnreadable(probe: Pick<ProbeResult, 'installedVersion' | 'protocolCheck'>): boolean {
  return !!probe.installedVersion && probe.protocolCheck === 'failed'
}

/** `glibc 2.35` → [2, 35];musl / 读不到 → null。 */
export function glibcVersion(libc: string): [number, number] | null {
  const match = libc.match(/glibc\s+(\d+)\.(\d+)/i)
  return match ? [Number(match[1]), Number(match[2])] : null
}

/**
 * 连上之后当场能判定「装不上」的几件事,按先后:系统 → 架构 → C 库 → 家目录不可写 → 不能执行。
 * 与一行安装脚本(scripts/gugu-server/install.sh)支持的系统一致;❌ 装到一半才失败。
 */
export function unsupportedPlatform(
  probe: ProbeResult,
): 'unsupportedOs' | 'unsupportedArch' | 'unsupportedLibc' | 'noPermission' | 'noExec' | null {
  if (probe.os !== 'Linux' && probe.os !== 'Darwin') return 'unsupportedOs'
  if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(probe.arch)) return 'unsupportedArch'
  if (probe.os === 'Linux') {
    if (/musl/i.test(probe.libc)) return 'unsupportedLibc'
    const glibc = glibcVersion(probe.libc)
    if (glibc && (glibc[0] < MIN_GLIBC[0] || (glibc[0] === MIN_GLIBC[0] && glibc[1] < MIN_GLIBC[1]))) return 'unsupportedLibc'
  }
  if (!probe.writable) return 'noPermission'
  if (probe.exec === false) return 'noExec'
  return null
}

export function platformFromUname(os: string): string {
  return os === 'Darwin' ? 'darwin' : os === 'Linux' ? 'linux' : os.toLowerCase()
}

export function archFromUname(arch: string): string {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64'
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64'
  return arch
}

/** 那台机器在下载站上对应的版本清单:`<根>/<通道>/<系统>-<架构>.txt`(与 install.sh 读的同一个)。 */
export function manifestUrl(base: string, channel: string, probe: Pick<ProbeResult, 'os' | 'arch'>): string {
  return `${base}/${channel}/${platformFromUname(probe.os)}-${archFromUname(probe.arch)}.txt`
}

/**
 * 这个通道的安装脚本:`<根>/<通道>/install.sh`。Beta 与正式版各发各的(publish-oss.cjs),
 * ❌ 共用根目录那一份:Beta 桌面走在正式版前面,拿正式版的脚本可能不认它传的参数;反过来 Beta 发版也不许顶掉正式用户的脚本。
 */
export function installScriptUrl(base: string, channel: string): string {
  return `${base}/${channel}/install.sh`
}

/** 某一版的清单(钉在这一版上):`<根>/<版本>/<系统>-<架构>.txt`。 */
export function versionedManifestUrl(base: string, version: string, probe: Pick<ProbeResult, 'os' | 'arch'>): string {
  return versionManifestUrl(base, version, `${platformFromUname(probe.os)}-${archFromUname(probe.arch)}`)
}

/**
 * 第三步(那台机器能上网时):在那台机器上下载并装好。跑的就是一行命令装用的**同一份** install.sh,
 * 只是关掉它自带的注册与登录 —— 那两步由桌面分开跑,好给出各自的进度与失败原因。
 *
 *  - 先用短超时摸一下下载站:连不上(内网机器、没配代理)就以 NO_INTERNET_EXIT 退出,桌面改走本机下载后传过去,
 *    ❌ 让 install.sh 的 curl 在黑洞地址上重试好几分钟;
 *  - 把版本清单与包的大小先报出来,界面才能写「咕咕 server 0.2.99 · 23 / 105 MB」;
 *  - install.sh 放后台跑,另起一个小循环每秒报一次下载了多少字节(读它正在写的那个临时文件);
 *    桌面一取消 ssh 就断,循环写不出去,顺手把 install.sh 停掉 —— ❌ 在看不见的地方继续下。
 */
export function installScript(options: {
  installUrl: string
  manifestUrl: string
  channel: string
  downloadBase?: string | null
}): string {
  const env = options.downloadBase ? `GUGU_SERVER_DOWNLOAD_BASE=${quoteShellArg(options.downloadBase)} ` : ''
  return [
    `U=${quoteShellArg(options.installUrl)}`,
    `M=${quoteShellArg(options.manifestUrl)}`,
    `H=${SERVER_HOME}`,
    'if command -v curl >/dev/null 2>&1; then',
    '  manifest() { curl -fsS --connect-timeout 8 --max-time 20 "$1"; }',
    '  pkgsize() { curl -fsSI --connect-timeout 8 --max-time 20 "$1" 2>/dev/null | tr -d \'\\r\' | awk \'tolower($1)=="content-length:"{n=$2} END{if(n)print n}\'; }',
    '  fetch() { curl -fsSL --connect-timeout 15 --retry 3 -o "$2" "$1"; }',
    'elif command -v wget >/dev/null 2>&1; then',
    '  manifest() { wget -q -T 15 -t 1 -O - "$1"; }',
    '  pkgsize() { :; }',
    '  fetch() { wget -q -T 30 -O "$2" "$1"; }',
    'else echo "安装失败:需要 curl 或 wget 其中之一" >&2; exit 1; fi',
    `MAN="$(manifest "$M")" || { echo ${NO_INTERNET_MARK}; exit ${NO_INTERNET_EXIT}; }`,
    `echo "${MANIFEST_MARK} $MAN"`,
    'Z="$(pkgsize "$(printf \'%s\' "$MAN" | awk \'{print $3}\')")"',
    `[ -n "$Z" ] && echo "${TOTAL_MARK} $Z"`,
    'T="$(mktemp "${TMPDIR:-/tmp}/gugu-server-install.XXXXXX")" || { echo "安装失败:建不了临时文件" >&2; exit 1; }',
    'fetch "$U" "$T" || { rm -f "$T"; echo "安装失败:下载安装脚本失败($U)" >&2; exit 1; }',
    `${env}sh "$T" --channel ${quoteShellArg(options.channel)} --no-service --no-login </dev/null &`,
    'P=$!',
    "trap 'kill $P 2>/dev/null; rm -f \"$T\"' EXIT",
    "trap 'exit 1' HUP INT TERM",
    '(',
    "  trap '' PIPE",
    '  while kill -0 $P 2>/dev/null; do',
    '    f="$(ls "$H"/versions/.download.*/pkg.tar.gz 2>/dev/null | head -n 1)"',
    `    if [ -n "$f" ]; then L="${BYTES_MARK} $(wc -c < "$f" | tr -d ' ')"; else L=${ALIVE_MARK}; fi`,
    '    echo "$L" 2>/dev/null || { kill $P 2>/dev/null; exit 0; }',
    '    sleep 1',
    '  done',
    ') &',
    'wait $P',
    'C=$?',
    'exit $C',
    '',
  ].join('\n')
}

/**
 * 第三步(那台机器上不了网时):本机下好的包先经 SSH 原样传过去(`cat > 文件`,登录 shell 是哪一种都认这个写法),
 * 再用这段脚本装 —— 同一份 install.sh(本机从下载站取来、经 here-doc 带过去),换成「用这个包」的模式。
 */
export function uploadCommand(): string {
  return `cat > ${UPLOAD_FILE}`
}

export function installFromUploadScript(options: {
  installSh: string
  channel: string
  version: string
  sha256: string
}): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.version)) throw new Error('版本号格式不对')
  if (!/^[0-9a-f]{64}$/.test(options.sha256)) throw new Error('校验值格式不对')
  const delimiter = '__GUGU_INSTALL_SH_EOF__'
  if (options.installSh.split(/\r?\n/).includes(delimiter)) throw new Error('安装脚本里含有分隔行')
  return [
    `PKG="$HOME/${UPLOAD_FILE}"`,
    'T="$(mktemp "${TMPDIR:-/tmp}/gugu-server-install.XXXXXX")" || { echo "安装失败:建不了临时文件" >&2; exit 1; }',
    "trap 'rm -f \"$T\" \"$PKG\"' EXIT",
    "trap 'exit 1' HUP INT TERM",
    `cat > "$T" <<'${delimiter}'`,
    options.installSh.replace(/\s*$/, ''),
    delimiter,
    `sh "$T" --channel ${quoteShellArg(options.channel)} --package "$PKG" --version ${quoteShellArg(options.version)} --sha256 ${quoteShellArg(options.sha256)} --no-service --no-login </dev/null`,
    '',
  ].join('\n')
}

/** 连不上 SSH 时给人自己敲的那一行(与 install.sh 抬头写的同一条)。 */
export function oneLineInstallCommand(downloadBase: string, channel: string, fetcher: 'curl' | 'wget' = 'curl'): string {
  const pipe = channel === 'stable' ? 'sh' : `sh -s -- --channel ${channel}`
  return fetcher === 'wget'
    ? `wget -qO- ${downloadBase}/install.sh | ${pipe}`
    : `curl -fsSL ${downloadBase}/install.sh | ${pipe}`
}

// ── #6264 换成和这台桌面匹配的那一版(那台机器认得 match-version 时)─────────────────────────

const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,128}$/
const DESKTOP_RE = /^[A-Za-z0-9:_-]{1,128}$/

/** 报这台桌面是哪一版、问这个账号的目标版本(同一账号几台桌面取最新)。 */
export function matchReportScript(options: { accountUserId: string; desktopId: string; version: string; protocol: number }): string {
  if (!ACCOUNT_RE.test(options.accountUserId) || !DESKTOP_RE.test(options.desktopId) || !isServerVersion(options.version)) {
    throw new Error('账号 / 桌面 / 版本的形状不对')
  }
  return `${SERVER_BIN} match-version --account ${options.accountUserId} --desktop ${options.desktopId} --version ${options.version} --protocol ${Math.max(0, Math.floor(options.protocol))} </dev/null\n`
}

/**
 * 请守护进程把这一个账号换到这一版,等它真的换过去。没装由它自己装(下载,或用 incomingUploadCommand 放进去的包),
 * 桌面 ❌ 再装一份:换版装东西的只有那台机器上的守护进程(server-account-converge.ts)。
 */
export function matchApplyScript(options: { accountUserId: string; version: string; now?: boolean }): string {
  if (!ACCOUNT_RE.test(options.accountUserId) || !isServerVersion(options.version)) throw new Error('账号 / 版本的形状不对')
  return `${SERVER_BIN} match-version --account ${options.accountUserId} --apply ${options.version}${options.now ? ' --now' : ''} </dev/null\n`
}

/**
 * 连不上下载站的机器:本机下好的包经 SSH 放进那台机器的 `versions/.incoming/<版本>.tar.gz`(server-account-versions.ts
 * incomingPackage),守护进程装它而 ❌ 下载。包先写成 `.part`,写完才改名。
 */
export function incomingUploadCommand(version: string): string {
  if (!isServerVersion(version)) throw new Error('版本号格式不对')
  const dir = `${SERVER_HOME}/versions/${INCOMING_DIR}`
  return `mkdir -p ${dir} && cat > ${dir}/${version}.tar.gz.part && mv ${dir}/${version}.tar.gz.part ${dir}/${version}.tar.gz`
}

/** 再写那一版的清单行(版本 sha256 来源):守护进程看到它才去装,所以在包传完之后写。 */
export function incomingManifestScript(version: string, sha256: string): string {
  if (!isServerVersion(version)) throw new Error('版本号格式不对')
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('校验值格式不对')
  const dir = `${SERVER_HOME}/versions/${INCOMING_DIR}`
  return `printf '%s\\n' '${version} ${sha256} desktop-upload' > ${dir}/${version}.txt.part && mv ${dir}/${version}.txt.part ${dir}/${version}.txt\n`
}

export type MatchReport = { target: string; running: string | null; installed: boolean; supervisor: boolean }

/** 读 match-version 打的那一行(之前可能夹着对方 rc 打的字)。认不出 = null。 */
export function parseMatchOutput(stdout: string): Record<string, string> | null {
  const at = stdout.lastIndexOf(`${MATCH_MARK} `)
  if (at < 0) return null
  const fields: Record<string, string> = {}
  for (const pair of (stdout.slice(at + MATCH_MARK.length + 1).split(/\r?\n/)[0] ?? '').trim().split(/\s+/)) {
    const eq = pair.indexOf('=')
    if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return fields
}

export function parseMatchReport(stdout: string): MatchReport | null {
  const fields = parseMatchOutput(stdout)
  if (!fields || !isServerVersion(fields.target)) return null
  return {
    target: fields.target,
    running: isServerVersion(fields.running) ? fields.running : null,
    installed: fields.installed === '1',
    supervisor: fields.supervisor === '1',
  }
}

/** 第四步:注册常驻服务。 */

export function serviceScript(): string {
  return `${SERVER_BIN} service install </dev/null\n`
}

/**
 * 第五步:登录。device_code 由 sh 的**内建** printf 经管道递给 gugu-server 的标准输入:
 * 内建命令不起新进程,所以它不会出现在任何进程的命令行参数里。
 * 只收 base64url 字符 —— 它被拼进脚本,形状不对就拒绝,❌ 靠引号兜底。
 */
export function loginScript(deviceCode: string, name: string | null = null): string {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(deviceCode)) throw new Error('登录凭证格式不对')
  // 名字只收 HOST_RE 认的字符(machineNameFromTarget 出来的都是),引号里不会有引号。
  const named = name && HOST_RE.test(name) ? ` --name '${name}'` : ''
  return `printf '%s\\n' '${deviceCode}' | ${SERVER_BIN} login --grant-stdin${named}\n`
}

/**
 * #6264 这台机器的默认名(照 VS Code Remote-SSH 拿 Host 别名当显示名):人填的是 SSH 配置里的别名 ⇒ 就叫它;
 * 填的是 `用户@主机` ⇒ 叫主机。主机是 IP ⇒ null(IP 人认不出,❌ 当设备名,库里退回 `Linux 1`)。
 */
export function machineNameFromTarget(target: Pick<SshTarget, 'destination'>): string | null {
  const host = target.destination.slice(target.destination.lastIndexOf('@') + 1)
  return HOST_RE.test(host) && !isIpLikeLabel(host) ? host : null
}

// ── 读远端输出 ────────────────────────────────────────────────────────────────

/** 终端颜色码(ESC [ … 字母);安装脚本或对方的 shell 配置可能带出来。 */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

/** ssh 自己出错(退出码 255)时,从它的 stderr 认出是哪一种。 */
export function classifySshFailure(stderr: string): ServerSshInstallFailureReason {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return 'hostKeyChanged'
  if (/Host key verification failed/i.test(stderr)) return 'hostKeyRejected'
  if (/Permission denied|Too many authentication failures|Authentication failed/i.test(stderr)) return 'authFailed'
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(stderr)) return 'hostUnresolved'
  if (/Connection refused/i.test(stderr)) return 'connectionRefused'
  // TCP 连上了、对面却不说 SSH(端口不对、被防火墙 / 代理截住):实测本机开着代理时连一个没人听的端口就是这样。
  if (/kex_exchange_identification|banner exchange|Connection (?:closed|reset) by \S+ port/i.test(stderr)) return 'connectionRefused'
  if (/timed out/i.test(stderr)) return 'timeout'
  if (/No route to host|Network is unreachable|Host is down/i.test(stderr)) return 'unreachable'
  return 'unknown'
}

/**
 * 指纹变了时,ssh 的报错里写着要删的是哪条记录、对方现在的新指纹。
 * 「Offending ECDSA key in /x/known_hosts:3」「… for [host]:2222 has changed」「The fingerprint … is\nSHA256:…」。
 */
export function changedHostKey(stderr: string, fallbackHost: string): { host: string; fingerprint: string | null } {
  const host = stderr.match(/(?:key for|Host key for) (\S+) has changed/i)?.[1] ?? fallbackHost
  const fingerprint = stderr.match(/(SHA256:[A-Za-z0-9+/=]+)/)?.[1] ?? null
  return { host, fingerprint }
}

/** known_hosts 里这台机器的写法:非 22 端口是 `[主机]:端口`(`ssh-keygen -R` 要的就是这一串)。 */
export function hostForKnownHosts(target: SshTarget): string {
  const host = target.destination.includes('@') ? target.destination.slice(target.destination.lastIndexOf('@') + 1) : target.destination
  return target.port !== undefined && target.port !== 22 ? `[${host}]:${target.port}` : host
}

/** ssh 认证通过时(LogLevel=VERBOSE)打的那一行。 */
export function isAuthenticatedLine(text: string): boolean {
  return /^Authenticated to /m.test(text)
}

/** 进「查看详情」时要滤掉的行:我们自己的机器可读标记、ssh 收尾的流量统计。 */
function isLogNoise(line: string): boolean {
  return line.startsWith('__GUGU_') || /^(?:Transferred|Bytes per second): /.test(line)
}

/** 一段输出 → 进日志的若干行(去颜色码、去噪音)。 */
export function logLines(chunk: string): string[] {
  return chunk
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() && !isLogNoise(line.trim()))
}

/** 输出里最后几行有内容的原文,附在人话后面当证据。去掉 ANSI 颜色与 ssh 的固定噪音。 */
export function lastLines(text: string, count = 3): string {
  return text
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !/^Warning: Permanently added/.test(line) &&
        !/^Authenticated to /.test(line) &&
        !line.startsWith('__GUGU_') &&
        !isLogNoise(line),
    )
    .slice(-count)
    .join('\n')
}

/** install.sh 失败时自己会打「安装失败:…」,优先拿那一行。 */
export function installFailureDetail(stderr: string, stdout: string): string {
  const own = stderr.split(/\r?\n/).reverse().find((line) => line.startsWith('安装失败'))
  return own ?? lastLines(`${stdout}\n${stderr}`)
}

/** 装的那一步失败了,是哪一种:盘满、没权限、这台机器跑不起来,其余照旧算「安装没完成」。 */
export function classifyInstallFailure(text: string): 'diskFull' | 'noPermission' | 'noExec' | 'installFailed' {
  if (/No space left on device|Disk quota exceeded/i.test(text)) return 'diskFull'
  if (/在本机跑不起来/.test(text)) return 'noExec'
  if (/Permission denied|Read-only file system|Operation not permitted/i.test(text)) return 'noPermission'
  return 'installFailed'
}

/** 那台机器是不是下载站连不上(→ 改走本机下载后传过去)。 */
export function isNoInternet(result: { code: number | null; stdout: string; stderr: string }): boolean {
  if (result.code === NO_INTERNET_EXIT && result.stdout.includes(NO_INTERNET_MARK)) return true
  return /查不到版本信息|下载失败:|下载安装脚本失败/.test(result.stderr)
}

/** 下载脚本的机器可读行 → 版本 / 总量 / 已下字节(每段输出里取最新的)。 */
export function parseDownloadProgress(chunk: string): { version?: string; total?: number; done?: number } {
  const out: { version?: string; total?: number; done?: number } = {}
  for (const line of chunk.split(/\r?\n/)) {
    if (line.startsWith(MANIFEST_MARK)) {
      const version = line.slice(MANIFEST_MARK.length).trim().split(/\s+/)[0]
      if (version) out.version = version
    } else if (line.startsWith(TOTAL_MARK)) {
      const total = Number(line.slice(TOTAL_MARK.length).trim())
      if (Number.isFinite(total) && total > 0) out.total = total
    } else if (line.startsWith(BYTES_MARK)) {
      const done = Number(line.slice(BYTES_MARK.length).trim())
      if (Number.isFinite(done)) out.done = done
    }
  }
  return out
}

/** `gugu-server service install` 的输出里有「还差一步」时,翻成桌面自己的提示(behavior 第 4 条)。 */
export function serviceWarnings(stdout: string): ServerSshInstallWarning[] {
  const warnings: ServerSshInstallWarning[] = []
  const linger = stdout.match(/loginctl enable-linger\s+(\S+)/)
  if (linger && /⚠/.test(stdout)) warnings.push({ kind: 'lingerMissing', user: linger[1] })
  if (/⚠[^\n]*crontab/.test(stdout)) warnings.push({ kind: 'noReboot' })
  return warnings
}

/**
 * 登录那一步失败,是不是因为那台机器连不上咕咕的云(公司内网只放行 SSH、没配代理)。
 * 这种情况重试没用,而且就算登上了 server 也收不到消息 —— 单独说清要放行什么。
 */
export function isCloudUnreachable(text: string): boolean {
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|getaddrinfo|UND_ERR_CONNECT_TIMEOUT|certificate/i.test(text)
}

/**
 * #6264 登录因机器上限被拒:`gugu-server login --grant-stdin` 打的是 `LOGIN_ERROR_MARK machine_limit {json}`,
 * parseLoginOutput 把标记后面那段原样交出来;这里读出哪条上限、用了几台。不是这一种 = null。
 */
export function machineLimitFromLoginError(error: string | null): { refusal: MachineLimitRefusal | null } | null {
  if (!error?.startsWith(MACHINE_LIMIT_ERROR)) return null
  return { refusal: parseMachineLimitRefusal(error.slice(MACHINE_LIMIT_ERROR.length).trim()) }
}

export type LoginOutcome =
  | { ok: true; userId: string; email: string | null; others: string[]; deviceId: string | null }
  | { ok: false; error: string | null }

const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function parseLoginOutput(stdout: string): LoginOutcome {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(LOGIN_RESULT_MARK)) {
      try {
        const data = JSON.parse(line.slice(LOGIN_RESULT_MARK.length)) as {
          userId?: unknown
          email?: unknown
          others?: unknown
          deviceId?: unknown
        }
        if (typeof data.userId === 'string') {
          return {
            ok: true,
            userId: data.userId,
            email: typeof data.email === 'string' ? data.email : null,
            others: Array.isArray(data.others) ? data.others.filter((v): v is string => typeof v === 'string') : [],
            // 老 server 不报这一格:缺席 = 不知道这台机器在云端叫哪台设备,于是它只有「通用」(没法对上号)。
            deviceId: typeof data.deviceId === 'string' && DEVICE_ID.test(data.deviceId) ? data.deviceId : null,
          }
        }
      } catch {
        // 落到下面当失败处理
      }
    }
  }
  const error = stdout.split(/\r?\n/).find((line) => line.startsWith(LOGIN_ERROR_MARK))
  return { ok: false, error: error ? error.slice(LOGIN_ERROR_MARK.length).trim() || null : null }
}

/** install.sh 一边装一边打的中文进度,挑最新一行给界面当「此刻在做什么」。 */
export function liveLine(chunk: string): string | null {
  const lines = chunk
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('__GUGU_'))
  return lines.length ? lines[lines.length - 1].slice(0, 200) : null
}

/**
 * #6264 会话右侧工作区的「浏览器」打开 localhost:<端口> 时:把这台电脑的 localPort 经 SSH 转到那台机器的 remotePort
 * (照 VS Code 的端口转发)。只监听本机回环地址,❌ 让局域网里的别人经这台电脑摸到那台机器。
 *
 * 这是**没有复用连接时**(Windows 自带的 OpenSSH 没有 ControlMaster)的连法:独立的一条连接(ControlPath=none),
 * 转发的生死就是这个进程的生死,关掉浏览器页签 = 杀掉进程 = 转发没了。
 * 有复用连接时转发骑在共享连接上(buildEnsureMasterArgs / buildMuxForwardArgs),生命周期靠 `-O cancel` 说清,
 * ❌ 另开一条再认证一次。
 * ExitOnForwardFailure:本机端口被抢了 / 那台机器不许转发,就退出而不是挂着一条什么都不转的连接。
 */
export function buildForwardSshArgs(
  target: SshTarget,
  options: { localPort: number; remotePort: number },
): string[] {
  for (const port of [options.localPort, options.remotePort]) {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('端口形状不对')
  }
  const args = [
    '-N',
    '-T',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    '-o', 'ControlPath=none',
  ]
  if (target.port !== undefined) args.push('-p', String(target.port))
  if (target.options?.length) args.push(...target.options)
  args.push('-L', `127.0.0.1:${options.localPort}:localhost:${options.remotePort}`, '--', target.destination)
  return args
}

/**
 * #6264 端口转发骑在这台机器那条共享连接上(照 VS Code:端口转发与终端同一条连接,❌ 另开一条再认证一次)。
 *  · ensure:确保共享连接在(在就直接复用、什么都不问;不在就认证一次 —— 要密码经 askpass 问,之后留着);
 *  · forward / cancel:让共享连接加 / 撤一条 `-L 127.0.0.1:本机端口:localhost:远端端口`(`ssh -O forward|cancel`)。
 *    关掉浏览器页签 = cancel,转发随之撤掉。
 * 只绑本机回环地址,与 buildForwardSshArgs 相同。
 */
export function buildEnsureMasterArgs(target: SshTarget, controlPath: string): string[] {
  const args = [
    '-T',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', `ControlPersist=${SHARED_CONTROL_PERSIST}`,
  ]
  if (target.port !== undefined) args.push('-p', String(target.port))
  if (target.options?.length) args.push(...target.options)
  args.push('--', target.destination, 'exit 0')
  return args
}

export function buildMuxForwardArgs(
  target: SshTarget,
  options: { controlPath: string; localPort: number; remotePort: number; op: 'forward' | 'cancel' },
): string[] {
  for (const port of [options.localPort, options.remotePort]) {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('端口形状不对')
  }
  const args = ['-o', `ControlPath=${options.controlPath}`, '-o', 'LogLevel=ERROR', '-O', options.op]
  args.push('-L', `127.0.0.1:${options.localPort}:localhost:${options.remotePort}`)
  if (target.port !== undefined) args.push('-p', String(target.port))
  // %C 按主机、端口、用户、跳板算:选项少一个就找不到那条连接。
  if (target.options?.length) args.push(...target.options)
  args.push('--', target.destination)
  return args
}

/** 收掉(或看一眼)这台机器那条共享连接。 */
export function buildMuxControlArgs(target: SshTarget, controlPath: string, op: 'exit' | 'check'): string[] {
  const args = ['-o', `ControlPath=${controlPath}`, '-o', 'LogLevel=ERROR', '-O', op]
  if (target.port !== undefined) args.push('-p', String(target.port))
  if (target.options?.length) args.push(...target.options)
  args.push('--', target.destination)
  return args
}

/**
 * 端口转发(`ssh -N -T -L`,远端不跑 gugu-server)断开 / 连不上时:是因为什么、会不会自己好
 * (behavior「失败时说清楚卡在哪、为什么」)。
 * 文案由渲染层按界面语言给(src/session/shared/direct-terminal-link.ts),这里只给代号。
 */
export function classifyAttachExit(
  info: { exitCode: number | null; signal: number | string | null; tail: string },
  /** known_hosts 里这台机器的写法(报错里认不出时用它);指纹变了时界面据此给出删旧记录的命令。 */
  knownHost = '',
): {
  reason: DirectTerminalReason
  retryable: boolean
  hostKeyChanged?: { host: string; fingerprint: string | null }
} {
  const tail = info.tail.replace(ANSI_ESCAPE, '')
  if (info.exitCode === 255) {
    const byReason: Partial<Record<ServerSshInstallFailureReason, { reason: DirectTerminalReason; retryable: boolean }>> = {
      authFailed: { reason: 'auth', retryable: false },
      hostKeyRejected: { reason: 'host-key-rejected', retryable: false },
      hostKeyChanged: { reason: 'host-key-changed', retryable: false },
      // 换 Wi-Fi / 刚醒来时 DNS 一时解析不了,会自己好。
      hostUnresolved: { reason: 'host-unresolved', retryable: true },
      // 那台机器在重启时 sshd 还没起来。
      connectionRefused: { reason: 'refused', retryable: true },
      unreachable: { reason: 'unreachable', retryable: true },
      timeout: { reason: 'timeout', retryable: true },
    }
    const failure = classifySshFailure(tail)
    // 指纹变了是拒绝,不是提问:❌ 问「要不要信任」,给出原因、新指纹和删旧记录的命令。
    if (failure === 'hostKeyChanged') {
      return { reason: 'host-key-changed', retryable: false, hostKeyChanged: changedHostKey(tail, knownHost) }
    }
    return byReason[failure] ?? { reason: 'network', retryable: true }
  }
  if (info.exitCode === 0) return { reason: 'ended', retryable: true }
  return { reason: 'unknown', retryable: true }
}
