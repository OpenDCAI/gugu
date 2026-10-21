import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDefaultDatabasePath } from './database-file';
import { CURRENT_DB_FILENAME, RENAMED_FROM_DB_FILENAME } from './default-path';

function seed(path: string, note: string): void {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE notes (body TEXT)');
    db.exec('CREATE TABLE app_secrets (key TEXT, secret TEXT)');
    db.prepare('INSERT INTO notes (body) VALUES (?)').run(note);
    db.prepare('INSERT INTO app_secrets (key, secret) VALUES (?, ?)').run('github', 'tok');
  } finally {
    db.close();
  }
}

function read(path: string): { notes: string[]; secrets: number } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      notes: db
        .prepare('SELECT body FROM notes')
        .all()
        .map((row) => (row as { body: string }).body),
      secrets: (db.prepare('SELECT COUNT(*) AS n FROM app_secrets').get() as { n: number }).n,
    };
  } finally {
    db.close();
  }
}

describe('resolveDefaultDatabasePath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gugu-db-path-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the current database when it is already there', () => {
    seed(join(dir, CURRENT_DB_FILENAME), 'current');

    expect(resolveDefaultDatabasePath(dir)).toBe(join(dir, CURRENT_DB_FILENAME));
    expect(read(join(dir, CURRENT_DB_FILENAME)).notes).toEqual(['current']);
  });

  // 改名(emdash4 → gugu4)必须是**改名**,不是拷贝:同一个 schema、同一份加密密钥。
  // 拷贝再清空 app_secrets 的话,所有人的集成凭据会无声消失,界面上不会有任何提示。
  it('renames the pre-rename database in place, keeping its rows and its secrets', () => {
    seed(join(dir, RENAMED_FROM_DB_FILENAME), 'carried over');

    expect(resolveDefaultDatabasePath(dir)).toBe(join(dir, CURRENT_DB_FILENAME));
    expect(read(join(dir, CURRENT_DB_FILENAME))).toEqual({
      notes: ['carried over'],
      secrets: 1,
    });
    // 旧名字那份不该还留着占地方,也不该让降级回旧版本的人看到一份过期数据。
    expect(fs.existsSync(join(dir, RENAMED_FROM_DB_FILENAME))).toBe(false);
  });
});
