import { renumberStoredTurn, rewriteTurnId } from './session-turn-identity';
export { renumberStoredTurn } from './session-turn-identity';
import { findToolImage, trimCursorPageForTransport, trimTurnsForTransport } from '@gugu/session-core/session-record';
import { and, asc, desc, eq, gte, like, lt, notLike, sql } from 'drizzle-orm';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessionTurns } from '@main/db/schema';
import { randomUUID } from 'node:crypto';
import { activitySignal } from '../activity/signals';
import { noteNativeConversationReplies, noteNativeConversationHistory, truncateNativeConversationRead } from './session-conversation-read';
import { nativeConversationActivity } from './session-conversation-activity';
import { publishNativeConversationInbox, queueNativeConversationInbox } from './native-conversation-inbox';
import { mayFillReplay, didFillReplay, stopFillingReplay, readableStoredRows } from './session-turn-replay';
import { ownerNotificationEpoch, rewindOwnerNotificationState, publishOwnerNotificationState } from './owner-notification-state';
import { persistWithTurnSettlement } from './turn-settlement';
import { events } from '@main/lib/events';
import { sessionTurnSettledChannel, type StoredSettledTurn } from '@shared/core/sessions/sessionEvents';

/**
 * 会话历史的落盘（#5381）。
 *
 * **为什么会话页要自己存**：从前历史的唯一来源是恢复时的 ACP `session/load` 重放，而重放完不完整
 * 取决于 provider —— 实测 `claude-agent-acp` 在上下文压缩之后只重放最后一次压缩边界之后的部分
 * （6177 行的会话只推回 46 条）。用户视角就是「我重启了，我消息也丢了」，而这段对话在 agent 侧
 * 其实还在。把「用户会不会丢历史」交给二十多家 provider 各自决定，方向本身就是错的。
 *
 * 这里只管**写**与**读**两件事；「哪一回合该不该写」的判断在 {@link persistCommittedTurn}，
 * 因为那个判断只有主进程做得了 —— 运行时不知道库里已经有没有这条会话的历史。
 */

export type CommittedTurnSource = 'live' | 'replay' | 'revision' | 'backfill';

/**
 * 落一条已提交的回合。
 *
 * `replay`、`live` 与 `revision` 的处置不同，且**必须**在这里分开：
 *  - `live`：刚发生的，直接写。
 *  - `replay`：`session/load` 推回来的。只在这条会话是**空库**时才补，那是两种情况：
 *    本改动之前就存在的老会话，以及刚从编程模式切过来、从没在通用面跑过的会话
 *    （切换保留同一个 provider 会话 id，所以重放能把编程模式期间那段推回来）。
 *    库里已经有那一段时必须丢弃，否则就是把同一句话再写一遍。
 *
 * ⚠️ 判据是 **`已存行数 === 这一回合在本次会话里的序号`**，❌ 不是「库里现在一行都没有」。
 * 后者只在**第一条**重放回合上成立：补完那一条，库里就有行了，于是同一次重放的第 2、3 条
 * 全被当成重复丢掉 —— 库里留下一个只有开头的残缺历史，而下次重开时上屏逻辑按
 * 「库里那份是完整的」把重放回来的其余部分整段跳过。2026-09-10 隔离实例实撞：一条对照会话
 * 补完之后重开只剩 2 个渲染块，而补之前是 6 个。
 *
 * 是否回填在重放第一条时固定。不能只逐条对齐数量：旧档案非空，重放尾部的编号仍可能追上它的条数。
 *
 * 新回合用 `INSERT OR IGNORE` 保持按到达序幂等；已提交回合的改口(结局或迟到的尾巴)整轮替换其最新投影行。
 * `backfill`(更早那一轮被后台命令的终态补了内容,#6582)落盘与 `revision` 同一条路:按 turn id 找行、整轮替换。
 */
const persistenceTails = new Map<string, Promise<void>>();
type PersistInput = { sessionId: string; source: CommittedTurnSource; turn: TranscriptTurn };

export function persistCommittedTurn(input: PersistInput): Promise<void> {
  const previous = persistenceTails.get(input.sessionId) ?? Promise.resolve();
  const write = () => persistWithTurnSettlement(input, () => persistCommittedTurnNow(input),
    receipt => events.emit(sessionTurnSettledChannel, receipt));
  const next = previous.then(write, write);
  persistenceTails.set(input.sessionId, next);
  return next.finally(() => {
    if (persistenceTails.get(input.sessionId) === next) persistenceTails.delete(input.sessionId);
  });
}

