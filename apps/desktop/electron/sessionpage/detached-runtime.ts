// @@@4467 哪些会话页会话的进程活得比宿主久 —— tmux 模式下,宿主退出只 detach,harness 仍在 tmux 服务器里跑。
//
// 平台票的去留要问这个:宿主退出时,会话仍在 tmux 里跑、且凭据不经宿主供给的票保留(账本行标 detached);
// 下次启动时再问一次,还在跑就接回续期,不在了就结清。判据是 tmux 服务器里那条会话名 —— 名字由
// PTY session id(`<projectId>:<conversationId>:<conversationId>`)编码而来,这里只解码,❌ 另造一套命名。
//
// ⚠️ 「没有 tmux 服务器」是一个读数(= 没有活会话);「tmux 调用失败」不是 —— 它必须抛出,❌ 当成空集。
// 空集会让结清把仍在跑的会话的票撤掉,那个进程下一轮就 401。

import { LocalExecutionContext } from '../session/main/core/execution-context/local-execution-context'
import type { IExecutionContext } from '@gugu/session-core/exec'
import { listTmuxSessionNames } from '../session/main/core/pty/tmux-session-name'
import { sessionsAliveInTmux } from '../session/main/core/sessions/session-process'

/** 本机 tmux 服务器里引擎仍在运行的会话页会话。没有 tmux 服务器 = 空集;调用失败 = 抛出。判据与接回同一个。 */
export async function liveTmuxSessionIds(
  ctx: Pick<IExecutionContext, 'supportsLocalSpawn' | 'exec'> = new LocalExecutionContext(),
): Promise<Set<string>> {
  return sessionsAliveInTmux(await listTmuxSessionNames(ctx))
}
