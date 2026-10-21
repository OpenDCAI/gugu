import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessStartupError } from '@gugu/session-core/agents/plugins'
import {
  CodexAppServerSession,
  CodexRpcReplyError,
  describeCodexStartFailure,
} from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'
import { CodexAppServerExitedError } from '../../../../apps/desktop/electron/sessionpage/codex-app-server-transport'
import { startupFailureForUser } from '../../../../apps/desktop/electron/session/main/core/sessions/spawn-failure'
import { safeFailureLine } from '../../../../apps/desktop/src/session/renderer/features/sessions/gugu-reason'
import { cachedFixtureExecutable } from '../../../support/cachedFixtureExecutable'

// #7103 谁拒绝谁说话:Codex 起步那一段里,只有 codex 自己说的(它在就绪前自己退出 / 起 codex 本体的系统错误 / 它回的
// JSON-RPC 错 / 版本不兼容)才包成它的原话,界面那一行是它 stderr 的最后一行;超时、建端点目录、起 tmux 是咕咕的,到界面之前
// 由起任务失败的分层说成「咕咕这边出错了」(评审 r4 G2、r4b H1–H3)。两种都照旧带着 codex 的 stderr 写进原文,日志读得到(#2808)。
// 咕咕超时、拆进程时 codex 才打出来的那一行(#2808「迟到的 stderr」)归类在 codexAppServerWindowsTransport.test。
// 交到界面的那一句按 Electron 的 `error.toString()` 拼 IPC 串,❌ 带类名(评审 r4 G1)。

/** @@@4918 正文逐字稳定(内容寻址);在端点就绪前退出,模拟 codex 自己起不来。 */
const EXITS_BEFORE_READY = `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.155.1\\n')
  process.exit(0)
}
process.stderr.write('codex: config.toml is broken\\n')
process.exit(3)
`

const ipc = (error: unknown) => `Error invoking remote method 'sessions.hydrateSession': ${String(error)}`

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-codex-start-7103-'))
  roots.push(dir)
  return dir
}

describe('#7103 Codex 起步失败按层分', () => {
  it('咕咕自己的错(thread/start 参数翻不成 TUI 参数)原样抛,到界面是「咕咕这边出错了」', async () => {
    const session = new CodexAppServerSession('agent-7103-gugu-side', '/nonexistent/codex', undefined, {
      platform: process.platform,
      startupTimeoutMs: 500,
    })
    const failed = await session
      .start(await root(), { tuiLoads: 'create', threadStart: { approvalsReviewer: 'user' } })
      .then(() => null, (error: unknown) => error)
    expect(failed).toBeInstanceOf(Error)
    expect(failed).not.toBeInstanceOf(HarnessStartupError)
    expect((failed as Error).message).toContain('没有对应的 TUI 启动参数')
    expect((failed as Error).message).not.toContain('Codex stderr')
    expect(String(startupFailureForUser(failed))).toBe('Error: gugu-models:service-unavailable')
  })

  it('codex 自己在就绪前退出:递它的话,界面上那一行没有类名', async () => {
    const codexBin = cachedFixtureExecutable('codex-exits-before-ready-7103.mjs', EXITS_BEFORE_READY)
    const session = new CodexAppServerSession('agent-7103-codex-side', codexBin, undefined, {
      platform: process.platform,
      startupTimeoutMs: 10_000,
    })
    const failed = await session
      .start(await root(), { env: { ...process.env } })
      .then(() => null, (error: unknown) => error)
    expect(failed).toBeInstanceOf(HarnessStartupError)
    const told = startupFailureForUser(failed)
    expect(String(told)).toMatch(/^Error: codex: config.toml is broken\n/)
    expect((told as Error).message).toContain('exited before endpoint ready')
    // 界面那一行是 codex 自己的话(它 stderr 的最后一行),咕咕包的那句只在后面几行、进日志。
    expect(safeFailureLine(ipc(told))).toBe('codex: config.toml is broken')
    // 阴控:要是把 harness 的错原样交给 Electron,类名就会跟着上屏 —— 上面那条判的正是这一层。
    expect(safeFailureLine(ipc(failed))).toMatch(/^HarnessStartupError: /)
  })

  // 判归类的那一张表本身(不起进程):H1 超时一律算咕咕的,H2 只认起 codex 本体的系统错误,H3 界面那一行。
  describe('describeCodexStartFailure', () => {
    const bin = '/opt/homebrew/bin/codex'
    const errno = (syscall: string, path: string) =>
      Object.assign(new Error(`${syscall} ENOENT`), { code: 'ENOENT', errno: -2, syscall, path })

    it('起 tmux / 建端点目录的系统错误是咕咕的,起 codex 本体的才算 codex 说的', () => {
      expect(describeCodexStartFailure(bin, errno('spawn tmux', 'tmux'), '')).not.toBeInstanceOf(HarnessStartupError)
      expect(describeCodexStartFailure(bin, errno('mkdir', '/tmp/gugu-codex-endpoint'), '')).not.toBeInstanceOf(HarnessStartupError)
      expect(describeCodexStartFailure(bin, errno(`spawn ${bin}`, bin), '')).toBeInstanceOf(HarnessStartupError)
    })

    it('超时是咕咕的,哪怕 stderr 里有话(只进原文);codex 自己退出才看它的 stderr,界面那一行是最后一行非空内容', () => {
      const timeout = describeCodexStartFailure(bin, new Error('codex app-server WS 握手未在 250ms 内完成'), 'late Codex startup failure\n')
      expect(timeout).not.toBeInstanceOf(HarnessStartupError)
      expect(timeout.message).toContain('late Codex startup failure')
      const exited = describeCodexStartFailure(
        bin,
        new CodexAppServerExitedError('codex app-server exited before endpoint ready (code=3 signal=null)'),
        'WARN loading plugins\ncodex: config.toml is broken\n\n',
      )
      expect(exited).toBeInstanceOf(HarnessStartupError)
      expect(exited.message.split('\n')[0]).toBe('codex: config.toml is broken')
      expect(exited.message).toContain('Codex app-server 启动失败')
    })

    // 评审 r4c J1:codex 回 JSON-RPC 错时,它说的是那个错的 message;拆进程时 stderr 里冒出来的行 ❌ 当原因。
    it('codex 回的 JSON-RPC 错:界面那一行是它的 message,不是 stderr 最后一行', () => {
      const replied = describeCodexStartFailure(
        bin,
        new CodexRpcReplyError({ code: -32600, message: 'model gpt-x is not supported' }),
        'WARN codex_core::config: unknown key `foo` in config.toml\nreceived SIGTERM, shutting down\n',
      )
      expect(replied).toBeInstanceOf(HarnessStartupError)
      expect(replied.message.split('\n')[0]).toBe('model gpt-x is not supported')
      expect(replied.message).toContain('received SIGTERM, shutting down')
    })
  })
})
