/**
 * @@@schema-history — 这个库只有一份 schema 历史:手写的 `drizzle/*.sql` 加 `drizzle/meta/_journal.json`。
 * 没有 drizzle-kit 快照,也不跑 `drizzle-kit generate`(#976:快照停在 0023,generate 会拿旧基线 diff、重建表)。
 * 这里守两件事:日志本身连续、和 SQL 文件一一对应;跑完全部迁移得到的库,和 schema.ts 描述的一致。
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import journal from '@root/drizzle/meta/_journal.json';
import { applyMigrations, bundledMigrations } from '@main/db/initialize';
import * as schema from '@main/db/schema';

const HOW_TO_FIX =
  'Write a new migration by hand: add drizzle/00NN_<name>.sql, append its entry to drizzle/meta/_journal.json ' +
  '(next idx, larger when), and change schema.ts in the same commit so it describes the migrated database.';

const entries = (journal as { entries: { idx: number; when: number; tag: string }[] }).entries;
const drizzleDir = fileURLToPath(new URL('../../../../drizzle/', import.meta.url));

describe('desktop session DB schema history', () => {
  it('has one journal entry per SQL file, in order', () => {
    const problems: string[] = [];
    entries.forEach((entry, position) => {
      if (entry.idx !== position) problems.push(`${entry.tag}: idx ${entry.idx}, expected ${position}`);
      const previous = entries[position - 1];
      // 运行时只跑 `when` 大于上一条已记录的迁移:不递增 = 这一条被悄悄跳过。
      if (previous && entry.when <= previous.when) problems.push(`${entry.tag}: when ${entry.when} is not after ${previous.tag}`);
    });
    const files = readdirSync(drizzleDir).filter((name) => name.endsWith('.sql')).map((name) => name.slice(0, -4));
    const tags = new Set(entries.map((entry) => entry.tag));
    for (const file of files) if (!tags.has(file)) problems.push(`${file}.sql has no journal entry`);
    for (const tag of tags) if (!files.includes(tag)) problems.push(`journal entry ${tag} has no SQL file`);
    expect(problems, HOW_TO_FIX).toEqual([]);
  });

  it('produces exactly the tables and columns schema.ts describes', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db, bundledMigrations());
      const problems: string[] = [];
      for (const value of Object.values(schema)) {
        if (!is(value, SQLiteTable)) continue;
        const table = getTableConfig(value);
        const actual = new Map(
          (db.prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`).all() as { name: string; type: string; notnull: number; pk: number }[])
            .map((column) => [column.name, column])
        );
        if (actual.size === 0) {
          problems.push(`table ${table.name} is in schema.ts but no migration creates it`);
          continue;
        }
        for (const column of table.columns) {
          const migrated = actual.get(column.name);
          actual.delete(column.name);
          if (!migrated) {
            problems.push(`${table.name}.${column.name} is in schema.ts but no migration creates it`);
            continue;
          }
          if (migrated.type.toLowerCase() !== column.getSQLType().toLowerCase()) {
            problems.push(`${table.name}.${column.name}: migrated type ${migrated.type}, schema.ts ${column.getSQLType()}`);
          }
          // SQLite 不给 INTEGER PRIMARY KEY 记 notnull,主键列的 NOT NULL 不比。
          if (!(migrated.pk && column.primary) && Boolean(migrated.notnull) !== column.notNull) {
            problems.push(`${table.name}.${column.name}: migrated notNull ${Boolean(migrated.notnull)}, schema.ts ${column.notNull}`);
          }
        }
        for (const extra of actual.keys()) problems.push(`${table.name}.${extra} exists after migrations but not in schema.ts`);
      }
      expect(problems, HOW_TO_FIX).toEqual([]);
    } finally {
      db.close();
    }
  });
});
