import { useSyncExternalStore } from 'react';
import {
  sessionStartupFailures,
  type SessionStartupFailure,
} from './stores/session-startup-failures';

/**
 * 这条会话的启动是不是已经**失败**了。
 *
 * 为什么加载态需要它：加载态的撤下条件是「画面上真的有东西了」，
 * 而一个永远不会有东西的会话不满足那个条件 —— 于是圈就一直转下去。
 * owner 实测的 codex（`did not receive an injected first turn within 90000ms`）
 * 正是这一支：转 90 秒，再转下去也不会有结果。
 *
 * ⚠️ ❌ 别用墙钟超时替代这个信号：「等久了」不等于「失败了」，
 * 一个起得慢的 harness（实测 OpenCode 要 9.1s）会被超时误判成坏掉。
 * 这里读的是账本里那条确定性的失败事实，由 hydrate 真的抛错才写入。
 *
 * 账本只由 tui 腿写（ACP 腿走 AcpChatStore.loadError），
 * 与这个加载态所在的腿正好对上。
 */
export function useSessionStartupFailure(
  sessionId: string | null
): SessionStartupFailure | null {
  const failures = useSyncExternalStore(
    sessionStartupFailures.subscribe,
    sessionStartupFailures.snapshot
  );
  if (!sessionId) return null;
  return failures.find((failure) => failure.sessionId === sessionId) ?? null;
}
