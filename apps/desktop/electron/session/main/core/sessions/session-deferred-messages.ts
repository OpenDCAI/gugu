import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { messages, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { getSessionMessageRouter } from './session-message-router';

/**
 * 附带(defer:推迟到对方下次进入运行中时再送;App 的 `messageAgent(…, { defer: true })`,owner 10-09「直接用"进入运行中"这个事件不就得了」):一次普通的 session-direct 发送,
 * ACP 通信输入在准入前把待附带消息拼入同一次请求；已在工作的会话与终端仍由 working 边沿投递。
 *
 * - 唯一的原文是 `messages` 表里的一行:content = 发送时拼好的整个信封,metadata `state: 'deferred'`(待附带)、
 *   `defer: true`、按发信方加过前缀的 `key`。会话删了它随外键级联走;归档的会话不跑,所以不发,取消归档、再跑起来照发。
 * - ACP 首次请求前先认领，收到该请求的准入收据才确认；不确定失败不自动重放。
 * - 进入运行中 = 状态写入者的一次 `非 working → working`(ACP 的回合、终端的 CLI 钩子、宿主适配器都写进这一个写入者)。
 *   那一刻按普通发送投出(默认:忙时插进当前这一轮;插不进的家排到这一轮之后)。
 * - 一行一行:`deferred → dispatching`(同一笔条件更新,同一行认领不了两次)→ 投 → `accepted`;没投进去退回
 *   `deferred`,等下一次进入运行中。进程在「收下」与「落盘」之间没了的那一行,开机认领为 `outcome-unknown`
 *   (与普通投递同一条规则:❌ 重投,宁可如实说不知道)。
 */

type DeferredMetadata = { kind: 'session-direct'; state: string; defer: true; key?: string; nativeReceiptId?: string };

const flushes = new Map<string, Promise<void>>();
const admissions = new Map<string, Promise<void>>();

function metadataOf(raw: string | null): DeferredMetadata | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DeferredMetadata>;
    return value.defer === true ? (value as DeferredMetadata) : null;
  } catch {
    return null;
  }
}

function rejectedBeforeAdmission(error: unknown): boolean {
  return (error as { deliveryRejectedBeforeAdmission?: unknown } | null)?.deliveryRejectedBeforeAdmission === true;
}

/** 存一条待附带。同一会话里同一个(已加前缀的)key 还在等的那条被它替换:总是留最新的一条。 */
export function storeDeferredMessage(input: { sessionId: string; id: string; text: string; key?: string }): void {
  db.transaction((tx) => {
    if (input.key !== undefined) {
      tx.delete(messages)
        .where(and(
          eq(messages.sessionId, input.sessionId),
          sql`json_extract(${messages.metadata}, '$.defer') = 1`,
          sql`json_extract(${messages.metadata}, '$.state') = 'deferred'`,
          sql`json_extract(${messages.metadata}, '$.key') = ${input.key}`,
        ))
        .run();
    }
    tx.insert(messages).values({
      id: input.id,
      sessionId: input.sessionId,
      content: input.text,
      sender: 'user',
      metadata: JSON.stringify({
        kind: 'session-direct',
        state: 'deferred',
        defer: true,
        ...(input.key !== undefined ? { key: input.key } : {}),
      } satisfies DeferredMetadata),
    }).run();
  });
}

function setState(id: string, from: string, to: string, extra: Partial<DeferredMetadata> = {}): boolean {
  const [row] = db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, id)).limit(1).all();
  const parsed = metadataOf(row?.metadata ?? null);
  if (!parsed || parsed.state !== from) return false;
  const result = db.update(messages)
    .set({ metadata: JSON.stringify({ ...parsed, ...extra, state: to }) })
    .where(and(eq(messages.id, id), sql`json_extract(${messages.metadata}, '$.state') = ${from}`))
    .run();
  return result.changes === 1;
}

