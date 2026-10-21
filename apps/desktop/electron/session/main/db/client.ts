import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { resolveDatabasePath } from './path';
import * as schema from './schema';

// @@@task-fusion (#2802) — 用 drizzle 自己导出的类型,别写成 `ReturnType<typeof drizzle<...>>`:
// 那种实例化表达式套在重载泛型上会踩到 tsc 的 `Debug Failure. No error for last overload
// signature`(session-shared 的 resultSchema 就是这么崩的)。
export type AppDb = BetterSQLite3Database<typeof schema>;
export type DrizzleTx = Parameters<AppDb['transaction']>[0] extends (tx: infer T) => unknown
  ? T
  : never;

let sqliteInstance: Database.Database | undefined;

function getSqlite(): Database.Database {
  if (sqliteInstance) return sqliteInstance;

  const connection = new Database(resolveDatabasePath());
  connection.pragma('journal_mode = WAL');
  connection.pragma('busy_timeout = 5000');
  sqliteInstance = connection;
  return connection;
}

// Keep the existing sqlite export stable while deferring native binding loading
// until a database consumer actually touches the connection.
export const sqlite = new Proxy({} as Database.Database, {
  get(_target, property) {
    const connection = getSqlite();
    const value = Reflect.get(connection, property, connection);
    return typeof value === 'function' ? value.bind(connection) : value;
  },
  set(_target, property, value) {
    const connection = getSqlite();
    return Reflect.set(connection, property, value, connection);
  },
}) as Database.Database;

export const db = drizzle(sqlite, { schema });

export function closeDatabase(): void {
  if (!sqliteInstance) return;
  if (!sqliteInstance.open) return;
  sqliteInstance.pragma('wal_checkpoint(TRUNCATE)');
  sqliteInstance.close();
  sqliteInstance = undefined;
}