async function persistCommittedTurnNow(input: PersistInput): Promise<void> {
  if (input.source === 'revision' || input.source === 'backfill') {
    const [row] = await db
      .select({ id: sessionTurns.id, seq: sessionTurns.seq })
      .from(sessionTurns)
      .where(and(
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.turnId, input.turn.id),
      ))
      .orderBy(desc(sessionTurns.seq))
      .limit(1);
    if (!row) throw new Error(`Cannot revise missing stored turn: sessionId=${input.sessionId} turnId=${input.turn.id} source=${input.source}`);
    // 改口的可能是结局(进程退出改写 prompt_failed),也可能是内容(落定后才到的尾巴,#6191)
    // ⇒ 整轮按库里的序号重编号后替换,❌ 只挑某个字段写。
    const publish = db.transaction(tx => {
      const revised = renumberStoredTurn(input.turn, input.sessionId, row.seq);
      tx.update(sessionTurns).set({ data: JSON.stringify(revised) }).where(eq(sessionTurns.id, row.id)).run();
      return noteNativeConversationReplies(input.sessionId, revised, input.turn, tx);
    });
    publish?.();
    return;
  }
  if (input.source === 'replay') {
    const stored = await storedTurnCount(input.sessionId);
    if (!mayFillReplay(input.sessionId, input.turn.seq, stored)) return;
  } else stopFillingReplay(input.sessionId);

  // 到达序由这里分配。❌ 不复用运行时那份回合序号：重开会话后它从 0 重数，而重放只含压缩边界
  // 之后的一段，直接拿来当键必然与库里已有的行撞号。
  const next = await nextSeq(input.sessionId);
  const turn = renumberStoredTurn(input.turn, input.sessionId, next);
  const inserted = db.transaction(tx => {
    const result = tx.insert(sessionTurns)
    .values({
      id: `${input.sessionId}:${next}`,
      sessionId: input.sessionId,
      seq: next,
      // turn_id 记**这一行来自引擎的哪一轮**(运行时原始 turn id);库里自己的 id 在 data 里(`:turn:sN`)。
      // 界面据此判断「引擎里新提交的那一轮是否已经落库」—— 按身份去重,❌ 不按条数(#5381 评审 #2/#3)。
      turnId: input.turn.id,
      data: JSON.stringify(turn),
    })
    .onConflictDoNothing()
    .returning({ seq: sessionTurns.seq }).all();
    const publish = !result.length ? undefined : input.source === 'live'
      ? noteNativeConversationReplies(input.sessionId, turn, input.turn, tx)
      : noteNativeConversationHistory(input.sessionId, turn, tx);
    const inbox = input.source === 'live' && result.length > 0 && nativeConversationActivity(input.sessionId, tx)?.turnSeq === turn.seq
      ? queueNativeConversationInbox(input.sessionId, tx) : false;
    return { rows: result, publish, inbox };
  });
  inserted.publish?.();
  if (inserted.inbox) publishNativeConversationInbox();
  if (input.source === 'replay' && inserted.rows.length) didFillReplay(input.sessionId, input.turn.seq);
  // The activity index names a turn by this stored sequence, assigned here and nowhere else: the runtime's own turn
  // ids restart at 0 with every run, and the provider record numbers its turns from a different stream. A replayed
  // turn is history arriving late, not something that happened now.
  if (input.source === 'live' && inserted.rows.length > 0) {
    activitySignal({ event_id: `session.turn_recorded:${randomUUID()}`, kind: 'session.turn_recorded',
      session_id: input.sessionId, turn_seq: next, occurred_at: input.turn.endedAt ?? null });
  }
}

/**
 * #980 记录补库与运行时落库走**同一条**按会话排队的写链:补的时候插不进一轮运行时的提交,运行时也插不进来,
 * 补进来的几轮因此总是接在当时的库尾。
 */
export function withStoredTurns<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const previous = persistenceTails.get(sessionId) ?? Promise.resolve();
  const result = previous.then(run, run);
  const tail = result.then(() => undefined, () => undefined);
  persistenceTails.set(sessionId, tail);
  void tail.then(() => {
    if (persistenceTails.get(sessionId) === tail) persistenceTails.delete(sessionId);
  });
  return result;
}

/** #980 库尾往前读,由新到旧,最多 `limit` 行。只在写链里调(`withStoredTurns`)。 */
export async function readStoredTailNow(sessionId: string, limit: number): Promise<TranscriptTurn[]> {
  const rows = await db
    .select({ data: sessionTurns.data })
    .from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId))
    .orderBy(desc(sessionTurns.seq))
    .limit(limit);
  return rows.map((row) => JSON.parse(row.data) as TranscriptTurn);
}

