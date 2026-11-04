import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { accountLockHolder, sameAccountLockInode } from './server-account-lock'

/** The permanent guard uses SQLite's kernel locks, automatically released on
 * process death. Never unlink it or recover it by inspecting another PID. */
export class AccountInstanceLock {
  private held: { fd: number; file: string; guard: DatabaseSync } | null = null
  get acquired(): boolean { return this.held !== null }

  acquire(dataDir: string): boolean {
    if (this.held) return false
    // Status/link commands never acquire this lock. Load the built-in only for
    // account startup, without introducing a native addon or CLI startup warning.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const gate = path.join(dataDir, 'server-lock.sqlite')
    const guard = new DatabaseSync(gate, { timeout: 0 })
    let acquired = false
    try {
      // Do not open/close this file outside SQLite: closing another descriptor
      // can release all POSIX record locks held by this process on its inode.
      fs.chmodSync(gate, 0o600)
      try { guard.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE') } catch (error) {
        if ((error as { errcode?: number }).errcode === 5) return false
        throw error
      }
      const file = path.join(dataDir, 'server.lock')
      let previous: number | null = null
      try { previous = fs.openSync(file, 'r') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (previous !== null) {
        try {
          // Pin the old inode until the rename has been validated. Once its last
          // FD closes, Linux may immediately reuse the same inode for a new lock.
          const saved = fs.fstatSync(previous, { bigint: true })
          if (accountLockHolder(dataDir) !== null) return false
          const retired = path.join(dataDir, `.server-lock-retired-${randomUUID()}`)
          // Legacy contenders do not take the kernel guard. Check AFTER moving
          // the inode, and exclusively restore any replacement instead of deleting it.
          try { fs.renameSync(file, retired) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (fs.existsSync(retired)) {
            if (!sameAccountLockInode(saved, fs.statSync(retired, { bigint: true }))) {
              try { fs.linkSync(retired, file) } catch (error) {
                throw new Error('Concurrent legacy account lock replacement; preserving both lock inodes', { cause: error })
              }
              fs.unlinkSync(retired)
              return false
            }
            fs.unlinkSync(retired)
          }
        } finally { fs.closeSync(previous) }
      }
      // Publish a fully written PID atomically. A crash before publication must
      // not leave an empty canonical file indistinguishable from a live legacy
      // creator that has opened its FD but has not written its PID yet.
      const pending = path.join(dataDir, `.server-lock-pending-${randomUUID()}`)
      const fd = fs.openSync(pending, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, String(process.pid))
        try { fs.linkSync(pending, file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
          throw error
        }
        fs.unlinkSync(pending)
        this.held = { fd, file, guard }
        acquired = true
        return true
      } finally {
        if (!acquired) try { fs.closeSync(fd) } finally { fs.rmSync(pending, { force: true }) }
      }
    } finally { if (!acquired) guard.close() }
  }

  release(): void {
    const held = this.held
    if (!held) return
    this.held = null
    try {
      const stat = fs.fstatSync(held.fd, { bigint: true })
      try {
        if (sameAccountLockInode(stat, fs.statSync(held.file, { bigint: true }))) fs.unlinkSync(held.file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } finally { try { fs.closeSync(held.fd) } finally { held.guard.close() } }
  }
}
