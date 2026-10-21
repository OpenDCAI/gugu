import Database from 'better-sqlite3';

import type { SessionRecordLocator, SessionRecordSource, SessionRecordSourceEvents } from '../contract';
import {
  SessionRecordNotFoundError,
  pollInterval,
  warnOf,
  type RecordSourceWarn,
  type SessionRecordSourceOptions
} from './shared';

/**
 * 按候选顺序只读打开 sqlite 库，找到**装着这个会话**的那一份(opencode 族、hermes)。
 *
 * 判据是「库里有这条会话」,不是「库打得开」:挪过数据目录的机器上新库照样打得开，只是空的 ——
 * 只认第一个打得开的，会拿一份空库冒充「会话不存在」。
 *
 * ⚠️ better-sqlite3(12.11.1)**不支持 URI 文件名**:`file:...?mode=ro` 会直接 `unable to open database file`。
 * 只读靠 options 走 SQLITE_OPEN_READONLY,语义相同，且不碰 harness 自己的 WAL。
 */
export function openSessionDb(input: {
  /** 写进报错里的那一家。 */
  name: string;
  dbPaths: string[];
  /** 会话表名(opencode 是 `session`,hermes 是 `sessions`)。 */
  table: string;
  sessionId: string;
}): { db: Database.Database; dbPath: string } {
  const opened: string[] = [];
  for (const dbPath of input.dbPaths) {
    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      continue; // 这一份不在(没装过 / 没挪过来),换下一个候选
    }
    opened.push(dbPath);
    try {
      if (db.prepare(`select id from ${input.table} where id = ?`).get(input.sessionId)) return { db, dbPath };
    } catch {
      // 库在但表结构不对(版本太老 / 被别的东西占了这个文件名)—— 当这一份没有，继续找。
    }
    db.close();
  }
  throw new SessionRecordNotFoundError(
    opened.length === 0
      ? `打不开任何一份 ${input.name} 库(候选 ${input.dbPaths.length} 个)`
      : `${input.name} 库里没有这个会话：sessionId=${input.sessionId}(已查 ${opened.length} 份库)`,
    input.dbPaths
  );
}

/**
 * 只读 sqlite 库的轮询源外壳(opencode 族、hermes):开库 → 首读 → 按节拍轮询;拆的时候停表、关库。
 * 读库是同步的，调一次 `poll` 就是追到最新，所以 `catchUp` 就是它。各家只给 `read`。
 */
export abstract class SqlitePollSource<L extends SessionRecordLocator> implements SessionRecordSource {
  protected readonly warn: RecordSourceWarn;
  protected events: SessionRecordSourceEvents | null = null;
  protected db: Database.Database | null = null;
  /** 候选里真正打开的那一份。诊断信息要说清读的是哪一份库。 */
  protected dbPath: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    readonly locator: L,
    private readonly options: SessionRecordSourceOptions | undefined,
    /** 写进告警里的那一家。 */
    private readonly name: string
  ) {
    this.warn = warnOf(options);
  }

  /** 候选里装着这个会话的那一份库。 */
  protected abstract open(): { db: Database.Database; dbPath: string };

  /** 读一趟。`first` = 开库后的整份首读。 */
  protected abstract read(first: boolean): void;

  async start(events: SessionRecordSourceEvents): Promise<void> {
    this.events = events;
    const opened = this.open();
    this.db = opened.db;
    this.dbPath = opened.dbPath;
    this.read(true);
    this.timer = setInterval(() => this.poll(), pollInterval(this.options));
    this.timer.unref?.();
  }

  async catchUp(): Promise<void> {
    this.poll();
  }

  /** 立刻对账一次。测试直接调它，免得把用例时长押在轮询节拍上。 */
  poll(): void {
    if (this.stopped || !this.db || !this.events) return;
    try {
      this.read(false);
    } catch (error) {
      this.warn(`${this.name} 轮询失败，将在下个节拍重试`, { dbPath: this.dbPath, error: (error as Error).message });
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.db?.close();
    } catch {
      // 关一个只读连接失败没有后续动作可做，别把 stop() 变成会抛的调用。
    }
    this.db = null;
    this.events = null;
  }
}
