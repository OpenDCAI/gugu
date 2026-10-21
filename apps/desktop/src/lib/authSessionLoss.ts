let authSessionController = new AbortController()

export function currentAuthSessionSignal(): AbortSignal {
  return authSessionController.signal
}

export function resetAuthSessionBoundary(): void {
  authSessionController.abort()
  authSessionController = new AbortController()
}

/** #7408 同一个人续期 / 恢复:边界还活着就留着(在途请求照常走完);已作废(登出后重登)才换新的。 */
export function keepAuthSessionBoundary(): void {
  if (authSessionController.signal.aborted) authSessionController = new AbortController()
}

export function abortAuthSessionBoundary(): void {
  authSessionController.abort()
}
