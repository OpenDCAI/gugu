/**
 * #6264 桌面经 SSH 调的命令(`link`)要用**正在跑的那个账号进程的版本**来跑。
 *
 * 桌面敲的是 `~/.local/bin/gugu-server` → current 软链。current 与在跑的进程并不总是同一版:
 *  · 重新执行安装命令时,install.sh 先切 current、再让 service install 把旧进程换下来 —— 中间最长 75 秒;
 *  · 自动升级等空闲才切,切完到新进程起来也有几秒;
 *  · 看门狗回滚、孤儿进程,都可能让两边差一版。
 * 这段时间里新版本的 link 去接旧版本的账号进程,协议版本严格相等就被拒,连不上。
 * VS Code / Zed 的做法是客户端与 server 版本严格一致(不一致就装一份对应的);我们盘上本来就留着在跑的那一版,
 * 所以直接换成那一版的可执行文件来跑这条命令 —— 两边永远说同一种话。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 换成哪一版来跑;null = 就用自己。 */
export function chooseVersionBinary(input: {
  ownVersion: string | undefined
  runningVersion: string | null
  versionsDir: string
  exists: (file: string) => boolean
  alreadySwitched: boolean
}): string | null {
  const { ownVersion, runningVersion } = input
  if (input.alreadySwitched || !ownVersion || !runningVersion || ownVersion === runningVersion) return null
  if (!/^[0-9A-Za-z._-]{1,64}$/.test(runningVersion)) return null
  const binary = path.join(input.versionsDir, runningVersion, 'bin', 'gugu-server')
  return input.exists(binary) ? binary : null
}

/** 从 /proc/<pid>/environ 读 GUGU_TASK_HOST_VERSION(启动器 export 的),读不到退回命令行里的 versions/<版本>/。 */
export function runningVersionOf(pid: number, read: (file: string) => string | null): string | null {
  const environ = read(`/proc/${pid}/environ`)
  if (environ) {
    for (const entry of environ.split('\0')) {
      if (entry.startsWith('GUGU_TASK_HOST_VERSION=')) return entry.slice('GUGU_TASK_HOST_VERSION='.length) || null
    }
  }
  const cmdline = read(`/proc/${pid}/cmdline`)?.replace(/\0/g, ' ') ?? null
  return cmdline?.match(/\/versions\/([^/\s]+)\/(?:node|app)\//)?.[1] ?? null
}

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 需要换版本就用那一版把这条命令原样跑一遍(标准输入输出、终端都直通),返回它的退出码;不需要返回 null。
 * `accountPid`:这条命令要找的那个账号进程(读它的单实例锁得来)。
 */
export function runWithRunningVersion(input: {
  home: string
  accountPid: number | null
  command: string
  args: readonly string[]
}): number | null {
  if (input.accountPid === null) return null
  const binary = chooseVersionBinary({
    ownVersion: process.env.GUGU_TASK_HOST_VERSION,
    runningVersion: runningVersionOf(input.accountPid, readText),
    versionsDir: path.join(input.home, 'versions'),
    exists: (file) => fs.existsSync(file),
    alreadySwitched: process.env.GUGU_SERVER_VERSION_MATCHED === '1',
  })
  if (!binary) return null
  const result = spawnSync(binary, [input.command, ...input.args], {
    stdio: 'inherit',
    env: { ...process.env, GUGU_SERVER_VERSION_MATCHED: '1' },
  })
  if (result.error) return null
  return result.status ?? (result.signal ? 128 : 1)
}
