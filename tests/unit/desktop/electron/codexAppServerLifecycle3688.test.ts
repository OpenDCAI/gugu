import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexAppServerSession,
  disposeAllCodexAppServerSessions,
  trackedCodexAppServerRunCount,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import { removeRetiredCodexCapabilityRuns } from '../../../../apps/desktop/electron/sessionpage/codex-app-server-transport'
import { awaitFact, awaitReaped } from '../../../support/awaitFact'
import { cachedFixtureExecutable } from '../../../support/cachedFixtureExecutable'

/**
 * @@@4918 这段正文**必须逐字稳定**:它是 `cachedFixtureExecutable` 的内容寻址键。
 * 每个用例各自不同的东西(临时根、台账路径)一律走 env,❌ 别拼进正文 ——
 * 一拼进去内容就每次都变,等于回到「每跑一次铸一个新可执行文件」那条慢路径。
 */
const CODEX_FIXTURE_SCRIPT = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.155.1\\n')
  process.exit(0)
}

// 台账写在**自己的 cwd** 下 —— 产品 spawn 时把 cwd 设成本用例的临时 root
// (codex-app-server-delivery.ts 的 spawn 传了 cwd),所以这天然就是每用例隔离,
// 而这段正文对所有用例、所有 run 都一样,可以复用同一个 inode。
// ❌ 别改成从 argv/env 取绝对路径:env 走不通(实测子进程收到的是 null),
//    而把绝对路径拼进正文会让内容每次都变,缓存就白设了。
const ledger = join(process.cwd(), 'pids.json')
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.cwd()], {
  stdio: 'ignore',
})
writeFileSync(ledger + '.tmp', JSON.stringify({ wrapperPid: process.pid, descendantPid: descendant.pid }))
renameSync(ledger + '.tmp', ledger)
setInterval(() => {}, 1000)
`

const roots = new Set<string>()
let previousGuguHome: string | undefined

/**
 * 这两份台账由产品 spawn 的 fixture / 产品自己写下,测试手里没有那个子进程的句柄 ——
 * 能证明「再也不会出现」的事件是那次 `start()` 已经落定(产品已收尸)。所以等到事实出现,
 * 或者 start 落定后再读一次仍没有就响亮失败;❌ 不设墙钟 deadline(#4357)。
 */
function startSettledFlag(start: Promise<unknown>): () => boolean {
  let settled = false
  start.then(() => { settled = true }, () => { settled = true })
  return () => settled
}

function waitForFile(path: string, startSettled: () => boolean): Promise<string> {
  return awaitFact(`fixture PID ledger ${path}`, async () => {
    const settled = startSettled()
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (settled) throw new Error(`fixture PID ledger was not published before start() settled: ${path}`)
      return undefined
    }
  })
}

function waitForEntryCount(path: string, expected: number, startSettled: () => boolean): Promise<string[]> {
  return awaitFact(`${expected} entries under ${path}`, async () => {
    const settled = startSettled()
    let entries: string[] = []
    try {
      entries = await readdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (entries.length === expected) return entries
    if (settled) throw new Error(`expected ${expected} entries under ${path} before start() settled, saw ${entries.length}`)
    return undefined
  })
}


/** 等这个 pid 被收尸;被 init 收养(孤儿)当场失败,见 awaitReaped。 */
async function waitForTerminal(pid: number): Promise<boolean> {
  await awaitReaped(`pid ${pid} reaped`, [pid])
  return true
}

function killOwnedFixtureGroup(pgid: number, marker: string): void {
  const members = execFileSync('ps', ['-ww', '-axo', 'pgid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/)
      return match && Number(match[1]) === pgid ? [match[2]] : []
    })
  if (members.length === 0) return
  if (!members.every((command) => command.includes(marker))) {
    throw new Error(`refusing to kill reused or mixed process group ${pgid}`)
  }
  process.kill(-pgid, 'SIGKILL')
}

afterEach(async () => {
  if (previousGuguHome === undefined) delete process.env.GUGU_HOME
  else process.env.GUGU_HOME = previousGuguHome
  previousGuguHome = undefined
  await disposeAllCodexAppServerSessions()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('#3688 Codex app-server run ownership', () => {
  it.skipIf(process.platform === 'win32')(
    'reaps the wrapper and descendant before a failed run releases ownership',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'gugu-codex-lifecycle-3688-'))
      roots.add(root)
      const ledgerPath = join(root, 'pids.json')
      // @@@4918 fixture 可执行文件按内容复用,不再每跑一次现铸一个。
      // 正文里不能出现 mkdtemp 的路径,否则内容每次都变、缓存白设 —— 路径改走 env。
      const codexBin = cachedFixtureExecutable('codex-fixture.mjs', CODEX_FIXTURE_SCRIPT)
      const guguHome = join(root, 'gugu-home')
      const userCodexHome = join(root, 'user-codex-home')
      await mkdir(userCodexHome, { recursive: true })
      await writeFile(join(userCodexHome, 'history-sentinel'), 'owner-history')

      const session = new CodexAppServerSession('agent-3688', codexBin, undefined, {
        platform: process.platform,
        startupTimeoutMs: 500,
        sessionId: 'conversation-3688',
      })
      expect(trackedCodexAppServerRunCount()).toBe(0)
      // @@@3890⑬ 台账跟的是**主进程**的 GUGU_HOME，不是 spawn 用的 childEnv —— 收尸 (createReapDeps)
      // 只扫主进程那一份，两者一分叉，附加账号的引擎组就永久泄漏。所以沙箱要设在 process.env 上；
      // 子进程 env 里照旧只放真正属于子进程的东西（CODEX_HOME）。
      previousGuguHome = process.env.GUGU_HOME
      process.env.GUGU_HOME = guguHome
      const failedStart = session.start(root, {
        env: { ...process.env, CODEX_HOME: userCodexHome },
      })
      failedStart.catch(() => undefined)
      const failedStartSettled = startSettledFlag(failedStart)
      const ledger = JSON.parse(await waitForFile(ledgerPath, failedStartSettled)) as {
        wrapperPid: number
        descendantPid: number
      }
      expect(trackedCodexAppServerRunCount()).toBe(1)
      await expect(waitForEntryCount(join(guguHome, 'engine-pids'), 1, failedStartSettled)).resolves.toHaveLength(1)
      let appDisposeLedger: { wrapperPid: number; descendantPid: number } | null = null

      try {
        await expect(failedStart).rejects.toThrow('endpoint 未在 500ms 内就绪')
        const terminal = await Promise.all([
          waitForTerminal(ledger.wrapperPid),
          waitForTerminal(ledger.descendantPid),
        ])
        expect(terminal.filter(Boolean).length, 'failed run must reap 2 of 2 created processes').toBe(2)
        expect(trackedCodexAppServerRunCount()).toBe(0)
        await expect(readdir(join(guguHome, 'engine-pids'))).resolves.toEqual([])

        await rm(ledgerPath, { force: true })
        const appDisposeSession = new CodexAppServerSession('agent-3688-app-dispose', codexBin, undefined, {
          platform: process.platform,
          startupTimeoutMs: 600_000,
          sessionId: 'conversation-3688-app-dispose',
        })
        const interruptedStart = appDisposeSession.start(root, {
          env: { ...process.env, GUGU_HOME: guguHome, CODEX_HOME: userCodexHome },
        })
        interruptedStart.catch(() => undefined)
        const interruptedStartSettled = startSettledFlag(interruptedStart)
        appDisposeLedger = JSON.parse(await waitForFile(ledgerPath, interruptedStartSettled)) as {
          wrapperPid: number
          descendantPid: number
        }
        await expect(waitForEntryCount(join(guguHome, 'engine-pids'), 1, interruptedStartSettled)).resolves.toHaveLength(1)
        await disposeAllCodexAppServerSessions()
        await expect(interruptedStart).rejects.toThrow('exited before endpoint ready')
        const appDisposeTerminal = await Promise.all([
          waitForTerminal(appDisposeLedger.wrapperPid),
          waitForTerminal(appDisposeLedger.descendantPid),
        ])
        expect(
          appDisposeTerminal.filter(Boolean).length,
          'app-level dispose must reap 2 of 2 created processes',
        ).toBe(2)
        expect(trackedCodexAppServerRunCount()).toBe(0)
        await expect(readdir(join(guguHome, 'engine-pids'))).resolves.toEqual([])

        const retiredRoot = join(guguHome, 'runtime-sessions', 'codex-capability-runs')
        await mkdir(join(retiredRoot, 'run-a', 'tmp', 'arg0'), { recursive: true })
        await mkdir(join(retiredRoot, 'run-b'), { recursive: true })
        const adjacentSentinel = join(guguHome, 'runtime-sessions', 'keep-me')
        await writeFile(adjacentSentinel, 'adjacent')
        await expect(removeRetiredCodexCapabilityRuns({ GUGU_HOME: guguHome })).resolves.toEqual({
          found: 2,
          removed: 2,
        })
        await expect(readdir(retiredRoot)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(adjacentSentinel, 'utf8')).resolves.toBe('adjacent')
        await expect(readFile(join(userCodexHome, 'history-sentinel'), 'utf8')).resolves.toBe('owner-history')
      } finally {
        killOwnedFixtureGroup(ledger.wrapperPid, root)
        if (appDisposeLedger) killOwnedFixtureGroup(appDisposeLedger.wrapperPid, root)
        const pids = [
          ledger.wrapperPid,
          ledger.descendantPid,
          ...(appDisposeLedger ? [appDisposeLedger.wrapperPid, appDisposeLedger.descendantPid] : []),
        ]
        await Promise.all(pids.map((pid) =>
          waitForTerminal(pid)
        ))
      }
    },
  )
})