/**
 * Record-backed rows retain their source identity so a later snapshot can complete the same stored row.
 * Only call inside `withStoredTurns`; revisions are historical and publish no live-message side effects.
 * `turn_id` 记 `record:` 开头的记录侧 id:这一行**不来自引擎的哪一轮**,界面按引擎 turn id 去重时不会把它认成谁。
 */
export async function readUnfinishedRecordTurnsNow(sessionId: string): Promise<TranscriptTurn[]> {
  const rows = await db.select({ data: sessionTurns.data }).from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), like(sessionTurns.turnId, 'record:%'),
      sql`json_extract(${sessionTurns.data}, '$.outcome.kind') IS NULL`));
  return rows.map(row => JSON.parse(row.data) as TranscriptTurn);
}

/** The record matcher has proved this unfinished row's native identity; keep its stored sequence/references. */
export async function reviseRecordTurnNow(sessionId: string, seq: number, turn: TranscriptTurn): Promise<void> {
  const [stored] = await db.select({ id: sessionTurns.id, seq: sessionTurns.seq, data: sessionTurns.data })
    .from(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.seq, seq), like(sessionTurns.turnId, 'record:%'))).limit(1);
  if (!stored) throw new Error(`Cannot revise missing record turn: sessionId=${sessionId} seq=${seq}`);
  const data = JSON.stringify(renumberStoredTurn(turn, sessionId, stored.seq));
  if (stored.data !== data) {
    const publish = db.transaction(tx => {
      tx.update(sessionTurns).set({ data }).where(eq(sessionTurns.id, stored.id)).run();
      return noteNativeConversationHistory(sessionId, JSON.parse(data) as TranscriptTurn, tx);
    });
    publish?.();
  }
}

/** Append only a missing record turn, inside `withStoredTurns`. */
export async function appendRecordTurnNow(sessionId: string, turn: TranscriptTurn): Promise<void> {
  const next = await nextSeq(sessionId);
  const stored = renumberStoredTurn(turn, sessionId, next);
  const publish = db.transaction(tx => {
    const inserted = tx.insert(sessionTurns).values({
      id: `${sessionId}:${next}`, sessionId, seq: next, turnId: `record:${turn.id}`, data: JSON.stringify(stored),
    }).onConflictDoNothing().returning({ seq: sessionTurns.seq }).all();
    return inserted.length ? noteNativeConversationHistory(sessionId, stored, tx) : undefined;
  });
  publish?.();
}

/**
 * #980 运行时回合序号的下一个起点。库里每一行记着它来自引擎的哪一轮(`turn_id` = `${会话}:turn:${序号}`),
 * 取其中最大的序号 + 1。接回会话不重放时运行时从这里接着数 —— 从 0 数会撞上上一次运行留在库里的同名回合,
 * 界面按 turn_id 认「这一轮已经落库」,撞上的那一轮就被当成重复藏起来。旧版本写的行记的是库内 id(`:turn:sN`),不算。
 */
export async function storedTurnIndexBase(sessionId: string): Promise<number> {
  await persistenceTails.get(sessionId);
  const rows = await db
    .select({ turnId: sessionTurns.turnId, notifiedSource: sql<string | null>`CASE WHEN ${sessionTurns.turnId} LIKE 'owner-notify:%' THEN json_extract(${sessionTurns.data}, '$.items[0].ownerNotification.sourceTurnId') END` })
    .from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId));
  let max = -1;
  for (const { turnId, notifiedSource } of rows) {
    // A notified but interrupted turn already owns its identity; a restarted engine must not reuse it.
    const index = /:turn:(\d+)$/.exec(notifiedSource ?? turnId)?.[1];
    if (index !== undefined) max = Math.max(max, Number(index));
  }
  return max + 1;
}

async function storedTurnCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), notLike(sessionTurns.turnId, 'owner-notify:%')));
  return rows[0]?.count ?? 0;
}

async function nextSeq(sessionId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number | null>`max(${sessionTurns.seq})` })
    .from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId));
  const max = rows[0]?.max;
  return max === null || max === undefined ? 0 : max + 1;
}

/**
 * 渲染端读历史的入口（#5381）。
 *
 * **这条路不经过引擎**：界面重开一条会话时先从这里把已有内容画出来，引擎起没起来都不影响首帧。
 * 从前历史只能等 `session/load` 重放送达，于是「打开一条会话」和「把一个 harness 拉起来」
 * 被绑成了一件事。
 */
