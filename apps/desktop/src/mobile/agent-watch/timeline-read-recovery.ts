import { LOAD_RETRY_DELAYS_MS } from './record-wait'

/** Reads may recover without asking the person to repeat a mechanical retry. */
export async function recoverTimelineRead<T>(read: () => Promise<T>, signal: AbortSignal, onFailure?: (error: unknown) => void): Promise<T> {
  let attempt = 0
  for (;;) {
    signal.throwIfAborted()
    try { return await read() }
    catch (error) {
      signal.throwIfAborted()
      onFailure?.(error)
      const delay = LOAD_RETRY_DELAYS_MS[attempt++] ?? null
      if (delay === null) throw error
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
        const timer = setTimeout(done, delay)
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    }
  }
}
