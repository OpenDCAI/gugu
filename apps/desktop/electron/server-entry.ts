// 咕咕 server 的入口(product spec):不带界面、能常驻的咕咕。
//
// server 跑的是**桌面同一份主进程**(main.ts)—— 「桌面版自己也跑同一个 server」那一条的字面意思:
// 本地和远程只差挂在谁下面,不存在两套行为。这里只做三件事:
//  ① 把 require('electron') 钉到 server 替身(没有窗口、托盘、渲染进程);
//  ② 定数据目录;
//  ③ 以 server 模式加载 main.ts。
//
// ⚠️ main.ts 必须**动态** import:cjs 产物会把静态 import 的 require('electron') 提升到 chunk 顶部、
// 在钩子装上之前执行(与 session-host-entry.ts 同一个理由)。
import { REMOTE_TUNNEL_OPEN } from '@gugu/core/cloud/remoteTunnel'
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { isOwnProcessAlive, isProcessAlive, SERVER_PROCESS_MARK } from './server/process-alive'
import { ensureCaBundleForChildren } from './server/server-ca-bundle'
import {
  accountDataDir,
  applyAccountEnv,
  listAccounts,
  supervisorDataDir,
} from './server/server-layout'
import * as serverShim from './server/server-electron-shim'
import { runWithRunningVersion } from './server/server-version-match'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { ensurePrivateDir, summarizeChanges, tightenServerTree } from './server/server-permissions'


const stderr = (line: string): void => void process.stderr.write(`${line}\n`)

/** 数据目录:显式 GUGU_SERVER_HOME 最大,否则 ~/.gugu-server。 */
function resolveServerHome(): string {
  const configured = process.env.GUGU_SERVER_HOME?.trim()
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.gugu-server')
}

type ModuleLoader = (request: string, ...rest: unknown[]) => unknown
const moduleInternals = Module as unknown as { _load: ModuleLoader }
const originalLoad = moduleInternals._load
const warnedMembers = new Set<PropertyKey>()
const shimWithLoudMisses = new Proxy(serverShim.default as Record<PropertyKey, unknown>, {
  get(target, key) {
    if (key in target || key === '__esModule' || key === 'default' || typeof key !== 'string') {
      return Reflect.get(target, key)
    }
    if (!warnedMembers.has(key)) {
      warnedMembers.add(key)
      stderr(`[server] electron.${key} 未在 server-electron-shim.ts 覆盖 —— 某个模块在用它,补上替身`)
    }
    return undefined
  },
})
moduleInternals._load = function patchedLoad(this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'electron') return shimWithLoudMisses
  return originalLoad.call(this, request, ...rest)
}

process.env.GUGU_SERVER_MODE = '1'
// 设备 id 按 tier 派生(deviceRuntime.resolveTier)。main.ts 顶层也设同一个值;这里提前设,是因为
// `login` 不加载 main.ts,却要报出账号进程上线后的设备 id(#6264 SSH 直连终端认机器靠它)。
declare const __GUGU_TIER__: string
if (!process.env.GUGU_TIER) process.env.GUGU_TIER = __GUGU_TIER__
const serverHome = resolveServerHome()
process.env.GUGU_SERVER_HOME = serverHome
// 数据目录的根只归本人(0700):里面的登录态、密钥、会话记录,以及运行期后来再建的一切,别人都够不着。
// ❌ 不收紧进程 umask —— agent 与编程终端在用户项目里建的文件要跟他自己建的一样,见 server-permissions.ts。
try {
  ensurePrivateDir(serverHome)
} catch (error) {
  stderr(`[server] 数据目录 ${serverHome} 不能用:${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
// ⚠️ 这里**不**设 GUGU_TASK_HOST_USER_DATA:替身的 userData 第一次被读到就缓存住,而每个命令要指的目录不同
// (守护进程用 data/,账号进程用 accounts/<id>/data/,login 要等换到令牌、知道是谁之后才定)。见 server-layout.ts。

const USAGE = `用法:
  gugu-server                    运行咕咕 server(常驻;一般由系统服务拉起)
  gugu-server login              ${REMOTE_TUNNEL_OPEN ? '在这台服务器上登录一个咕咕账号(链接 + 短码,不需要浏览器)' : '远程隧道暂未开放:在咕咕桌面用远程 SSH 添加这台机器'}
                                 一台服务器可以登录好几个人,互不影响
  gugu-server login --grant-stdin 用咕咕桌面经 SSH 递来的一次性凭证登录(桌面自动调用,不用手敲)
                                 [--name 名字] 这台机器在设备列表里的默认名(桌面带上人填的 SSH 别名)
  gugu-server logout [邮箱]      退出登录(登录了好几个人时写上是谁)
  gugu-server status [--json]    看看版本、登录了谁、在不在跑、数据放在哪;登录失效 / 被移除的账号也列出来
  gugu-server --version          只打出这份咕咕 server 的版本号
  gugu-server service install    注册常驻服务:SSH 断开不停、重启自己起来(不要 root)
  gugu-server service uninstall  移除常驻服务
  gugu-server stop               停掉正在运行的 server(连同各账号的进程)
  gugu-server selftest           检查这份咕咕 server 在这台机器上能不能跑(原生模块、自带的 tmux)
  gugu-server unregister --account <账号 id>
                                 把这台机器从这个账号里移除并注销登录(卸载时自动调用)
  gugu-server link [--account <账号 id>] [--adopt-ssh]
                                 把标准输入输出接到这个账号的咕咕 server 上(远程 SSH:桌面经 SSH 自动调用)
  gugu-server open-url <网址或文件>
                                 在正看着这台机器的咕咕桌面上打开网页(这台机器上的 $BROWSER 就是它)
  gugu-server match-version --account <账号 id> (--desktop <桌面 id> --version <版本> | --apply <版本>)
                                 让这个账号跑和桌面匹配的那一版(桌面经 SSH 自动调用)`

function fail(error: unknown): never {
  stderr(`[server] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
}

const out = (line: string): void => void process.stdout.write(`${line}\n`)

/** 读某个目录下单实例锁里的进程号(锁在但进程已死、或进程号已被别的程序复用 = 没在跑)。 */
function lockHolder(dataDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, 'server.lock'), 'utf8').trim())
    return isOwnProcessAlive(pid, SERVER_PROCESS_MARK) ? pid : null
  } catch {
    return null
  }
}

