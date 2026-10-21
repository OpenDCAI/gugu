import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

// 只给测试用:一份停在 0031(= v0.2.51 的 schema)的真文件库,还没跑 0032。迁移链逐条照 drizzle 的写法执行,
// 不经过产品的执行器 —— 被测的 initializeDatabase 之后再在它上面跑 0032。
const drizzleDir = fileURLToPath(new URL('../../session/drizzle/', import.meta.url))

export function openAt0031(): { sqlite: Database.Database; close: () => void } {
  const file = path.join(os.tmpdir(), `gugu-t2s-${crypto.randomUUID()}.db`)
  const sqlite = new Database(file)
  sqlite.pragma('foreign_keys = ON')
  sqlite.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)')
  const journal = JSON.parse(fs.readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>
  }
  for (const entry of journal.entries) {
    if (entry.idx > 31) break
    const sql = fs.readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) sqlite.exec(stmt.trim())
    sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(crypto.createHash('sha256').update(sql).digest('hex'), entry.when)
  }
  return {
    sqlite,
    close: () => {
      sqlite.close()
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true })
    },
  }
}
