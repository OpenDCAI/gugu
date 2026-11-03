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
import path from 'node:path'
import { isOwnProcessAlive, isProcessAlive, SERVER_PROCESS_MARK } from './server/process-alive'
import { ensureCaBundleForChildren } from './server/server-ca-bundle'
import {
  applyAccountEnv,
  readServerAccount,
  readSignedOutMark,
  supervisorDataDir,
  writeSignedOutMark,
} from './server/server-layout'
import * as serverShim from './server/server-electron-shim'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { ensurePrivateDir, summarizeChanges, tightenServerTree } from './server/server-permissions'
import { assertRuntimeBackend, ownPackageIdentity, packageBackend, packageIdentity, prepareInstallation } from './server/server-package-environment.mts'
import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { resolveServerHome } from './server/server-installation'
import { inspectAccountLayout } from './server/server-boot.cjs'
import { homeLockHolder } from './server/server-startup'


const stderr = (line: string): void => void process.stderr.write(`${line}\n`)

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
// 人显式设的 GUGU_TIER(开发覆盖)照旧原样传下去。
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
// (守护进程用 data/,账号数据用 account/data/,login 要等换到令牌、知道是谁之后才定)。见 server-layout.ts。

const USAGE = `用法:
  gugu-server                    运行咕咕 server(常驻;一般由系统服务拉起)
  gugu-server login              ${REMOTE_TUNNEL_OPEN ? '在这台服务器上登录一个咕咕账号(链接 + 短码,不需要浏览器)' : '远程隧道暂未开放:在咕咕桌面用远程 SSH 添加这台机器'}
                                 一个系统用户只能登录一个咕咕账号;另一个账号请使用另一个系统用户
  gugu-server login --grant-stdin 用咕咕桌面经 SSH 递来的一次性凭证登录(桌面自动调用,不用手敲)
  gugu-server login [--name 名字] 这台机器在设备列表里的默认名(两种登法都认;桌面带上人填的 SSH 别名)
  gugu-server logout [邮箱]      退出登录(登录了好几个人时写上是谁)
  gugu-server status [--json]    看看版本、登录了谁、在不在跑、数据放在哪;登录失效 / 被移除的账号也列出来
  gugu-server --version          只打出这份咕咕 server 的版本号
  gugu-server service install    注册常驻服务:SSH 断开不停、重启自己起来(不要 root)
  gugu-server start              启动已安装的 server 或重新登录后恢复运行
  gugu-server service uninstall  移除常驻服务
  gugu-server stop               停掉正在运行的 server(连同各账号的进程)
  gugu-server selftest           检查这份咕咕 server 在这台机器上能不能跑(原生模块、自带的 tmux)
  gugu-server prepare-install    安装器核对包与既有安装的环境(不读取账号凭据)
  gugu-server unregister
                                 把这台机器从这个账号里移除并注销登录(卸载时自动调用)
  gugu-server link [--adopt-ssh]
                                 把标准输入输出接到这个账号的咕咕 server 上(远程 SSH:桌面经 SSH 自动调用)
  gugu-server open-url <网址或文件>
                                 在正看着这台机器的咕咕桌面上打开网页(这台机器上的 $BROWSER 就是它)
  gugu-server resume
                                 通知保留的账号进程恢复连接并立即补收消息
  gugu-server match-version (--desktop <桌面 id> --version <版本> | --apply <版本>)
                                 旧桌面兼容入口:查看 current/已准备目标，或确认重启到已准备目标`