/** 投完挂着的;`true` = 有一条没投进去、退回了待附带。 */
async function flushNow(sessionId: string): Promise<boolean> {
  const router = getSessionMessageRouter();
  if (!router) return false;
  const [session] = db.select({ runtime: sessions.runtime }).from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
  const pending = db.select({ id: messages.id, content: messages.content })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      sql`json_extract(${messages.metadata}, '$.defer') = 1`,
      sql`json_extract(${messages.metadata}, '$.state') = 'deferred'`,
    ))
    .orderBy(asc(messages.timestamp), asc(sql`rowid`))
    .all();
  for (const row of pending) {
    if (!setState(row.id, 'deferred', 'dispatching')) continue;
    try {
      const receipt = await router(sessionId, { id: row.id, text: row.content, kind: 'session-direct',
        ...(session?.runtime === 'acp' ? { deferredDispatch: true as const } : {}) });
      if (receipt.status === 'accepted') {
        setState(row.id, 'dispatching', 'accepted', receipt.nativeReceiptId ? { nativeReceiptId: receipt.nativeReceiptId } : {});
        continue;
      }
      setState(row.id, 'dispatching', 'deferred');
      log.info('deferred message not delivered on entering working; kept for the next time', { sessionId, messageId: row.id, reason: receipt.reason ?? null });
      return true;
    } catch (error) {
      const state = rejectedBeforeAdmission(error) ? 'deferred' : 'outcome-unknown';
      setState(row.id, 'dispatching', state);
      log.warn('deferred message delivery failed', { sessionId, messageId: row.id, state, error: String(error) });
      return true;
    }
  }
  return false;
}

/**
 * 把这条会话挂着的附带按普通发送投出去(一条会话同一时刻只有一次在冲)。`settled`:投完之后、在这一次算「冲完」之前
 * 跑(订阅者据此记下「这一段运行中还有没投进去的」),所以 {@link deferredMessagesSettled} 等到的已经包含它。
 */
export function flushDeferredMessages(sessionId: string, settled?: (keptBack: boolean) => void): Promise<boolean> {
  const previous = flushes.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => flushNow(sessionId)).then((keptBack) => {
    settled?.(keptBack);
    return keptBack;
  });
  const tracked: Promise<void> = current.then(() => undefined, () => undefined);
  flushes.set(sessionId, tracked);
  void tracked.finally(() => {
    if (flushes.get(sessionId) === tracked) flushes.delete(sessionId);
  });
  return current;
}

/** 这条会话此刻在冲的那一次(连同排在它后面的)冲完;没有在冲的就立刻好。只读,不触发任何投递。 */
export function deferredMessagesSettled(sessionId: string): Promise<void> {
  return flushes.get(sessionId) ?? Promise.resolve();
}

/**
 * ACP communication admission: attach waiting App messages before this request reaches the model.
 * The working edge is too late for a first answer (it can only steer at the next tool call).
 * The queue remains the existing messages rows: claim before admission, acknowledge only its receipt.
 * A working-edge dispatch bypasses this wrapper, otherwise waiting for that flush would wait on itself.
 */
export async function withDeferredMessagesBeforeAdmission<T extends { declined: boolean; requestId: string }>(
  sessionId: string, text: string, admit: (text: string) => Promise<T>, skipClaim = false,
): Promise<T> {
  if (skipClaim) return admit(text);
  const previous = admissions.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await deferredMessagesSettled(sessionId);
    const claimed = db.transaction(() => {
      const waiting = db.select({ id: messages.id, content: messages.content }).from(messages).where(and(
        eq(messages.sessionId, sessionId), sql`json_extract(${messages.metadata}, '$.defer') = 1`,
        sql`json_extract(${messages.metadata}, '$.state') = 'deferred'`,
      )).orderBy(asc(messages.timestamp), asc(sql`rowid`)).all();
      return waiting.filter(row => setState(row.id, 'deferred', 'dispatching'));
    });
    const prompt = [...claimed.map(row => row.content), text].join('\n\n');
    try {
      const receipt = await admit(prompt);
      if (!receipt.declined && !receipt.requestId) throw new Error('ACP admission returned no receipt for deferred context');
      for (const row of claimed) setState(row.id, 'dispatching', receipt.declined ? 'deferred' : 'accepted',
        receipt.declined ? {} : { nativeReceiptId: receipt.requestId });
      return receipt;
    } catch (error) {
      const rejected = rejectedBeforeAdmission(error);
      for (const row of claimed) setState(row.id, 'dispatching', rejected ? 'deferred' : 'outcome-unknown');
      if (claimed.length) log.warn('deferred context admission failed', { sessionId, count: claimed.length, state: rejected ? 'deferred' : 'outcome-unknown' });
      throw error;
    }
  });
  const tracked = current.then(() => undefined, () => undefined);
  admissions.set(sessionId, tracked);
  void tracked.finally(() => { if (admissions.get(sessionId) === tracked) admissions.delete(sessionId); });
  return current;
}

