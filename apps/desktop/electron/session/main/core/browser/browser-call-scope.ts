import { AsyncLocalStorage } from 'node:async_hooks';

const calls = new AsyncLocalStorage<AbortSignal | undefined>();
export const browserCallSignal = (): AbortSignal | undefined => calls.getStore();
export const withBrowserCall = <T>(signal: AbortSignal, run: () => T): T => calls.run(signal, run);
/** The shared Playwright connection belongs to the session, not its first caller. */
export const withoutBrowserCall = <T>(run: () => T): T => calls.run(undefined, run);

/** Stop this waiter, always observe the underlying result, and never replay an uncertain operation. */
export function awaitBrowserCall<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
