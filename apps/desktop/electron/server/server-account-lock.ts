import { spawnSync } from '@gugu/core/local/childProcess'
import fs from 'node:fs'
import path from 'node:path'
import { isOwnProcessAlive, SERVER_PROCESS_MARK } from './process-alive'

export type AccountLockDeps = {
  read?: (file: string) => string | null
  alive?: (pid: number) => boolean
  ownsLock?: (pid: number, file: string) => boolean
}

/** The account shim keeps its write descriptor open until release. A matching
 * writable inode proves this process owns this lock, including after PID reuse.
 * Keep the numeric lock format used by installed launchers and older packages. */
export function processOwnsAccountLock(pid: number, file: string): boolean {
  const expected = fs.statSync(file, { bigint: true })
  if (process.platform === 'linux') {
    let descriptors: string[]
    try { descriptors = fs.readdirSync(`/proc/${pid}/fd`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    for (const fd of descriptors) {
      try {
        const actual = fs.statSync(`/proc/${pid}/fd/${fd}`, { bigint: true })
        if (actual.dev !== expected.dev || actual.ino !== expected.ino) continue
        const flags = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^flags:\s+([0-7]+)$/m)?.[1]
        if (!flags) throw new Error(`Cannot read account lock descriptor flags for PID ${pid}`)
        if ((Number.parseInt(flags, 8) & 3) !== 0) return true
      } catch (error) {
        // Descriptors can close while being inspected; access failures are not
        // evidence of a stale lock and must not authorize its removal.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return false
  }
  if (process.platform !== 'darwin') throw new Error('Unsupported account lock platform')
  const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-F', 'faiD', '--', file], {
    encoding: 'utf8', timeout: 5_000,
  })
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1) || result.stderr.trim()) {
    throw new Error(`Cannot inspect account lock descriptors for PID ${pid}`, { cause: result.error ?? result.stderr })
  }
  let access = '', device = '', inode = ''
  const matches = () => (access === 'w' || access === 'u') && device !== '' && inode !== ''
    && BigInt(device) === expected.dev && BigInt(inode) === expected.ino
  for (const field of result.stdout.split('\n')) {
    if (field.startsWith('f')) {
      if (matches()) return true
      access = ''; device = ''; inode = ''
    } else if (field.startsWith('a')) access = field.slice(1)
    else if (field.startsWith('D')) device = field.slice(1)
    else if (field.startsWith('i')) inode = field.slice(1)
  }
  return matches()
}

export function accountLockHolder(dataDir: string, deps: AccountLockDeps = {}): number | null {
  const file = path.join(dataDir, 'server.lock')
  let text: string | null
  if (deps.read) text = deps.read(file)
  else {
    try { text = fs.readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const pid = Number(text?.trim())
  if (!Number.isInteger(pid) || pid <= 0 || !(deps.alive ?? ((id) => isOwnProcessAlive(id, SERVER_PROCESS_MARK)))(pid)) return null
  try { return (deps.ownsLock ?? processOwnsAccountLock)(pid, file) ? pid : null } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
