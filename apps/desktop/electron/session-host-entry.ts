// @@@task-web-host 方案 B — 会话页的无头宿主:没有 Electron 窗口,浏览器里的会话页经 WebSocket 连进来。
//
// ⚠️ 这个文件住在**宿主树**(与 main.ts 同级),❌ 不在 electron/session/ 下:它是网页形态的宿主,
// 要 import 宿主侧模块(身份供给);而会话页树 ❌ 不许 import 宿主模块(理由=
// 模块级状态会被复制一份)。方向只有一个:宿主 import 引擎,与 main.ts 同。
//
// 进程形态:用 Electron 二进制当 node 起(ELECTRON_RUN_AS_NODE=1),原生模块(sqlite / pty)保持
// Electron 的 ABI,一个都不用重编。这个开关下 require('electron') 只会得到一个路径字符串,所以
// 在加载任何宿主模块**之前**把 require('electron') 钉到替身模块(electron-shim.ts)。
// ⚠️ 下面的宿主模块必须 **动态** import:cjs 产物会把静态 import 的 require('electron') 提升到
// chunk 顶部、在钩子装上之前执行。
import Module from 'node:module'
import * as electronShim from './session/headless/electron-shim'

type ModuleLoader = (request: string, ...rest: unknown[]) => unknown
const moduleInternals = Module as unknown as { _load: ModuleLoader }
const originalLoad = moduleInternals._load
// 替身没覆盖的成员:访问到就响亮记一笔(带成员名),再返回 undefined —— 随后的 TypeError 才有据可查。
// (第一次真跑就是这样撞出 electron-updater 要 autoUpdater 的。)
// 宿主的 logger 要在钩子装好之后才能 import(它 import electron.app),钩子前的两处只能写 stderr。
const stderr = (line: string): void => void process.stderr.write(`${line}\n`)
const warnedMembers = new Set<PropertyKey>()
const shimWithLoudMisses = new Proxy(electronShim as Record<PropertyKey, unknown>, {
  get(target, key) {
    if (key in target || key === '__esModule' || key === 'default' || typeof key !== 'string') {
      return Reflect.get(target, key)
    }
    if (!warnedMembers.has(key)) {
      warnedMembers.add(key)
      stderr(`[headless] electron.${key} 未在 electron-shim.ts 覆盖 —— 某个模块在用它,补上替身`)
    }
    return undefined
  },
})
moduleInternals._load = function patchedLoad(this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'electron') return shimWithLoudMisses
  return originalLoad.call(this, request, ...rest)
}

async function main(): Promise<void> {
  const { startSessionHostWsServer } = await import('./session/main/host-ws/server')
  const { bootSessionHostCore, disposeEmdashModule, setSessionMessageRouter } = await import(
    './session/main/embedded-boot'
  )
  const { log } = await import('./session/main/lib/logger')

  // 咕咕壳(main.ts)在 boot 前给任务宿主接的十几个融合钩子里,只有这一个是 boot 硬要求的:
  // 会话页 agent 发给咕咕聊天的消息由它投递。web 形态里咕咕壳在浏览器、宿主没有咕咕身份,
  // 这条投递还没接线 → 返回 not-ready(消息留在 outbox 等宿主就绪),❌ 假 accepted。
  let warnedRouter = false
  setSessionMessageRouter(async (sessionId) => {
    if (!warnedRouter) {
      warnedRouter = true
      log.warn('[session-host] 会话页→咕咕聊天的投递在 web 形态尚未接线,消息留在 outbox', {
        sessionId,
      })
    }
    return { status: 'not-ready' as const }
  })

  // @@@5080 这一行是「和桌面版共不共一份会话」的唯一可见读数。origin 三态:
  //   desktop-pointer      = 跟桌面壳同一份(owner 要的那个「只是换个视窗」)
  //   GUGU_TASK_HOST_USER_DATA = 被显式指定(e2e / 隔离实例)
  //   standalone-default   = 这台机器没跑过桌面壳,自己一份
  // ❌ 别把它降级成 debug:少了它,「为什么还是两份数据」就只能靠猜。
  const { resolvedUserData } = electronShim as unknown as {
    resolvedUserData: () => { path: string; origin: string }
  }
  const userData = resolvedUserData()
  log.info(`[session-host] user data: ${userData.path} (origin=${userData.origin})`)

  const server = await startSessionHostWsServer({
    host: process.env.GUGU_TASK_HOST_BIND,
    port: process.env.GUGU_TASK_HOST_PORT ? Number(process.env.GUGU_TASK_HOST_PORT) : undefined,
    token: process.env.GUGU_TASK_HOST_TOKEN,
  })
  await bootSessionHostCore({ hostIpc: server.hostIpc, browserFeatures: false })
  // @@@task-shell-port (#5012) 会话身份:浏览器交登录态,宿主给每条会话开咕咕账号并绑上(分享 / 寻址的前提)。
  // 动态 import:它经 electron/supabase.ts 静态 require('electron'),必须在上面的 Module._load 钩子之后加载。
  const { wireHeadlessSessionpageIdentity } = await import('./sessionpage/headless-identity')
  const identity = wireHeadlessSessionpageIdentity(server.hostIpc)

  const wsUrl = `ws://${server.host}:${server.port}/`
  // 浏览器要的两样东西:宿主地址 + token。打印成可直接拼进地址栏的 hash 形式。
  // 这两行是给人/启动脚本看的运行状态(探针按 `[task-host] ready` 判就绪),走 stdout 不走日志。
  process.stdout.write(
    `[session-host] ready — session page backend serving on ${wsUrl}\n` +
      `[session-host] open the web app with: #sessionHost=${encodeURIComponent(wsUrl)}&sessionHostToken=${server.token}\n`,
  )

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`[session-host] ${signal} — shutting down`)
    identity.dispose()
    void disposeEmdashModule()
      .catch((error: unknown) => log.error('[session-host] dispose failed', error))
      .then(() => server.close())
      .finally(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// @@@unhandled-error-event (#4942) — 无头宿主的顶层保护。
//
// 这个进程**真的这么死过**:一次 teardown 期的 EPIPE 走到没人订阅的 'error' 上,node 把它抛成未捕获
// 异常,整个宿主连同它承载的所有任务会话一起没了,而日志里一个字都没有 —— 浏览器那边只看到「会话页
// 宿主未连接」,查了两轮才找到是宿主自己死了、不是隧道断了(#4935 验收现场)。根因按类修在进程层
// (#4942),这里是最后一道网:该死照旧死,但**死之前必须留下一句话**。
//
// 用 stderr 不用 log:log 是在 main() 里动态 import 的,挂在它上面会让整个启动窗口没有保护。
// 与咕咕壳 main.ts 的那一对保持同一口径:未捕获异常退出码 1,未处理拒绝只记一行、不退出(未必致命)。
process.on('uncaughtException', (error: unknown) => {
  stderr(
    `[session-host] 未捕获异常 — 宿主退出: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  )
  process.exit(1)
})
process.on('unhandledRejection', (reason: unknown) => {
  stderr(
    `[session-host] 未处理的 Promise 拒绝: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  )
})

main().catch((error: unknown) => {
  stderr(`[session-host] boot failed — session page backend unavailable: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
