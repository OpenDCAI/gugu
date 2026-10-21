import type { ContractDefinitions } from '../api';
import { spawnWorker, type WorkerHandle, type WorkerSpec } from './spawn-worker';

export type LazyWorkerOptions<Defs extends ContractDefinitions> = {
  onSpawned?: (handle: WorkerHandle<Defs>) => void | Promise<void>;
};

export type LazyWorker<Defs extends ContractDefinitions> = {
  get(): Promise<WorkerHandle<Defs>>;
  /**
   * 已经起着的那个 handle,或 `null` —— **不**顺手把它叫起来。
   *
   * 给「只在它本来就活着时才有事可做」的调用方用:收尾路径尤其如此。用 `get()` 去做收尾会把
   * 「没有东西要收」变成「先起一个进程,再对它收一次尾」,那是收尾自己制造了要收的东西。
   */
  peek(): Promise<WorkerHandle<Defs> | null>;
  dispose(): Promise<void>;
};

export function lazyWorker<Defs extends ContractDefinitions>(
  spec: WorkerSpec<Defs> | (() => WorkerSpec<Defs> | Promise<WorkerSpec<Defs>>),
  options: LazyWorkerOptions<Defs> = {}
): LazyWorker<Defs> {
  let pending: Promise<WorkerHandle<Defs>> | null = null;

  return {
    get() {
      if (pending) return pending;
      pending = Promise.resolve(typeof spec === 'function' ? spec() : spec)
        .then((resolvedSpec) => spawnWorker(resolvedSpec))
        .then(async (handle) => {
          try {
            await options.onSpawned?.(handle);
          } catch (error) {
            await handle.dispose();
            throw error;
          }
          return handle;
        })
        .catch((error: unknown) => {
          pending = null;
          throw error;
        });
      return pending;
    },
    async peek() {
      return (await pending?.catch(() => null)) ?? null;
    },
    async dispose() {
      const current = pending;
      pending = null;
      const handle = await current?.catch(() => null);
      await handle?.dispose();
    },
  };
}
