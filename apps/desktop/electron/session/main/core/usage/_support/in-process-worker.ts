import type { TokenScanWorkerLike } from '../token-scan-client';
import type { FromWorker, ToWorker } from '../token-scan-worker/protocol';
import { createTokenScanService } from '../token-scan-worker/service';

/**
 * 单测用:把 worker 那一半(service)跑在本线程里,消息照真 worker 的形状走 —— 异步投递、
 * 结构化克隆(不共享引用)、按收到的顺序串行处理。`crash()` 模拟线程崩掉。
 */
export function createInProcessTokenScanWorker(): TokenScanWorkerLike & {
  crash(error: Error): void;
  received: ToWorker[];
  terminated: boolean;
} {
  const listeners = { message: [] as Array<(m: FromWorker) => void>, error: [] as Array<(e: Error) => void>, exit: [] as Array<(c: number) => void> };
  let alive = true;
  const service = createTokenScanService((message) => {
    const copy = structuredClone(message);
    setImmediate(() => alive && listeners.message.forEach((listener) => listener(copy)));
  });
  let queue: Promise<void> = Promise.resolve();
  const worker = {
    received: [] as ToWorker[],
    terminated: false,
    postMessage(message: ToWorker) {
      if (!alive) return;
      const copy = structuredClone(message);
      worker.received.push(copy);
      queue = queue.then(() => new Promise<void>((resolve) => setImmediate(resolve))).then(() => (alive ? service.handle(copy) : undefined));
    },
    on(event: 'message' | 'error' | 'exit', listener: never) {
      (listeners[event] as unknown[]).push(listener);
      return worker;
    },
    terminate() {
      if (!alive) return Promise.resolve(0);
      alive = false;
      worker.terminated = true;
      listeners.exit.forEach((listener) => listener(1));
      return Promise.resolve(1);
    },
    crash(error: Error) {
      if (!alive) return;
      alive = false;
      listeners.error.forEach((listener) => listener(error));
      listeners.exit.forEach((listener) => listener(1));
    },
  };
  return worker as unknown as ReturnType<typeof createInProcessTokenScanWorker>;
}