function fail(error: unknown): never {
  stderr(`[server] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
}

const out = (line: string): void => void process.stdout.write(`${line}\n`)

/** 读某个目录下单实例锁里的进程号(锁在但进程已死、或进程号已被别的程序复用 = 没在跑)。 */
function lockHolder(dataDir: string): number | null {
  try {
    if (dataDir === supervisorDataDir()) return homeLockHolder(serverHome)
    const pid = Number(fs.readFileSync(path.join(dataDir, 'server.lock'), 'utf8').trim())
    return isOwnProcessAlive(pid, SERVER_PROCESS_MARK) ? pid : null
  } catch {
    return null
  }
}

async function stopServerProcess(pid: number, graceMs: number): Promise<void> {
  const { signalProcessDescendantsSync } = await import('@gugu/session-core/acp/node')
  try { process.kill(pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
  if (await waitForPidExit(pid, graceMs)) return
  // Snapshot the owned live root before severing its detached descendants' parent chain.
  let cleanupError: unknown
  try { signalProcessDescendantsSync([pid], 'SIGKILL') }
  catch (error) { cleanupError = error }
  try { process.kill(pid, 'SIGKILL') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  out(`Server did not exit after TERM; used KILL for pid ${pid}.`)
  if (!(await waitForPidExit(pid, 5_000))) throw new Error(`Process ${pid} did not exit after KILL`)
  if (cleanupError) throw cleanupError
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
  } catch (error) {
    stderr(`[server] 收紧数据目录权限失败:${error instanceof Error ? error.message : String(error)}`)
  }
}

function prepareRuntimeInstallation(): void {
  const identity = ownPackageIdentity()
  assertRuntimeBackend(identity, getSupabaseUrl())
  prepareInstallation(serverHome, identity, {
    updateOwner: process.env.GUGU_CLOUD_COMPUTER === '1' ? 'controller' : undefined,
  })
}

/** Both run and the deployed supervisor's boot probe enter this exact account body. */
async function runAccount(userId: string, directory: string): Promise<void> {
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Account directory is unavailable: ${directory}`)
  applyAccountEnv(userId, process.env, directory)
  ensureCaBundleForChildren(path.join(directory, 'data'))
  await import('./main')
}

