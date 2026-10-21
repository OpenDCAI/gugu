/**
 * `gugu-server selftest`:升级换版之前,新包在**这台机器上**真能跑起来吗(#6264)。
 *
 * 以前试跑的是 `help`,它在加载任何原生模块之前就退出了 —— 原生模块 ABI 不对、glibc 太旧、缺动态库这些
 * 最常见的「换过去就起不来」一个都拦不住。这里把账号进程启动时一定会碰的原生部件逐个真加载一遍:
 *  · better-sqlite3:开一个内存库跑一句 SQL(会话库、任务库都靠它);
 *  · node-pty:加载原生绑定(编程终端靠它);
 *  · @parcel/watcher:加载原生绑定(文件监视靠它);
 *  · 自带的 tmux:跑 `-V`(终端会话跨重启靠它)。
 * 任何一项不过就非 0 退出,自动升级与安装脚本据此留在旧版本上。只做加载与最小调用,几百毫秒。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type SelftestCheck = { name: string; run: () => void | Promise<void> }
export type SelftestResult = { name: string; ok: boolean; error?: string }

export async function runChecks(checks: readonly SelftestCheck[]): Promise<SelftestResult[]> {
  const results: SelftestResult[] = []
  for (const check of checks) {
    try {
      await check.run()
      results.push({ name: check.name, ok: true })
    } catch (error) {
      results.push({ name: check.name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

export function defaultChecks(appPath: string | undefined): SelftestCheck[] {
  const checks: SelftestCheck[] = [
    {
      name: 'better-sqlite3',
      run: async () => {
        const mod = (await import('better-sqlite3')) as unknown as { default: new (file: string) => { prepare: (sql: string) => { get: () => unknown }; close: () => void } }
        const db = new mod.default(':memory:')
        try {
          db.prepare('select 1').get()
        } finally {
          db.close()
        }
      },
    },
    { name: 'node-pty', run: async () => void (await import('node-pty')) },
    { name: '@parcel/watcher', run: async () => void (await import('@parcel/watcher')) },
  ]
  const tmux = appPath ? path.join(appPath, 'tmux-bundle', 'tmux') : null
  if (tmux && fs.existsSync(tmux)) {
    checks.push({ name: 'tmux', run: () => void execFileSync(tmux, ['-V'], { stdio: 'ignore', timeout: 10_000 }) })
  }
  return checks
}

export async function runSelftest(write: (line: string) => void): Promise<number> {
  const results = await runChecks(defaultChecks(process.env.GUGU_TASK_HOST_APP_PATH))
  for (const result of results) write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`)
  return results.every((result) => result.ok) ? 0 : 1
}
