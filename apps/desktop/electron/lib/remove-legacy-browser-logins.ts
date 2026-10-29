import fs from 'node:fs'
import path from 'node:path'

type MigrationLog = {
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
}

/**
 * #846: startup migration for the removed saved-website-login feature. No credentials are read.
 * Retire this migration and the protocol-13 rejection in removed-vault-request.ts once every
 * server/cloud computer has upgraded to the first release containing #846, rollback to earlier
 * releases is retired, and protocol 13 has left the supported window. Record that release version
 * in the release checklist; do not guess the next release number here.
 * The shared task-host-secret.key also protects server-session.enc and must be preserved.
 */
export function removeLegacyBrowserLogins(dataDir: string, log: MigrationLog): { removed: number; failed: number } {
  const directory = path.join(dataDir, 'cloud-browser')
  let names: string[]
  try {
    names = fs.readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, failed: 0 }
    log.warn('Browser saved-login migration could not inspect its directory', { directory, error: String(error) })
    return { removed: 0, failed: 1 }
  }
  let removed = 0
  let failed = 0
  for (const name of names) {
    if (name !== 'saved-logins.enc' && !/^saved-logins\.enc\.\d+\.tmp$/.test(name)) continue
    const file = path.join(directory, name)
    try {
      fs.unlinkSync(file)
      removed += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      failed += 1
      log.warn('Browser saved-login migration could not remove a legacy file; retry on next startup', { file, error: String(error) })
    }
  }
  if (removed > 0) log.info('Browser saved-login migration removed legacy files', { directory, removed, failed })
  return { removed, failed }
}
