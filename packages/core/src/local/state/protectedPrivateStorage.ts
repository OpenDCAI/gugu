import { isAbsolute, join } from 'node:path'
import { resolveGuguHome } from './paths'

export const SERVICE_PERMISSION_STORAGE = 'service-permissions'
export const PROTECTED_STORAGE_UNAVAILABLE = 'Protected private storage is unavailable'

/** Trusted host API only. Never register this API as an Agent tool or accept registrations from tool arguments. */
export interface ProtectedPrivateStorage {
  readonly id: string
  /** Files or directory trees, including future files, backups and temporary material. */
  readonly paths: readonly string[]
}

export const privateServicePermissionDirectory = () => join(resolveGuguHome(), 'private-service-permissions')
const registered = new Map<string, ProtectedPrivateStorage>()

/** Register before creating private material. Registrations cannot be removed or replaced during a host lifetime. */
export function registerProtectedPrivateStorage(storage: ProtectedPrivateStorage): void {
  if (!/^[a-z][a-z0-9.-]*$/.test(storage.id) || storage.id === SERVICE_PERMISSION_STORAGE || registered.has(storage.id)) {
    throw new Error('Protected private storage id is invalid or already registered')
  }
  if (!storage.paths.length || storage.paths.some(file => typeof file !== 'string' || !isAbsolute(file) || file.includes('\0'))) {
    throw new Error('Protected private storage requires absolute file or directory paths')
  }
  // Copy both levels: a caller cannot silently withdraw protection by mutating its original input.
  registered.set(storage.id, Object.freeze({ id: storage.id, paths: Object.freeze([...storage.paths]) }))
}

/** Fresh snapshot. The existing boundary alone resolves aliases, indexes identities and checks trees. */
export function protectedPrivateStorages(): readonly ProtectedPrivateStorage[] {
  return [{ id: SERVICE_PERMISSION_STORAGE, paths: [privateServicePermissionDirectory()] }, ...registered.values()]
}
