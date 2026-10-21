import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, type PendingMigration } from '@main/db/initialize';

/**
 * 迁移执行器与外键(@@@foreign-keys-off)。
 *
 * 要守的是:重建一张被级联外键指着的父表,子表的行还在。从前执行器在 `foreign_keys = ON` 下开事务,
 * 事务里的 `PRAGMA foreign_keys=OFF` 不起作用,`DROP TABLE <旧父表>` 的隐式 DELETE 把子表连带删光。
 */

const base: PendingMigration = {
  tag: '0000_base',
  when: 1,
  sql: `CREATE TABLE parent (id text PRIMARY KEY NOT NULL, name text);
--> statement-breakpoint
CREATE TABLE child (id text PRIMARY KEY NOT NULL, parent_id text NOT NULL REFERENCES parent(id) ON DELETE cascade);`,
};

// drizzle-kit 生成的重建形状,连那句在事务里不起作用的 PRAGMA 一起照抄。
const rebuildParent: PendingMigration = {
  tag: '0001_rebuild_parent',
  when: 2,
  sql: `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE __new_parent (id text PRIMARY KEY NOT NULL, name text, extra text);
--> statement-breakpoint
INSERT INTO __new_parent (id, name) SELECT id, name FROM parent;
--> statement-breakpoint
DROP TABLE parent;
--> statement-breakpoint
ALTER TABLE __new_parent RENAME TO parent;
--> statement-breakpoint
PRAGMA foreign_keys=ON;`,
};

function seeded(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, [base]);
  db.exec(`INSERT INTO parent VALUES ('p', 'P'); INSERT INTO child VALUES ('c', 'p');`);
  return db;
}

const count = (db: Database.Database, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('applyMigrations × foreign keys', () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  it('阴控:照旧写法(外键开着进事务)重建父表,子表确实被连带删光', () => {
    db = seeded();
    db.transaction(() => {
      for (const stmt of rebuildParent.sql.split('--> statement-breakpoint')) db!.exec(stmt.trim());
    })();
    expect(count(db, 'child')).toBe(0);
  });

  it('重建被级联外键指着的父表:子表的行还在,外键约束仍指向新表', () => {
    db = seeded();
    applyMigrations(db, [base, rebuildParent]);
    expect(count(db, 'child')).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.exec(`DELETE FROM parent WHERE id = 'p'`);
    expect(count(db, 'child')).toBe(0);
  });

  it('这一批造出了外键违例:整批回滚,迁移记录也不留', () => {
    db = seeded();
    const orphaning: PendingMigration = {
      tag: '0001_orphaning',
      when: 2,
      sql: `CREATE TABLE note (id text PRIMARY KEY NOT NULL);
--> statement-breakpoint
DELETE FROM parent;`,
    };
    expect(() => applyMigrations(db!, [base, orphaning])).toThrow(/child→parent: 0 → 1/);
    expect(count(db, 'parent')).toBe(1);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'note'`).get()).toBeUndefined();
    expect(count(db, '__drizzle_migrations')).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('库里早就有的违例不挡这一批(这批没造新的)', () => {
    db = seeded();
    db.pragma('foreign_keys = OFF');
    db.exec(`INSERT INTO child VALUES ('stale', 'gone')`);
    db.pragma('foreign_keys = ON');
    applyMigrations(db, [base, rebuildParent]);
    expect(count(db, 'child')).toBe(2);
  });
});
