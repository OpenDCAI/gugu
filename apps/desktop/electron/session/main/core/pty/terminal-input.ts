import type { Pty } from './pty';

/**
 * 把用户的按键写进 harness 的 stdin，并保持**一次提交是两个事件**这件事在字节上仍然看得出来。
 *
 * 终端把每一次按键当独立事件写出去，这在字节流上没有任何标记：正文和随后的回车挨得够近时，
 * harness 一次 read 就把两者一起收走。对于用回车结算 composer 的 TUI，这意味着回车可能结算的是
 * 一个还没收下正文的 composer —— 那一条提交就此消失，屏幕上不留痕迹、也没有任何错误
 * (#4525，Codex 0.147 实测)。
 *
 * 所以宿主在写出提交键之前，等到它与上一次写入之间至少隔开这家自己声明的间隔。
 * ⚠️ 这不是忙闲探测，也不是「等 harness 准备好」——正文照旧立即写出，只有提交键会被推迟，
 * 且只在**声明了**这条约束的 harness 上推迟；没声明的家一个毫秒都不多付
 * (见 `SessionpageTerminalInputDeclaration`)。
 */

/** 终端上的提交键。xterm 的 Enter 发这一个字节。 */
const SUBMIT_KEY = '\r';

type SessionState = {
  lastWriteAt: number;
  queue: Promise<void>;
};

const inputStateByPtySession = new Map<string, SessionState>();

function stateFor(ptySessionId: string): SessionState {
  const existing = inputStateByPtySession.get(ptySessionId);
  if (existing) return existing;
  const created: SessionState = { lastWriteAt: 0, queue: Promise.resolve() };
  inputStateByPtySession.set(ptySessionId, created);
  return created;
}

/** 该会话不再存在时丢掉它的状态；PTY 注销时调用。 */
export function forgetTerminalInputSession(ptySessionId: string): void {
  inputStateByPtySession.delete(ptySessionId);
}

/**
 * 写入一段用户输入。返回的 promise 在字节真的落进 PTY 之后 resolve，因此调用方等它就是在等
 * 写入本身；顺序由每会话一条的队列保证，被推迟的提交键不会被后来的按键越过。
 */
export function writeTerminalInput(args: {
  ptySessionId: string;
  pty: Pty;
  data: string;
  submitSeparationMs: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}): Promise<void> {
  const now = args.now ?? Date.now;
  const delay = args.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = stateFor(args.ptySessionId);

  const run = state.queue.then(async () => {
    // 只有提交键需要与前一次写入分开：它是唯一一个「结算」的按键，也是唯一一个被误结算时
    // 会让整条提交静默消失的按键。普通字符继续逐字节直写。
    if (args.data === SUBMIT_KEY && args.submitSeparationMs > 0) {
      const elapsed = now() - state.lastWriteAt;
      if (elapsed < args.submitSeparationMs) await delay(args.submitSeparationMs - elapsed);
    }
    args.pty.write(args.data);
    state.lastWriteAt = now();
  });

  state.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
