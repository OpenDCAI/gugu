/** Installation-wide startup contract. Account data and the account's own lock stay unchanged. */
import fs from 'node:fs'
import path from 'node:path'
import { SERVER_UPDATE_STATE_FILE } from '@gugu/core'
import { isServerVersion } from '@gugu/core/cloud/serverDesktopVersions'
import { isOwnProcessAlive, SERVER_PROCESS_MARK } from './process-alive'
import { addBadVersion } from './server-upgrade-guard'
import { pointCurrent } from './server-version-lifecycle'
import type { ServerAccount } from './server-layout'
import { EXIT_RESTART } from './server-exit'
export { EXIT_RESTART, EXIT_CONFIG, EXIT_SIGNED_OUT } from './server-exit'

export const PENDING_VERIFY_FILE = 'pending-verify.json'
export type PendingVerify = { from: string; to: string; attempts: number; request?: number }

/** The existing supervisor lock remains the installation's process identity for old readers. */
export function acquireHomeLock(home: string, alive = (pid: number) => isOwnProcessAlive(pid, SERVER_PROCESS_MARK)): (() => void) | null {
  const lockPath = path.join(home, 'data', 'server.lock')
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const acquire = (): boolean => {
    let fd: number
    try { fd = fs.openSync(lockPath, 'wx', 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    try { fs.writeSync(fd, String(process.pid)) }
    catch { /* Keep the acquired lock even if a full disk prevents writing its PID. */ }
    finally { fs.closeSync(fd) }
    return true
  }
  if (!acquire()) {
    let holder = 0
    try { holder = Number(fs.readFileSync(lockPath, 'utf8').trim()) } catch { /* Stale unreadable lock. */ }
    if (alive(holder)) return null
    fs.rmSync(lockPath, { force: true })
    if (!acquire()) return null
  }
  return () => {
    try {
      if (Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid) fs.rmSync(lockPath, { force: true })
    } catch { /* The lock has already gone. */ }
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function readPendingVerify(home: string): PendingVerify | null {
  const file = path.join(home, 'data', PENDING_VERIFY_FILE)
  if (!fs.existsSync(file)) return null
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PendingVerify>
  if (!isServerVersion(value.from) || !isServerVersion(value.to) || !Number.isInteger(value.attempts)
    || value.attempts! < 0 || (value.request !== undefined && !Number.isFinite(value.request))) {
    throw new Error('Invalid pending server verification record')
  }
  return value as PendingVerify
}

export function writePendingVerify(home: string, pending: PendingVerify): void {
  writeJson(path.join(home, 'data', PENDING_VERIFY_FILE), pending)
}

function finishVerification(home: string, pending: PendingVerify, kind: 'switched' | 'rolledBack', now: number): void {
  const version = kind === 'switched' ? pending.to : pending.from
  const lastOutcome = { kind, at: now, ...(pending.request !== undefined ? { request: pending.request } : {}),
    ...(kind === 'switched' ? { target: pending.to } : { bad: pending.to, back: pending.from }) }
  writeJson(path.join(home, 'data', SERVER_UPDATE_STATE_FILE), { state: 'idle', version, at: now, lastOutcome })
  fs.rmSync(path.join(home, 'data', PENDING_VERIFY_FILE), { force: true })
}

/** Call only after acquiring the home lock. Three unready launches are allowed, without a wall-clock deadline. */
export function checkPendingBoot(home: string, now = Date.now()): typeof EXIT_RESTART | null {
  const pending = readPendingVerify(home)
  if (!pending) return null
  pending.attempts++
  writePendingVerify(home, pending)
  if (pending.attempts <= 3) return null
  pointCurrent(home, path.join(home, 'versions', pending.from))
  addBadVersion(home, pending.to, now)
  finishVerification(home, pending, 'rolledBack', now)
  return EXIT_RESTART
}

/** Both a successful PID-bound heartbeat and waiting for login are stable startup states. */
export function markServerReady(home: string, now = Date.now()): void {
  const pending = readPendingVerify(home)
  if (pending) finishVerification(home, pending, 'switched', now)
}

export function onlySignedInAccount(accounts: readonly ServerAccount[]): ServerAccount | null {
  const signedIn = accounts.filter(account => account.signedIn)
  if (signedIn.length > 1) {
    throw new Error(`One system user can sign in to only one Gugu account. Signed in: ${signedIn.map(account => account.email ?? account.userId).join(', ')}. Run gugu-server logout <email> or use another system user. Account data was preserved.`)
  }
  return signedIn[0] ?? null
}

export function assertAccountLogin(accounts: readonly ServerAccount[], userId: string): void {
  const other = accounts.find(account => account.signedIn && account.userId !== userId)
  if (other) throw new Error(`Gugu server is signed in as ${other.email ?? other.userId}. Sign out first or install under another system user.`)
}