/** 这条会话此刻在不在运行中(写入者落库的那一格)。 */
export function sessionIsWorking(sessionId: string): boolean {
  const [row] = db.select({ status: sessions.agentStatus }).from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
  return row?.status === 'working';
}

/** 开机收残那一步(与 `claimInterruptedDispatches` 同一道闸、同一条规则):上一个进程投到一半的附带认领为 `outcome-unknown`。 */
export function claimInterruptedDeferredMessages(): number {
  const interrupted = db.select({ id: messages.id })
    .from(messages)
    .where(and(sql`json_extract(${messages.metadata}, '$.defer') = 1`, sql`json_extract(${messages.metadata}, '$.state') = 'dispatching'`))
    .all();
  const claimed = interrupted.filter((row) => setState(row.id, 'dispatching', 'outcome-unknown')).length;
  if (claimed) log.warn('claimed interrupted deferred-message dispatches as outcome-unknown', { count: claimed });
  return claimed;
}

/**
 * 订写入者的进程内输出,在 `非 working → working` 的边沿冲。没投进去的(例:会话是被这一句人话从冷态拉起来的,进入运行中
 * 那一刻它还在重放历史,运行时照规矩拒收投递 —— machine.ts「重放中只扣产品的排队入口」),这一段运行中写入者下一次
 * 发布读数(重放完、这一轮真正开起来)时再冲一次;仍在运行中才冲,❌ 定时重试。上一次的读数从开机那一刻起记(`sessions.agent_status`);
 * 开机时已经在运行中、又挂着附带的会话当场冲一次 —— 开机前挂着的不该再等下一轮。记录里没有的会话,第一次读到
 * working 就算一次边沿:没有挂着的就是空跑。
 */
export function installDeferredMessageDelivery(writer: {
  on(event: 'agent:status', cb: (change: { sessionId: string; reading: { status: string } | null }) => void): () => void;
}): () => void {
  const last = new Map<string, string | null>();
  /** 这一段运行中有一条没投进去:下一次发布时再冲。 */
  const retry = new Set<string>();
  const flush = (sessionId: string) => {
    retry.delete(sessionId);
    void flushDeferredMessages(sessionId, (keptBack) => {
      if (keptBack && last.get(sessionId) === 'working') retry.add(sessionId);
    });
  };
  const waiting = db.selectDistinct({ sessionId: messages.sessionId, status: sessions.agentStatus })
    .from(messages)
    .innerJoin(sessions, eq(sessions.id, messages.sessionId))
    .where(and(sql`json_extract(${messages.metadata}, '$.defer') = 1`, sql`json_extract(${messages.metadata}, '$.state') = 'deferred'`))
    .all();
  for (const { sessionId, status } of waiting) {
    last.set(sessionId, status);
    if (status === 'working') flush(sessionId);
  }
  return writer.on('agent:status', ({ sessionId, reading }) => {
    const status = reading?.status ?? null;
    const before = last.get(sessionId);
    last.set(sessionId, status);
    if (status !== 'working') retry.delete(sessionId);
    else if (before !== 'working' || retry.has(sessionId)) flush(sessionId);
  });
}
