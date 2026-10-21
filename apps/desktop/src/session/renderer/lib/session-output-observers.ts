// 会话输出的旁听口(#6264 一套工作台):终端的每一段实时输出、聊天会话每一轮提交,交给登记过的旁听者。
// 用处:别的机器上的会话里冒出 `localhost:5173` ⇒ 记进那台机器的端口表、弹「可以打开了」
// (machine-session-wiring.ts;照 VS Code `remote.autoForwardPortsSource: "output"`)。
// 会话视图本身不知道有谁在听 —— 本机与别的机器上的会话同一个组件,旁听只在这里挂。
// 成本:没人登记时每段输出一次空循环;事件驱动,❌ 定时查。

export type SessionTarget = { projectId: string; sessionId: string };

type PtyOutputObserver = (ptySessionId: string, data: string) => void;
type TurnObserver = (target: SessionTarget, turn: unknown) => void;

const ptyObservers = new Set<PtyOutputObserver>();
const turnObservers = new Set<TurnObserver>();

function notify<A extends unknown[]>(observers: Set<(...args: A) => void>, ...args: A): void {
  for (const observer of observers) {
    try {
      observer(...args);
    } catch {
      /* 旁听者出错不挡会话本身 */
    }
  }
}

/** 终端(pty)的实时输出(❌ 打开时回放的历史)。返回退订。 */
export function observePtyOutput(observer: PtyOutputObserver): () => void {
  ptyObservers.add(observer);
  return () => ptyObservers.delete(observer);
}

export function notifyPtyOutput(ptySessionId: string, data: string): void {
  if (ptyObservers.size > 0) notify(ptyObservers, ptySessionId, data);
}

/** 聊天会话刚提交的那一轮。返回退订。 */
export function observeCommittedTurns(observer: TurnObserver): () => void {
  turnObservers.add(observer);
  return () => turnObservers.delete(observer);
}

export function notifyCommittedTurn(target: SessionTarget, turn: unknown): void {
  if (turnObservers.size > 0 && turn) notify(turnObservers, target, turn);
}