export async function getStoredHistory(params: {
  sessionId: string;
  before?: number;
  limit?: number;
  /** 给了就改成「seq ≥ fromSeq 的全部行」,供界面开场补读用;与 before/limit 互斥。 */
  fromSeq?: number;
  ownerNotificationsOnly?: boolean;
}): Promise<StoredTurnPage> {
  for (;;) {
    const epoch = ownerNotificationEpoch(params.sessionId);
    const page = await readStoredTurns(params.sessionId, {
      before: params.before,
      limit: params.limit,
      fromSeq: params.fromSeq,
      ownerNotificationsOnly: params.ownerNotificationsOnly,
    });
    // A revert can reuse every sequence in the page. Its rows and generation must describe the same snapshot.
    if (epoch !== ownerNotificationEpoch(params.sessionId)) continue;
    const snapshot = { ...page, nativeOwnerNotificationEpoch: epoch };
    return params.fromSeq === undefined
      ? trimCursorPageForTransport(snapshot)
      : { ...snapshot, turns: trimTurnsForTransport(page.turns) };
  }
}

export async function getStoredToolImage(params: {
  sessionId: string; itemId: string; index: number;
} & ({ seq: number } | { originTurnId: string })) {
  await persistenceTails.get(params.sessionId);
  const [row] = await db.select({ data: sessionTurns.data, turnId: sessionTurns.turnId })
    .from(sessionTurns).where(and(
      eq(sessionTurns.sessionId, params.sessionId),
      'seq' in params ? eq(sessionTurns.seq, params.seq) : eq(sessionTurns.turnId, params.originTurnId),
    )).orderBy(desc(sessionTurns.seq)).limit(1);
  const turn = row ? JSON.parse(row.data) as TranscriptTurn : null;
  const itemId = row && turn && !('seq' in params)
    ? rewriteTurnId(params.itemId, row.turnId, turn.id) : params.itemId;
  return findToolImage(turn ? [turn] : [], itemId, params.index, Number.POSITIVE_INFINITY);
}

/** Read one immutable live origin, even after its runtime record was removed. No provider is contacted. */
export async function getStoredSettledTurn(params: { sessionId: string; referenceId: string; originTurnId: string }): Promise<StoredSettledTurn | null> {
  await persistenceTails.get(params.sessionId);
  const [row] = await db.select({ data: sessionTurns.data, originTurnId: sessionTurns.turnId })
    .from(sessionTurns).where(and(eq(sessionTurns.sessionId, params.sessionId), eq(sessionTurns.turnId, params.originTurnId),
      sql`json_extract(${sessionTurns.data}, '$.referenceId') = ${params.referenceId}`))
    .orderBy(desc(sessionTurns.seq)).limit(1);
  if (!row) return null;
  const turn = JSON.parse(row.data) as TranscriptTurn;
  return turn.outcome ? { originTurnId: row.originTurnId, turn: trimTurnsForTransport([turn])[0]! } : null;
}

export interface StoredTurnPage {
  turns: TranscriptTurn[];
  /** The generation in which these rows were read; older hosts omit it (generation zero). */
  nativeOwnerNotificationEpoch?: number;
  /** 与 `turns` 一一对应:每一行来自引擎的哪一轮(运行时原始 turn id)。旧版本写的行这里是库内 id。 */
  originTurnIds: string[];
  /** 还有更早的一页时给出游标（本页最早那一条的 `seq`）；到头了、或是 `fromSeq` 读法时为 null。 */
  nextCursor: number | null;
}

/**
 * 读一页历史，**由新到旧**取、返回时转成由旧到新，与运行时那份 `getHistory` 的游标语义一致
 * （`before` 排他，游标是本页最早那条的 `seq`）。
 *
 * 到头的判据只能是「取回来的比要的少」。❌ 别拿「正好取满」当还有下一页 —— 那会让最后一页
 * 后面永远跟着一次返回空的调用。
 */
