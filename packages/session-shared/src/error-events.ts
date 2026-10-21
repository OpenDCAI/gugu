import type { Unsubscribe } from './lifecycle';

/**
 * @@@unhandled-error-event (#4942) — 给长期存在的发射器挂上 `'error'` 出口。
 *
 * Node 对**没有监听者**的 `'error'` 事件一视同仁地抛成未捕获异常。在 Electron 主进程 / 会话页宿主里,
 * 这等于「一个子进程的管道断了」== 整个宿主连同它承载的所有会话一起死。已实测:一次 teardown 期的
 * EPIPE 把无头宿主整个带走(#4935 验收现场,#4942 根因)。
 *
 * ⚠️ **这类失败不是同步抛出的**:`child.send()` / `stream.write()` / `socket.send()` 失败时,错误异步地
 *    走这个事件。所以调用点外面那圈 `try/catch` **一次也接不住** —— 它给的是「已处理」的假象。
 *
 * ❌ 不是「兜底吞错」:错误照旧交给 `onError` 报出去(日志 / 上层处理),这里只切断「没人接 ⇒ 进程死」
 *    这一条**与错误本身无关**的致命路径。进程该不该死由上层按语义决定,不由「谁忘了订阅」决定。
 * ❌ `onError` 必填,且**别传空函数**:那才是真的把症状盖掉。要静默排空也得留一句日志。
 */
export function onErrorEvent(
  emitter: ErrorEmitterLike | null | undefined,
  onError: (error: Error) => void
): Unsubscribe {
  if (!emitter) return () => {};
  const handler = (error: unknown) => onError(asError(error));
  emitter.on('error', handler);
  return () => {
    emitter.off?.('error', handler);
    emitter.removeListener?.('error', handler);
  };
}

/**
 * 一次给多个发射器挂同一个出口(子进程常见形状:进程本体 + stdin + stdout + stderr 四个**独立**的
 * 发射器)。⚠️ 只给 ChildProcess 挂监听拦不住 stdin 的 EPIPE —— 那是另一个发射器(#4942 实例二)。
 */
export function onErrorEvents(
  emitters: readonly (ErrorEmitterLike | null | undefined)[],
  onError: (error: Error) => void
): Unsubscribe {
  const unsubscribes = emitters.map((emitter) => onErrorEvent(emitter, onError));
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

export type ErrorEmitterLike = {
  on(event: 'error', cb: (error: unknown) => void): unknown;
  off?(event: 'error', cb: (error: unknown) => void): unknown;
  removeListener?(event: 'error', cb: (error: unknown) => void): unknown;
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
