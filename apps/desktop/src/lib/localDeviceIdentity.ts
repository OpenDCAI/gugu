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
