/**
 * `gugu-server open-url [--account <账号 id>] [--] <网址或文件>`(#6264):这台机器上的程序要「打开网页」时,
 * `$BROWSER` / xdg-open 的助手脚本调它(脚本见 ../session/main/core/pty/server-browser-env.ts)。
 *
 * 照 VS Code 远端的 `$BROWSER`(server.cli.ts 的 openExternal):把网址经本机套接字交给这个账号的进程,
 * 它转到正看着这台机器的咕咕桌面上打开(remote-open-external.ts)。
 *  · 开了:安静退出 0(程序照常往下走,比如 `gh auth login --web` 等浏览器那头回来)。
 *  · 攒着了(此刻没有桌面看着):退出 0,在标准错误里说一句、并把网址打出来 —— 人可以自己复制。
 *  · 开不了:退出 1,同样打出网址;大多数程序见 $BROWSER 失败会自己打印网址让人手动开。
 *
 * 输出给程序与人看:一句话、中英各一,❌ 堆原因码。
 * ⚠️ 只在 CLI 里跑:不碰 electron、不加载主进程,起得快。
 */
import { ATTACH_EXIT, OPEN_EXTERNAL_CALL } from '../session/main/core/pty/attach/attach-protocol'
import { callAccountProcess, pickAttachAccount } from './account-call'
import { listAccounts } from './server-layout'

const ID = /^[A-Za-z0-9_-]{1,128}$/

export function parseOpenUrlArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { account: string | null; target: string } | { error: string } {
  let account: string | null = null
  const rest: string[] = []
  let literal = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!literal && arg === '--') literal = true
    else if (!literal && arg === '--account') account = args[++i] ?? ''
    else if (!literal && arg.startsWith('--account=')) account = arg.slice('--account='.length)
    else rest.push(arg)
  }
  if (account !== null && !ID.test(account)) return { error: '--account 后面要写账号 id' }
  const fromEnv = env.GUGU_SERVER_ACCOUNT?.trim()
  if (account === null && fromEnv && ID.test(fromEnv)) account = fromEnv
  const target = rest[0]?.trim() ?? ''
  if (!target) return { error: '用法:gugu-server open-url [--account <账号 id>] <网址或文件>' }
  return { account, target }
}

type Io = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

export async function runOpenUrl(
  args: readonly string[],
  io: Io = process,
  deps: {
    env?: NodeJS.ProcessEnv
    cwd?: () => string
    accounts?: typeof listAccounts
    call?: typeof callAccountProcess
  } = {},
): Promise<number> {
  const env = deps.env ?? process.env
  const parsed = parseOpenUrlArgs(args, env)
  if ('error' in parsed) {
    io.stderr.write(`${parsed.error}\n`)
    return 2
  }
  const fallback = (why: string) => {
    io.stderr.write(`${why}\n  ${parsed.target}\n`)
  }
  const account = pickAttachAccount((deps.accounts ?? listAccounts)(), parsed.account)
  if ('error' in account) {
    fallback('咕咕:没能转到你的电脑上打开,请手动打开这个地址 / Gugu could not open this on your computer; open it yourself:')
    return ATTACH_EXIT.notSignedIn
  }
  const outcome = await (deps.call ?? callAccountProcess)(account, {
    type: OPEN_EXTERNAL_CALL,
    payload: { target: parsed.target, cwd: (deps.cwd ?? process.cwd)(), ptyId: env.GUGU_PTY_ID ?? '' },
  })
  if ('code' in outcome) {
    fallback('咕咕:没能转到你的电脑上打开,请手动打开这个地址 / Gugu could not open this on your computer; open it yourself:')
    return 1
  }
  let reply: { result?: { outcome?: string }; error?: { code?: string; message?: string } } = {}
  try {
    reply = JSON.parse(outcome.reply.toString('utf8')) as typeof reply
  } catch {
    reply = {}
  }
  if (reply.result?.outcome === 'opened') return 0
  if (reply.result?.outcome === 'queued') {
    fallback('咕咕:此刻没有人在看这台机器,下次在咕咕里打开这条会话时会自动打开 / Nobody is viewing this machine in Gugu right now; it will open next time:')
    return 0
  }
  fallback(
    `咕咕:没能在你的电脑上打开 / Gugu could not open this on your computer${reply.error?.message ? ` (${reply.error.message})` : ''}:`,
  )
  return 1
}