/**
 * #6264 守护进程之外还在跑的账号进程(守护进程被 kill -9 / OOM 后留下的孤儿,或刚才没来得及收的):
 * 按各账号锁里的进程号收掉。先 SIGTERM 等它正常退出(收会话、放锁),30 秒不走再 SIGKILL。
 */
async function stopAccountProcesses(): Promise<number[]> {
  const pids = listAccounts()
    .map((account) => lockHolder(account.dataDir))
    .filter((pid): pid is number => pid !== null && pid !== process.pid)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已经退出了
    }
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && pids.some((pid) => isProcessAlive(pid))) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  for (const pid of pids) {
    if (!isProcessAlive(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出了
    }
  }
  return pids
}

/** 升级换版时新进程由旧进程拉起:等旧的完全退出(单实例锁放掉)再启动,最多等 60 秒。 */
async function waitForPidExit(pid: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return !isProcessAlive(pid)
}

function tightenOwnTree(): void {
  try {
    const changes = tightenServerTree(serverHome)
    if (changes.length === 0) return
    const line = `${new Date().toISOString()} INFO  收紧数据目录权限 ${JSON.stringify(summarizeChanges(changes))}`
    stderr(line)
    fs.mkdirSync(path.join(supervisorDataDir(), 'logs'), { recursive: true })
    fs.appendFileSync(path.join(supervisorDataDir(), 'logs', 'supervisor.log'), `${line}\n`)
  } catch (error) {
    stderr(`[server] 收紧数据目录权限失败:${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * #6264 桌面经 SSH 调的命令用「正在跑的那个账号进程」那一版来跑(server-version-match.ts):
 * 换版窗口里 current 已经是新版、账号进程还是旧版时,❌ 让新旧两版对话被协议版本拒掉。
 * 返回那一版的退出码;不需要换(版本一致 / 读不到 / 盘上没有那一版)返回 null,由本进程照常跑。
 */
function runningVersionFirst(command: string, args: string[], account: { dataDir: string } | { error: string }): number | null {
  if ('error' in account) return null
  return runWithRunningVersion({ home: serverHome, accountPid: lockHolder(account.dataDir), command, args })
}

async function runCommand(command: string | undefined, args: string[]): Promise<void> {
  switch (command) {
    case undefined:
    case 'run': {
      const waitPid = Number(process.env.GUGU_SERVER_WAIT_PID)
      delete process.env.GUGU_SERVER_WAIT_PID
      if (Number.isInteger(waitPid) && waitPid > 0) await waitForPidExit(waitPid)
      process.env.GUGU_TASK_HOST_USER_DATA = supervisorDataDir()
      // 旧版本按宽松 umask 建过的目录与文件:每次启动收一遍(升级换版后的第一次启动就把老机器修好)。
      tightenOwnTree()
      // 系统没有 CA 证书时给子进程(mise、agent)一份 Node 自带的,见 server-ca-bundle.ts;账号进程继承这个环境。
      ensureCaBundleForChildren(supervisorDataDir())
      const { runSupervisor } = await import('./server/server-supervisor')
      await runSupervisor()
      return
    }
    case 'run-account': {
      // 守护进程拉起的某个账号的进程:桌面同一份主进程,数据全在这个账号自己的目录里。
      const userId = args[0]
      if (!userId || !listAccounts().some((account) => account.userId === userId)) {
        stderr(`没有这个账号:${userId ?? '(未指定)'}`)
        process.exit(2)
      }
      applyAccountEnv(userId)
      ensureCaBundleForChildren(accountDataDir(userId))
      // #6264 守护进程没了(被 kill -9 / OOM)就跟着正常退出:❌ 留下攥着账号锁、跑着旧版本、谁也停不掉的孤儿。
      const { watchParent } = await import('./server/server-parent-watch')
      watchParent({
        expectedParent: process.ppid,
        currentParent: () => process.ppid,
        onOrphaned: ({ expected, now }) => {
          stderr(`[server] 守护进程(${expected})已经不在了(现在的父进程是 ${now}),这个账号进程随之退出`)
          process.kill(process.pid, 'SIGTERM')
          // 正常收尾卡住时的兜底:30 秒后强制退出。
          setTimeout(() => process.exit(0), 30_000).unref()
        },
      })
      await import('./main')
      return
    }
    case 'login': {
      const { runServerLogin } = await import('./server/server-login')
      return process.exit(await runServerLogin(undefined, args))
    }
    case 'logout': {
      const signedIn = listAccounts().filter((account) => account.signedIn)
      const who = args[0]
      const target = who
        ? signedIn.find((account) => account.email === who || account.userId === who)
        : signedIn.length === 1
          ? signedIn[0]
          : undefined
      if (!target) {
        if (signedIn.length === 0) out('这台机器上没有登录的账号。')
        else if (who) out(`这台机器上没有登录 ${who}。`)
        else out(`这台机器上登录了好几个人,请写上退出哪一个:\n${signedIn.map((a) => `  gugu-server logout ${a.email ?? a.userId}`).join('\n')}`)
        process.exit(who || signedIn.length === 0 ? 1 : 2)
      }
      // 只删登录态,这个账号的会话记录、任务库留着:同一个人再登录,东西都还在。
      fs.rmSync(path.join(target.dataDir, 'server-session.enc'), { force: true })
      // 自己退出的:不留「登录失效 / 被移除」那句解释。
      fs.rmSync(path.join(target.dataDir, 'signed-out.json'), { force: true })
      out(`已退出 ${target.email ?? target.userId}。正在运行的 server 会在几秒内停掉这个账号的进程。`)
      return process.exit(0)
    }
    case 'status': {
      const { describeService, readRunningServer } = await import('./server/server-service')
      const running = readRunningServer()
      out(`版本:${process.env.GUGU_TASK_HOST_VERSION ?? '(开发构建)'}`)
      out(`数据目录:${serverHome}`)
      // 在跑的那个可能还是旧版本(等空闲才切):版本以它自己的为准,❌ 拿这条命令自己的版本冒充。
      out(`运行状态:${running ? `在运行(进程 ${running.pid}${running.version ? `,版本 ${running.version}` : ''})` : '没在运行'}`)
      out(`常驻服务:${describeService()}`)
      const { formatAccountLines, formatStatusJson, statusAccounts } = await import('./server/server-status')
      const all = listAccounts()
      const pidOf = (userId: string) => {
        const account = all.find((a) => a.userId === userId)
        return account ? lockHolder(account.dataDir) : null
      }
      const accounts = statusAccounts(all, (account) => pidOf(account.userId) !== null)
      for (const line of formatAccountLines(accounts, pidOf)) out(line)
      // 咕咕桌面经 SSH 读的那一份(机器显示离线时,问清是没开机还是登录没了)。
      if (args.includes('--json')) {
        process.stdout.write(formatStatusJson({ version: process.env.GUGU_TASK_HOST_VERSION ?? null, accounts }))
      }
      return process.exit(0)
    }
    case 'service': {
      const { installService, uninstallService } = await import('./server/server-service')
      if (args[0] === 'install') {
        // 非 0 = 结束时在跑的不是这一版(原因与下一步已经打出来了),install.sh 据此不报成功。
        return process.exit((await installService(out)) ? 0 : 1)
      }
      if (args[0] === 'uninstall') uninstallService(out)
      else {
        stderr(`用法:gugu-server service install | uninstall`)
        process.exit(2)
      }
      return process.exit(0)
    }
    case 'stop': {
      // #6264 先告诉看门人「是有人要停」,再停守护进程;最后把漏网的账号进程(孤儿)一并收掉。
      const { liveKeeperPid, markStopped } = await import('./server/server-keeper')
      markStopped(serverHome)
      const keeper = liveKeeperPid(serverHome)
      if (keeper !== null) {
        try {
          process.kill(keeper, 'SIGTERM')
        } catch {
          // 已经退出了
        }
      }
      const pid = lockHolder(supervisorDataDir())
      if (pid) {
        process.kill(pid, 'SIGTERM')
        if (!(await waitForPidExit(pid, 45_000))) {
          stderr(`进程 ${pid} 45 秒内没有退出。`)
          process.exit(1)
        }
      }
      const strays = await stopAccountProcesses()
      if (!pid && strays.length === 0) {
        out('server 没在运行。')
        process.exit(0)
      }
      out(strays.length > 0 ? `已停止(另收掉了 ${strays.length} 个没随守护进程退出的账号进程)。` : '已停止。')
      const { describeService } = await import('./server/server-service')
      if (!describeService().startsWith('未注册')) {
        out('注意:常驻服务会把 server 重新拉起来;要彻底停用请执行 gugu-server service uninstall。')
      }
      return process.exit(0)
    }
    case 'unregister': {
      // 卸载前逐个账号调:从账号里移除这台机器、注销它的续期令牌、删本地登录态(见 server-unregister.ts)。
      const i = args.indexOf('--account')
      const userId = i >= 0 ? args[i + 1] : undefined
      if (!userId || !listAccounts().some((account) => account.userId === userId)) {
        stderr(`没有这个账号:${userId ?? '(未指定)'}`)
        return process.exit(2)
      }
      applyAccountEnv(userId)
      const { unregisterAccountNow } = await import('./server/server-unregister-wiring')
      await unregisterAccountNow(userId, out)
      return process.exit(0)
    }
    case 'link': {
      const { parseLinkArgs, runLink } = await import('./server/link-cli')
      const { pickAttachAccount } = await import('./server/account-call')
      const parsed = parseLinkArgs(args)
      const matched = 'error' in parsed ? null : runningVersionFirst(command, args, pickAttachAccount(listAccounts(), parsed.account))
      if (matched !== null) return process.exit(matched)
      return process.exit(await runLink(args))
    }
    case 'selftest': {
      const { runSelftest } = await import('./server/server-selftest')
      return process.exit(await runSelftest(out))
    }
    case 'keep': {
      // 开机自启(crontab @reboot)起的是看门人,由它拉起守护进程、之后崩了再拉起(server-keeper.ts)。
      const { liveKeeperPid, startKeeper } = await import('./server/server-keeper')
      if (liveKeeperPid(serverHome) !== null || lockHolder(supervisorDataDir())) return process.exit(0)
      fs.mkdirSync(path.join(supervisorDataDir(), 'logs'), { recursive: true })
      startKeeper({ home: serverHome, logFile: path.join(supervisorDataDir(), 'logs', 'service.log') })
      return process.exit(0)
    }
    case 'upgrade-guard': {
      const { runUpgradeGuard } = await import('./server/server-upgrade-guard')
      return process.exit(await runUpgradeGuard(serverHome, out))
    }
    case 'open-url': {
      const { runOpenUrl } = await import('./server/open-url-cli')
      return process.exit(await runOpenUrl(args))
    }
    case 'match-version': {
      const { runMatchVersion } = await import('./server/match-version-cli')
      const { runningVersionOf } = await import('./server/server-version-match')
      const read = (file: string): string | null => {
        try {
          return fs.readFileSync(file, 'utf8')
        } catch {
          return null
        }
      }
      return process.exit(await runMatchVersion(args, out, stderr, {
        home: serverHome,
        runningVersion: (account) => {
          const pid = lockHolder(account.dataDir)
          if (pid === null) return null
          // /proc 只有 Linux 有;macOS 上读账号进程自己每 10 秒写的忙闲(带着版本与进程号)。
          const activity = (() => {
            try {
              return JSON.parse(read(path.join(account.dataDir, 'activity.json')) ?? '') as { pid?: unknown; version?: unknown }
            } catch {
              return {}
            }
          })()
          return runningVersionOf(pid, read) ?? (activity.pid === pid && typeof activity.version === 'string' ? activity.version : null)
        },
        supervisorRunning: () => lockHolder(supervisorDataDir()) !== null,
      }))
    }
    case 'help':
    case '--help':
    case '-h':
      out(USAGE)
      return process.exit(0)
    // 桌面经 SSH 装机时读(ssh-install/logic.ts probeScript):这份 server 说哪一版桌面↔server 协议。
    // 不认这条命令的老版本 = 比现在的桌面要求的还老(serverProtocolTooOld)。
    case 'protocol':
      out(String(REMOTE_PROTOCOL_VERSION))
      return process.exit(0)
    case 'version':
    case '--version':
    case '-v':
      // 只报这条命令自己的版本;在跑的那个是哪一版看 status(可能等空闲才切)。
      out(process.env.GUGU_TASK_HOST_VERSION ?? '(开发构建)')
      return process.exit(0)
    default:
      stderr(`不认识的命令:${command}\n${USAGE}`)
      return process.exit(2)
  }
}

void runCommand(process.argv[2], process.argv.slice(3)).catch(fail)
