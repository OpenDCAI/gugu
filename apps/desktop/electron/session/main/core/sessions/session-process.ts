/**
 * 一条会话此刻的进程归谁管、这一代是怎么来的 —— 唯一的事实,只由起进程的那一处写(`LocalSessionProvider`)。
 *
 * - `home`:`host` = 宿主进程退出它就没了;`tmux` = 宿主退出只 detach,引擎仍在 tmux 服务器里跑。
 * - `start`:`fresh` = 这一代新起了引擎;`reattach` = 接回一个本来就在跑的引擎(宿主重启后、或重新打开)。
 *
 * 接回还是新起、进程活得比不比宿主久,读的人只读这里,❌ 自己再问一遍 tmux 或从设置推。
 * 没有这一行 = 这条会话此刻没有由本机起的 PTY 进程(ACP 会话不在这里:它们恒随宿主)。
 */
import { decodeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';

export type SessionProcess = {
  readonly home: 'host' | 'tmux';
  readonly start: 'fresh' | 'reattach';
};

const processes = new Map<string, SessionProcess>();

export function sessionProcess(sessionId: string): SessionProcess | null {
  return processes.get(sessionId) ?? null;
}

export function recordSessionProcess(sessionId: string, process: SessionProcess): void {
  processes.set(sessionId, process);
}

export function forgetSessionProcess(sessionId: string): void {
  processes.delete(sessionId);
}

/**
 * 哪些会话的引擎在 tmux 里还活着 —— 接回还是新起(`LocalSessionProvider`)、开机收残放不放过它、
 * 平台票的去留(主进程 `detached-runtime.ts`),同一个判据。
 * `names` 是一次 `listTmuxSessionNames` 的结果:要判一批会话时只问 tmux 一次。
 * 引擎的 tmux 名由 `<projectId>:<会话>:<会话>` 编码而来;终端那几格(leaf 是终端 id)不算。
 */
export function sessionsAliveInTmux(names: ReadonlySet<string>): Set<string> {
  const alive = new Set<string>();
  for (const name of names) {
    const ptySessionId = decodeTmuxSessionName(name);
    const parsed = ptySessionId ? parsePtySessionId(ptySessionId) : null;
    if (parsed && parsed.scopeId === parsed.leafId) alive.add(parsed.leafId);
  }
  return alive;
}
