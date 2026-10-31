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
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnOwnedChild } from '@gugu/session-core/exec'
import { readAccountActivity } from './server-layout'

/** Same cold-account smoke as ci-linux-packages.sh, through the target's actual entry. */
export async function checkAccountBoot(binary: string): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-boot-'))
  const userId = randomUUID()
  const account = path.join(home, 'accounts', userId)
  const data = path.join(account, 'data')
  fs.mkdirSync(data, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(account, 'account.json'), '{}', { mode: 0o600 })
  const ready = Promise.withResolvers<void>()
  const startedAt = Date.now()
  let owned: ReturnType<typeof spawnOwnedChild> | undefined
  let watcher: fs.FSWatcher | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    watcher = fs.watch(data, (_event, file) => {
      if (!owned || file?.toString() !== 'activity.json') return
      const activity = readAccountActivity(data, Date.now(), { pid: owned.child.pid, startedAt })
      if (activity) { ready.resolve(); return }
      try {
        const old = JSON.parse(fs.readFileSync(path.join(data, 'activity.json'), 'utf8')) as { at?: unknown; pid?: unknown; startedAt?: unknown }
        if (typeof old.at === 'number' && (typeof old.pid !== 'number' || typeof old.startedAt !== 'number')) {
          ready.reject(new Error('Target does not publish PID-bound boot readiness; automatic handoff is unsupported'))
        }
      } catch { /* A partial old non-atomic write is not readiness. */ }
    })
    watcher.on('error', error => ready.reject(error))
    owned = spawnOwnedChild(binary, ['run-account', userId], {
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GUGU_SERVER_HOME: home, GUGU_HOME: path.join(account, 'home'),
        GUGU_TASK_HOST_USER_DATA: data, GUGU_USER_DATA_DIR: data,
        GUGU_SERVER_ACCOUNT: userId, GUGU_SERVER_WAIT_PID: '', HOME: home, USERPROFILE: home },
      onError: error => ready.reject(error),
    })
    // Main writes its existing heartbeat only after full account startup, after the early boot log.
    // Drain output without collecting environment, credentials or unbounded logs.
    owned.child.stdout?.resume()
    owned.child.stderr?.resume()
    owned.child.stdout?.on('error', error => ready.reject(error))
    owned.child.stderr?.on('error', error => ready.reject(error))
    owned.child.once('exit', code => ready.reject(new Error(`Account boot exited before serving (${code})`)))
    timeout = setTimeout(() => ready.reject(new Error('Account boot did not become ready')), 45_000)
    await ready.promise
  } finally {
    if (timeout) clearTimeout(timeout)
    watcher?.close()
    await owned?.stop({ graceMs: 10_000 })
    fs.rmSync(home, { recursive: true, force: true })
  }
  // main.ts handles our SIGTERM with exit(143). An unhandled SIGTERM is normal too;
  // SIGKILL or an unrelated fatal exit after the heartbeat is not a successful smoke.
  if (owned.child.exitCode !== 0 && owned.child.exitCode !== 143 && owned.child.signalCode !== 'SIGTERM') {
    throw new Error(`Account boot exited with code ${owned.child.exitCode}, signal ${owned.child.signalCode}`)
  }
}

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
