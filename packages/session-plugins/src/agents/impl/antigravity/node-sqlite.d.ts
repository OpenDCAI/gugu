/**
 * `node:sqlite` 的最小声明 —— 只写 `./fork.ts` 用到的那几个。
 *
 * 仓里钉的 `@types/node` 是 20.x,还没有这个模块(Node 22.5 起内置,`backup` 23.8 起;运行时是
 * Node 24 / Electron 44)。❌ 不为这一处把全仓的 `@types/node` 升一个大版本。
 * 签名照 https://nodejs.org/docs/latest-v24.x/api/sqlite.html 。
 */
declare module 'node:sqlite' {
  type SqliteValue = null | number | bigint | string | Uint8Array;

  export class StatementSync {
    all(...params: SqliteValue[]): unknown[];
    get(...params: SqliteValue[]): unknown;
    run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export function backup(sourceDb: DatabaseSync, path: string): Promise<number>;
}