async function runCommand(command: string | undefined, args: string[]): Promise<void> {
  if (['start', 'run-account', 'login', 'logout', 'unregister', 'resume', 'match-version'].includes(command ?? '')
    || (command === 'service' && args[0] === 'install')) {
    prepareRuntimeInstallation()
  }
  switch (command) {
    case 'prepare-install': {
      const argument = (name: string): string | undefined => {
        const index = args.indexOf(name)
        return index < 0 ? undefined : args[index + 1] || undefined
      }
      const directory = argument('--candidate')
      const own = ownPackageIdentity()
      const channel = argument('--channel') ?? own.channel
      const owner = argument('--update-owner') ?? 'server'
      if (owner !== 'server' && owner !== 'controller') throw new Error('Invalid server update owner')
      let identity = own
      if (directory) {
        if (path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(path.join(serverHome, 'versions'))) throw new Error('Candidate is outside the installation')
        const metadata = path.join(directory, 'app', 'dist-electron', 'server-build.json')
        identity = fs.existsSync(metadata) ? packageIdentity(JSON.parse(fs.readFileSync(metadata, 'utf8')))
          : packageIdentity({ schema: 1, backendUrl: packageBackend(directory), channel })
      }
      if (channel !== identity.channel) throw new Error('Requested update channel does not match the compiled server package')
      const installation = prepareInstallation(serverHome, identity, {
        updateOwner: owner, migrateFrom: argument('--migrate-from'),
      })
      if (owner === 'controller' && directory) {
        if (args.includes('--activate')) {
          const { activateServerPackage, ServerPackageDeferredError } = await import('./server/server-version-lifecycle')
          try {
            await activateServerPackage(serverHome, directory, { migrateFrom: argument('--migrate-from') })
          } catch (error) {
            if (error instanceof ServerPackageDeferredError) { stderr(error.message); return process.exit(75) }
            throw error
          }
        } else {
          const { checkAccountBoot } = await import('./server/server-selftest')
          await checkAccountBoot(path.join(directory, 'bin', 'gugu-server'))
        }
      }
      out(JSON.stringify(installation))
      return process.exit(0)
    }
    case undefined:
    case 'run': {
      // 旧版本按宽松 umask 建过的目录与文件:每次启动收一遍(升级换版后的第一次启动就把老机器修好)。
      const { runSingleServer } = await import('./server/server-run')
      await runSingleServer(() => {
        tightenOwnTree()
        prepareRuntimeInstallation()
      }, runAccount)
      return
    }
    case 'run-account': {
      // Compatibility for already deployed supervisors: no home lock, the same main and account lock.
      const userId = args[0]
      if (!userId || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId) || !fs.existsSync(path.join(serverHome, 'accounts', userId))) {
        stderr(`没有这个账号:${userId ?? '(未指定)'}`)
        process.exit(2)
      }
      await runAccount(userId, path.join(serverHome, 'accounts', userId))
      return
    }
    case 'start': {
      const { restartServerAfterLogin } = await import('./server/server-service')
      restartServerAfterLogin(out)
      return process.exit(0)
    }
    case 'login': {
      const { runServerLogin } = await import('./server/server-login')
      return process.exit(await runServerLogin(undefined, args))
    }
    case 'logout': {
      const target = readServerAccount()
      const who = args[0]
      if (!target?.signedIn || (who && target.email !== who && target.userId !== who)) {
        out(target?.signedIn ? `This server is signed in as ${target.email ?? target.userId}.` : '这台机器上没有登录的账号。')
        return process.exit(1)
      }
      // 只删登录态,这个账号的会话记录、任务库留着:同一个人再登录,东西都还在。
      fs.rmSync(path.join(target.dataDir, 'server-session.enc'), { force: true })
      writeSignedOutMark(target.dataDir, 'logout')
      const pid = lockHolder(target.dataDir)
      if (pid) try { process.kill(pid, 'SIGTERM') } catch { /* Already stopped. */ }
      out(`已退出 ${target.email ?? target.userId}。server 已请求停止;账号数据保留。`)
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
      const { formatAccountLines, formatStatusJson } = await import('./server/server-status')
      const { readAccountRuntime, installedPackageVersion } = await import('./server/server-account-runtime')
      // Diagnostic only: an interrupted migration must not look like an empty installation.
      const inventory = inspectAccountLayout(serverHome)
      const migrationRequired = inventory.some(account => account.dir !== path.join(serverHome, 'account'))
      if (migrationRequired) out(`需要先执行 gugu-server start 迁移账号目录：${inventory.map(account => account.email ?? account.id).join(', ')}`)
      const runtimes = new Map(inventory.map(account => [account.id, readAccountRuntime(path.join(account.dir, 'data'))]))
      const pidOf = (userId: string) => runtimes.get(userId)?.pid ?? null
      const accounts = inventory.map(account => ({ userId: account.id, email: account.email,
        signedIn: account.signedIn, running: account.signedIn && pidOf(account.id) !== null,
        version: account.signedIn ? runtimes.get(account.id)?.version ?? null : null,
        signedOut: account.signedIn ? null : readSignedOutMark(path.join(account.dir, 'data')) }))
        .filter(account => migrationRequired || account.signedIn || account.signedOut)
      for (const line of formatAccountLines(accounts, pidOf)) out(line)
      // 咕咕桌面经 SSH 读的那一份(机器显示离线时,问清是没开机还是登录没了)。
      if (args.includes('--json')) {
        process.stdout.write(formatStatusJson({ version: process.env.GUGU_TASK_HOST_VERSION ?? null, installedVersion: installedPackageVersion(serverHome), supervisorVersion: running?.version ?? null, accounts, ...(migrationRequired ? { migrationRequired: true } : {}) }))
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
      if (pid) await stopServerProcess(pid, 45_000)
      if (!pid) { out('server 没在运行。'); return process.exit(0) }
      out('已停止。')
      out('再次启动请执行 gugu-server start;移除开机自启请执行 gugu-server service uninstall。')
      return process.exit(0)
    }
    case 'unregister': {
      const account = readServerAccount()
      const i = args.indexOf('--account')
      const requested = i >= 0 ? args[i + 1] : undefined
      if (!account || (requested !== undefined && requested !== account.userId)) {
        stderr(account ? `当前账号是 ${account.email ?? account.userId}，与请求的账号不符。` : '这台机器上还没有配置账号。')
        return process.exit(78)
      }
      const userId = account.userId
      applyAccountEnv(userId)
      const { unregisterAccountNow } = await import('./server/server-unregister-wiring')
      await unregisterAccountNow(userId, out)
      return process.exit(0)
    }
    case 'link': {
      const { runLink } = await import('./server/link-cli')
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
    case 'open-url': {
      const { runOpenUrl } = await import('./server/open-url-cli')
      return process.exit(await runOpenUrl(args))
    }
    case 'resume': {
      const { runResume } = await import('./server/resume-cli')
      return process.exit(await runResume(args))
    }
    case 'match-version': {
      const { runMatchVersion } = await import('./server/match-version-cli')
      const { runningVersionOf } = await import('./server/server-account-runtime')
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
