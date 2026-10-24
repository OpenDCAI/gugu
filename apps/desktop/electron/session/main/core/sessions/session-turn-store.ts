import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessionTurns } from '@main/db/schema';
import { randomUUID } from 'node:crypto';
import { activitySignal } from '../activity/signals';

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
 * 用序号对齐同时也天然排除了「库里已有完整历史」那一侧：那时已存行数远大于 0，而重放的
 * 第一条序号是 0，对不上，整段跳过。
 *
 * 新回合用 `INSERT OR IGNORE` 保持按到达序幂等；已提交回合的改口(结局或迟到的尾巴)整轮替换其最新投影行。
 * `backfill`(更早那一轮被后台命令的终态补了内容,#6582)落盘与 `revision` 同一条路:按 turn id 找行、整轮替换。
 */
/**
 * 把一条回合按**库里的序号**重新编号（#5381）。
 *
 * ⚠️ 运行时那份回合序号**每次重开会话都从 0 重数**，而 `turn.id` 与它下面所有条目的 id 都由它
 * 派生（`${conversationId}:turn:${index}`、`${turnId}:message:…`）。于是一条跨过重启的会话，
 * 库里会出现**两条 id 完全相同的回合**——实测:第 5 行的 turn.id 与第 3 行逐字相同。
 *
 * 后果不是「显示得不好看」：id 是转录的主键，`scrollToItem`、按 id 定位、折叠状态、
 * 框架的 keying 全靠它。两条不同的回合共用一个 id，这些一起错位。而且它**只在跨重启的会话上
 * 发作** —— 正是这个功能存在的那个场景。
 *
 * 重编号只动 id 那几个字段（`id` 与 `parentId`，两者都以 turn id 为前缀），
 * ❌ 不做整段 JSON 的字符串替换：消息正文里恰好出现同样的字符串就会被误伤。
 */
export function renumberStoredTurn(
  turn: TranscriptTurn,
  sessionId: string,
  storeSeq: number
): TranscriptTurn {
  const nextTurnId = `${sessionId}:turn:s${storeSeq}`;
  const prevTurnId = turn.id;
  if (nextTurnId === prevTurnId) return { ...turn, seq: storeSeq };

  const rewrite = (value: string): string => {
    if (value === prevTurnId) return nextTurnId;
    if (value.startsWith(`${prevTurnId}:`)) return `${nextTurnId}${value.slice(prevTurnId.length)}`;
    return value;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = (key === 'id' || key === 'parentId') && typeof val === 'string'
        ? rewrite(val)
        : walk(val);
    }
    return out;
  };

  return { ...(walk(turn) as TranscriptTurn), id: nextTurnId, seq: storeSeq };
}

const persistenceTails = new Map<string, Promise<void>>();
type PersistInput = { sessionId: string; source: CommittedTurnSource; turn: TranscriptTurn };

export function persistCommittedTurn(input: PersistInput): Promise<void> {
  const previous = persistenceTails.get(input.sessionId) ?? Promise.resolve();
  const next = previous.then(() => persistCommittedTurnNow(input), () => persistCommittedTurnNow(input));
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
    await db.update(sessionTurns).set({
      data: JSON.stringify(renumberStoredTurn(input.turn, input.sessionId, row.seq)),
    }).where(eq(sessionTurns.id, row.id));
    return;
  }
  if (input.source === 'replay') {
    const stored = await storedTurnCount(input.sessionId);
    if (stored !== input.turn.seq) return;
  }

  // 到达序由这里分配。❌ 不复用运行时那份回合序号：重开会话后它从 0 重数，而重放只含压缩边界
  // 之后的一段，直接拿来当键必然与库里已有的行撞号。
  const next = await nextSeq(input.sessionId);
  const turn = renumberStoredTurn(input.turn, input.sessionId, next);
  const inserted = await db
    .insert(sessionTurns)
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
    .returning({ seq: sessionTurns.seq });
  // The activity index names a turn by this stored sequence, assigned here and nowhere else: the runtime's own turn
  // ids restart at 0 with every run, and the provider record numbers its turns from a different stream. A replayed
  // turn is history arriving late, not something that happened now.
  if (input.source === 'live' && inserted.length > 0) {
    activitySignal({ event_id: `session.turn_recorded:${randomUUID()}`, kind: 'session.turn_recorded',
      session_id: input.sessionId, turn_seq: next, occurred_at: input.turn.endedAt ?? null });
  }
}

async function storedTurnCount(sessionId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessionTurns)
    .where(eq(sessionTurns.sessionId, sessionId));
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
  /** 给了就改成「seq ≥ fromSeq 的全部行」,供界面每轮对账用;与 before/limit 互斥。 */
  fromSeq?: number;
}): Promise<StoredTurnPage> {
  return readStoredTurns(params.sessionId, {
    before: params.before,
    limit: params.limit,
    fromSeq: params.fromSeq,
  });
}

export interface StoredTurnPage {
  turns: TranscriptTurn[];
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
  options: { before?: number; limit?: number; fromSeq?: number } = {}
): Promise<StoredTurnPage> {
  if (options.fromSeq !== undefined) {
    // 「开场那一页的第一行一直到最新」—— 每轮对账用。❌ 不分页:这一段 = 开场那页 + 本次面板期间新增的,
    // 有界;分页取反而会在两次取之间被新写进来的行错开。
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
          gte(sessionTurns.seq, options.fromSeq)
        )
      )
      .orderBy(asc(sessionTurns.seq));
    return {
      turns: rows.map((row) => JSON.parse(row.data) as TranscriptTurn),
      originTurnIds: rows.map((row) => row.turnId),
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
  const turns = ordered.map((row) => JSON.parse(row.data) as TranscriptTurn);

  return {
    turns,
    originTurnIds: ordered.map((row) => row.turnId),
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
  await persistenceTails.get(sessionId);
  if (fromSeq === null) return;
  const removed = await db.delete(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), gte(sessionTurns.seq, fromSeq)))
    .returning({ seq: sessionTurns.seq });
  // Later turns take these sequences again; the activity index reads this to stop pointing at the removed ones.
  if (removed.length > 0) {
    activitySignal({ event_id: `session.history_reverted:${randomUUID()}`, kind: 'session.history_reverted',
      session_id: sessionId, turn_seq: fromSeq, occurred_at: Date.now() });
  }
}

/** One stored turn by its sequence, or null when the session's stored history no longer has it. */
export async function readStoredTurn(sessionId: string, seq: number): Promise<TranscriptTurn | null> {
  await persistenceTails.get(sessionId);
  const [row] = await db.select({ data: sessionTurns.data }).from(sessionTurns)
    .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.seq, seq))).limit(1);
  return row ? JSON.parse(row.data) as TranscriptTurn : null;
}
