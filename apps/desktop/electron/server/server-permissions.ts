/**
 * 咕咕 server 的数据目录只归这个用户自己(登录态、密钥、会话记录都在里面)。
 *
 * ❌ 不收紧进程 umask:agent 与「编程」终端在用户项目里建的文件,要跟他自己登录 shell 建的一样(0644)。
 * 服务定义写 umask 0022(systemd 用户服务不写 UMask= 时继承用户管理器的 umask,Ubuntu 每用户同名组的系统上
 * 是 0002 = 组可写),server 自己的数据靠「根是 0700」保证私有:
 *
 * - 根 ~/.gugu-server:install.sh 建成 0700,server 每次启动(任何命令)`ensurePrivateDir` 再确认一次。
 *   根只有本人进得去,里面后来再建的任何东西别人都够不着 —— 所以运行期新建的目录不必逐个补权限。
 * - tmpdir 下的根(codex 套接字目录 gugu-cx-<uid>、pty attach 的 /tmp/gugu-pty-*)同样 0700;
 *   tmpdir 下的单个文件(平台模型的设置 / 凭据文件)自己带 0600。
 * - 已经装好的机器(旧版本按 0002 建过一整棵树):守护进程每次启动走一遍 `tightenServerTree`,
 *   目录收到 0700、登录态/密钥文件收到 0600、其余文件去掉组和其他人的权限,改了什么记进日志。
 *
 * 只动数据目录里、属于本用户的东西;❌ 跟软链、❌ 进 git 仓库(那是用户的项目)、❌ 进安装包内部与 node_modules。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 服务定义里写的 umask:与常见登录 shell 一致,压住 pam_umask 给的 0002(组可写)。 */
export const SERVICE_UMASK = 0o022

/**
 * server 自己拥有的根目录:建成 0700;已存在的(旧版本、手动建的)收回 0700。
 * 是软链或不属于本人就报错 —— 那不是我们的目录,❌ 往里写登录态。
 */
export function ensurePrivateDir(dir: string, io: Pick<typeof fs, 'mkdirSync' | 'lstatSync' | 'chmodSync'> = fs): void {
  io.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = io.lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} 不是目录`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${dir} 不属于当前用户`)
  if ((stat.mode & 0o777) !== 0o700) io.chmodSync(dir, 0o700)
}

/** 登录态、密钥、令牌:只许本人读写(0600,也去掉可执行位)。 */
const SECRET_FILE = /(\.enc|\.key|\.pem|secret[^/]*|token[^/]*|credentials[^/]*|auth\.json)$/i

/** 不往下走的目录名:第三方包、版本库。 */
const NO_DESCEND = new Set(['node_modules', '.git'])

export type PermissionChange = { path: string; from: number; to: number }

export type TightenFs = Pick<typeof fs, 'lstatSync' | 'readdirSync' | 'chmodSync' | 'existsSync'>

export type TightenOptions = {
  /** 只动这个 uid 的东西(默认当前进程);别人的一律不碰。 */
  uid?: number | null
  fs?: TightenFs
  /** 走多少个条目就停(防一棵意外巨大的树拖住启动)。 */
  maxEntries?: number
}

/** 一个条目该是什么权限;null = 不动它。 */
export function desiredMode(kind: 'dir' | 'file', name: string, mode: number): number | null {
  const perm = mode & 0o7777
  if (kind === 'dir') return perm === 0o700 ? null : 0o700
  if (SECRET_FILE.test(name)) return perm === 0o600 ? null : 0o600
  const next = perm & ~0o077
  return next === perm ? null : next
}

/**
 * 把 server 数据目录收成只有本人能进。返回改过的每一项(给日志)。
 * `versions/` 只收到版本目录这一层:里面是安装包原样解出来的程序,不是数据,也太大。
 */
export function tightenServerTree(home: string, options: TightenOptions = {}): PermissionChange[] {
  const io = options.fs ?? fs
  const uid = options.uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : options.uid
  let budget = options.maxEntries ?? 20_000
  const changes: PermissionChange[] = []

  const fix = (target: string, kind: 'dir' | 'file'): boolean => {
    let stat: fs.Stats
    try {
      stat = io.lstatSync(target)
    } catch {
      return false
    }
    if (stat.isSymbolicLink()) return false
    if (uid !== null && stat.uid !== uid) return false
    const actualKind = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null
    if (actualKind !== kind) return false
    const to = desiredMode(kind, path.basename(target), stat.mode)
    if (to === null) return true
    try {
      io.chmodSync(target, to)
      changes.push({ path: target, from: stat.mode & 0o7777, to })
    } catch {
      // 改不了就算了(只读挂载等),下次启动再试
    }
    return true
  }

  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = io.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      if (budget-- <= 0) return
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        // 一个 git 仓库 = 用户的项目:连它本身一概不碰。
        if (io.existsSync(path.join(full, '.git'))) continue
        if (!fix(full, 'dir')) continue
        if (NO_DESCEND.has(entry.name)) continue
        // versions/<版本>/ 只收这一层
        if (depth === 0 && entry.name === 'versions') {
          for (const version of safeList(io, full)) {
            if (version.isDirectory() && !version.isSymbolicLink()) fix(path.join(full, version.name), 'dir')
          }
          continue
        }
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        fix(full, 'file')
      }
      // 套接字、管道:由所在目录(0700)挡住,不单独改
    }
  }

  if (!io.existsSync(home)) return changes
  if (!fix(home, 'dir')) return changes
  walk(home, 0)
  return changes
}

function safeList(io: TightenFs, dir: string): fs.Dirent[] {
  try {
    return io.readdirSync(dir, { withFileTypes: true }) as fs.Dirent[]
  } catch {
    return []
  }
}

/** 一句话日志:改了几项、前几项是什么。 */
export function summarizeChanges(changes: PermissionChange[], limit = 20): Record<string, unknown> {
  const oct = (n: number) => n.toString(8).padStart(4, '0')
  return {
    count: changes.length,
    sample: changes.slice(0, limit).map((c) => `${oct(c.from)}→${oct(c.to)} ${c.path}`),
  }
}
