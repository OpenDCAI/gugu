import { eq, sql } from 'drizzle-orm'
import { db } from '@main/db/client'
import { appSettings, sessions } from '@main/db/schema'
import { parseVersionedColumn } from '@main/db/versioned-column'
import { log } from '@main/lib/logger'
import { sessionConfig } from '@shared/core/sessions/session-config'

const MIGRATION_KEY = 'migration.lifecycle-outbox-removed-v1'

/**
 * One-shot cleanup after the session lifecycle channel was removed. Older versions queued
 * `kind: 'lifecycle'` entries in a session's message outbox. This version's config schema has no
 * such kind, so a config still holding one would read back as null (the whole config lost). The
 * raw text is read here and those entries leave the outbox. A config that does not parse (before or after) is
 * logged and left as it is, the same as a corrupt config is treated on read: one bad row must not stop the app.
 * Their `messages` rows stay: nothing reads them, and they go with their session.
 */
export function migrateStrandedLifecycleOutbox(): number {
  if (db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, MIGRATION_KEY)).limit(1).all().length) {
    return 0
  }

  let removed = 0
  db.transaction((tx) => {
    const rows = tx.select({ id: sessions.id, raw: sql<string | null>`${sessions.config}` }).from(sessions).all()
    for (const row of rows) {
      if (!row.raw?.includes('"lifecycle"')) continue
      let config: { messageOutbox?: Array<{ kind?: string }> }
      try {
        config = JSON.parse(row.raw) as typeof config
      } catch {
        log.warn('session config is not JSON; lifecycle outbox entries left in place', { sessionId: row.id })
        continue
      }
      const outbox = config.messageOutbox ?? []
      const messageOutbox = outbox.filter((message) => message.kind !== 'lifecycle')
      if (messageOutbox.length === outbox.length) continue
      const next = parseVersionedColumn(sessionConfig, JSON.stringify({ ...config, messageOutbox }))
      if (!next) {
        log.warn('session config does not parse even without its lifecycle outbox entries; left in place', { sessionId: row.id })
        continue
      }
      removed += outbox.length - messageOutbox.length
      tx.update(sessions).set({ config: next }).where(eq(sessions.id, row.id)).run()
    }
    tx.insert(appSettings).values({ key: MIGRATION_KEY, value: new Date().toISOString() }).run()
  })

  if (removed > 0) log.warn('removed lifecycle outbox entries left by an older version', { count: removed })
  return removed
}
