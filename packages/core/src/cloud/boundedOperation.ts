export interface AbortablePromiseLike<T> extends PromiseLike<T> {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>
}

export async function withBoundedOperation<T>(
  timeoutMs: number,
  timeoutError: () => Error,
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`operation timeout must be a positive finite number, got ${timeoutMs}`)
  }
  const controller = new AbortController()
  const error = timeoutError()
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function withAbortSignal<T>(
  request: AbortablePromiseLike<T>,
  signal: AbortSignal,
): PromiseLike<T> {
  return typeof request.abortSignal === 'function'
    ? request.abortSignal(signal)
    : request
}
