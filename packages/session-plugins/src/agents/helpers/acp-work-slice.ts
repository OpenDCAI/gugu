import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';

/** Share a busy ACP input with timers/IPC without delaying each individual live update. */
export function createAcpWorkSlice(): () => Promise<void> | undefined {
  let started = performance.now();
  return () => {
    if (performance.now() - started < 8) return;
    return setImmediate().then(() => { started = performance.now(); });
  };
}

/** The SDK can queue many parsed messages from one byte chunk; yield at message boundaries too. */
export function cooperativeAcpMessages<T>(source: ReadableStream<T>): ReadableStream<T> {
  const checkpoint = createAcpWorkSlice();
  return source.pipeThrough(new TransformStream<T, T>({
    async transform(message, controller) {
      const pending = checkpoint();
      if (pending) await pending;
      controller.enqueue(message);
    },
  }));
}
