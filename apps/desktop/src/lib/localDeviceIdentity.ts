/**
 * This computer has not been identified among the account's devices yet: the local host has not received the sign-in
 * (the shell hands it over just after it signs in), or could not resolve its device row. Until it is, no device row
 * can be called "another computer" — the local host announces the moment it knows (`subscribeLocalDeviceIdentified`).
 */
export class LocalDeviceUnidentifiedError extends Error {
  constructor() {
    super('This computer is not identified among the account devices yet')
    this.name = 'LocalDeviceUnidentifiedError'
  }
}

export function isLocalDeviceUnidentified(error: unknown): error is LocalDeviceUnidentifiedError {
  return error instanceof LocalDeviceUnidentifiedError
}

/** How long a reader waits for this computer to be identified before it gives up with the original error. */
export const LOCAL_DEVICE_IDENTIFY_WAIT_MS = 30_000

/**
 * Runs `read`; if it fails only because this computer is not identified yet, waits for the identification
 * (`subscribe`, the local host's announcement) and reads again. Subscribed before the second read, so an identification
 * landing between the two is not missed. Not identified within `timeoutMs` (or nothing to subscribe to) ⇒ rejects with
 * the `LocalDeviceUnidentifiedError` itself — the caller reports it, ❌ reads it as "no such device / offline".
 */
export async function readOnceLocalDeviceIdentified<T>(
  read: () => Promise<T>,
  subscribe: ((listener: () => void) => () => void) | undefined,
  timeoutMs = LOCAL_DEVICE_IDENTIFY_WAIT_MS,
): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!isLocalDeviceUnidentified(error) || !subscribe) throw error
    const unidentified = error
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | null = null
      const finish = (settle: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe?.()
        settle()
      }
      const attempt = () => {
        read().then(
          (value) => finish(() => resolve(value)),
          (err: unknown) => { if (!isLocalDeviceUnidentified(err)) finish(() => reject(err)) },
        )
      }
      const timer = setTimeout(() => finish(() => reject(unidentified)), timeoutMs)
      unsubscribe = subscribe(attempt)
      if (settled) unsubscribe()
      attempt()
    })
  }
}