export async function readStoredTurns(
  sessionId: string,
  options: { before?: number; limit?: number; fromSeq?: number; ownerNotificationsOnly?: boolean } = {}
): Promise<StoredTurnPage> {
  if (options.fromSeq !== undefined) {
    // 「开场那一页之后新落库的行」—— 开场时补读一次用(acp-chat-store `_reloadStoredTail`)。❌ 不分页:这一段只是
    // 开场那一刻前后落库的那几行,有界;分页取反而会在两次取之间被新写进来的行错开。
    const rows = await db
      .select({
        seq: sessionTurns.seq,
        data: sessionTurns.data,
        turnId: sessionTurns.turnId,
      })
      .from(sessionTurns)
      .where(
        and(
          eq(sessionTurns.sessionId, sessionId),
          gte(sessionTurns.seq, options.fromSeq),
          ...(options.ownerNotificationsOnly ? [like(sessionTurns.turnId, 'owner-notify:%')] : [])
        )
      )
      .orderBy(asc(sessionTurns.seq));
    const readable = await readableStoredRows(sessionId, rows);
    return {
      turns: readable.map(row => row.turn),
      originTurnIds: readable.map(row => row.turnId),
      nextCursor: null,
    };
  }
  const limit = options.limit ?? 100;
  const where =
    options.before === undefined
      ? eq(sessionTurns.sessionId, sessionId)
      : and(
          eq(sessionTurns.sessionId, sessionId),
          lt(sessionTurns.seq, options.before)
        );

  const rows = await db
    .select({ seq: sessionTurns.seq, data: sessionTurns.data, turnId: sessionTurns.turnId })
    .from(sessionTurns)
    .where(where)
    .orderBy(desc(sessionTurns.seq))
    .limit(limit);

  const ordered = rows.slice().reverse();
  const readable = await readableStoredRows(sessionId, ordered);
  if (!readable.length && rows.length === limit && rows.length) {
    return readStoredTurns(sessionId, { before: rows.at(-1)!.seq, limit });
  }

  return {
    turns: readable.map(row => row.turn),
    originTurnIds: readable.map(row => row.turnId),
    nextCursor: rows.length < limit ? null : (rows.at(-1)?.seq ?? null),
  };
}

/** Resolve the durable display boundary by the provider receipt, never by a runtime row index. */
export async function storedRevertBoundary(sessionId: string, anchor: string): Promise<number | null> {
  await persistenceTails.get(sessionId);
  const rows = await db.select({ seq: sessionTurns.seq, data: sessionTurns.data })
    .from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).orderBy(asc(sessionTurns.seq));
  for (const row of rows) {
    const turn = JSON.parse(row.data) as TranscriptTurn;
    if (turn.items.some((item) => item.kind === 'message' && item.role === 'user' && item.revertAnchor === anchor)) return row.seq;
  }
  if (rows.length) throw new Error('The stored conversation no longer contains this revert point.');
  return null;
}

export async function truncateStoredHistory(sessionId: string, fromSeq: number | null): Promise<void> {
  if (fromSeq === null) return;
  return withStoredTurns(sessionId, async () => {
    stopFillingReplay(sessionId);
    const removed = db.transaction(tx => {
      const result = tx.delete(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), gte(sessionTurns.seq, fromSeq))).returning({ seq: sessionTurns.seq, turnId: sessionTurns.turnId }).all();
      const origins = new Set(result.map(row => row.turnId));
      // A notification commits before its calling provider turn; deleting that turn must remove its earlier notice too.
      const attached = tx.select({ seq: sessionTurns.seq, turnId: sessionTurns.turnId, data: sessionTurns.data }).from(sessionTurns)
        .where(and(eq(sessionTurns.sessionId, sessionId), like(sessionTurns.turnId, 'owner-notify:%'))).all()
        .filter(row => (JSON.parse(row.data) as TranscriptTurn).items.some(item => item.kind === 'message' && item.ownerNotification?.sourceTurnId && origins.has(item.ownerNotification.sourceTurnId)));
      for (const row of attached) tx.delete(sessionTurns).where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.turnId, row.turnId))).run();
      rewindOwnerNotificationState(sessionId, tx);
      return { rows: [...result, ...attached], publish: truncateNativeConversationRead(sessionId, fromSeq, tx, new Set(attached.map(row => row.seq))) };
    });
    removed.publish?.();
    publishOwnerNotificationState(sessionId);
    // Later turns take these sequences again; the activity index reads this to stop pointing at the removed ones.
    if (removed.rows.length > 0) {
      activitySignal({ event_id: `session.history_reverted:${randomUUID()}`, kind: 'session.history_reverted',
        session_id: sessionId, turn_seq: fromSeq, occurred_at: Date.now() });
    }
  });
}

/** One stored turn by its sequence, or null when the session's stored history no longer has it. */
export async function readStoredTurn(sessionId: string, seq: number): Promise<TranscriptTurn | null> {
  await persistenceTails.get(sessionId);
  const [row] = await db.select({ data: sessionTurns.data }).from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.seq, seq))).limit(1);
  return row ? JSON.parse(row.data) as TranscriptTurn : null;
}
