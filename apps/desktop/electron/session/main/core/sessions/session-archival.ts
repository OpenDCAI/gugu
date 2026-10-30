import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '@main/db/client'
import { sessionEvents } from './session-events'
import { kv, sessions } from '@main/db/schema'
import { archiveTimestamp, sessionArchiveRefusesMessage, type SessionArchivalState } from '@gugu/core/shared/sessionArchival'

const keyFor = (sessionId: string) => `session-archival:${sessionId}`
const operations = new Map<string, Promise<void>>()

/** Serialize stop/restore as well as the synchronous SQLite transitions. */
export function serializeSessionArchival<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const pending = (operations.get(sessionId) ?? Promise.resolve()).then(operation, operation)
  const settled = pending.then(() => {}, () => {})
  operations.set(sessionId, settled)
  void settled.then(() => { if (operations.get(sessionId) === settled) operations.delete(sessionId) })
  return pending
}

/** Read failure must never turn an archived session into an admissible target. */
export function sessionArchivalState(sessionId: string): SessionArchivalState | null {
  const row = db.select({ archivedAt: sessions.archivedAt }).from(sessions).where(eq(sessions.id, sessionId)).get()
  if (!row) return null
  const record = db.select({ value: kv.value }).from(kv).where(eq(kv.key, keyFor(sessionId))).get()
  if (!record) return { sessionId, archivedAt: row.archivedAt, revision: 0, intervals: [] }
  const value = JSON.parse(record.value) as SessionArchivalState
  if (value.sessionId !== sessionId || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.intervals)) {
    throw new Error(`Session archival journal is invalid: ${sessionId}`)
  }
  for (const interval of value.intervals) {
    if (typeof interval.id !== 'string') throw new Error(`Session archival interval has no id: ${sessionId}`)
    const start = archiveTimestamp(interval.archivedAt)
    if (interval.restoredAt !== null && archiveTimestamp(interval.restoredAt) < start) {
      throw new Error(`Session archival clock moved backwards: ${sessionId}`)
    }
  }
  return { ...value, archivedAt: row.archivedAt }
}

/** The row and its refusal interval commit together, before runtime teardown. */
export function setSessionArchival(sessionId: string, archived: boolean, at = new Date().toISOString()): string | null {
  archiveTimestamp(at)
  let changed = false
  const archivedAt = db.transaction((tx) => {
    const row = tx.select({ archivedAt: sessions.archivedAt }).from(sessions).where(eq(sessions.id, sessionId)).get()
    if (!row) throw new Error(`Session not found: ${sessionId}`)
    if (Boolean(row.archivedAt) === archived) return row.archivedAt
    const prior = sessionArchivalState(sessionId)!
    const intervals = prior.intervals.map((interval) => ({ ...interval }))
    if (archived) intervals.push({ id: randomUUID(), archivedAt: at, restoredAt: null })
    else {
      // Pre-upgrade archives have no journal yet. Preserve their original start.
      const open = intervals.findLast((interval) => interval.restoredAt === null)
      const start = open?.archivedAt ?? row.archivedAt!
      if (archiveTimestamp(at) < archiveTimestamp(start)) throw new Error('Session archival clock moved backwards')
      if (open) open.restoredAt = at
      else intervals.push({ id: randomUUID(), archivedAt: start, restoredAt: at })
    }
    const archivedAt = archived ? at : null
    const state: SessionArchivalState = { sessionId, archivedAt, revision: prior.revision + 1, intervals }
    tx.insert(kv).values({ key: keyFor(sessionId), value: JSON.stringify(state), updatedAt: Date.now() })
      .onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify(state), updatedAt: Date.now() } }).run()
    tx.update(sessions).set({ archivedAt, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(sessions.id, sessionId)).run()
    changed = true
    return archivedAt
  })
  if (changed && archived) sessionEvents._emit('session:archived', sessionId)
  return archivedAt
}

/** Give pre-upgrade archives a stable interval before the host starts delivery. */
export function initializeSessionArchival(): void {
  db.transaction((tx) => {
    for (const row of tx.select({ id: sessions.id, archivedAt: sessions.archivedAt }).from(sessions).all()) {
      if (!row.archivedAt || tx.select({ key: kv.key }).from(kv).where(eq(kv.key, keyFor(row.id))).get()) continue
      archiveTimestamp(row.archivedAt)
      const state: SessionArchivalState = { sessionId: row.id, archivedAt: row.archivedAt, revision: 1,
        intervals: [{ id: randomUUID(), archivedAt: row.archivedAt, restoredAt: null }] }
      tx.insert(kv).values({ key: keyFor(row.id), value: JSON.stringify(state), updatedAt: Date.now() }).run()
    }
  })
}

/** Existence inventory, shared by the desktop and server host. */
export function sessionArchivalInventory(): SessionArchivalState[] {
  initializeSessionArchival()
  return db.select({ id: sessions.id }).from(sessions).all().map((row) => sessionArchivalState(row.id)!)
}

/** A refused message ID is permanent even if a later envelope supplies another time. */
export function sessionMessageRefused(sessionId: string, messageId: string, createdAt: string): boolean {
  if (!messageId) throw new Error('Session archival admission requires a message id')
  const key = `session-archival-refusal:${sessionId}:${messageId}`
  if (db.select({ key: kv.key }).from(kv).where(eq(kv.key, key)).get()) return true
  if (!sessionArchiveRefusesMessage(sessionArchivalState(sessionId), createdAt)) return false
  db.insert(kv).values({ key, value: 'agent_archived', updatedAt: Date.now() }).onConflictDoNothing().run()
  return true
}
