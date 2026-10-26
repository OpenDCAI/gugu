import { and, eq } from 'drizzle-orm';
import { resolveSessionpageSessionIntegration } from '@gugu/session-plugins/agents';
import { recordLocalSessionDeliveryFailureForTest } from '@main/core/sessionpage/local-session-delivery';
import { resolveSession } from '@main/core/projects/utils';
import { db } from '@main/db/client';
import { sessions, messages } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { taskExchangeRecorded } from '../session-timeline/task-exchanges';
import { activitySignal } from '../activity/signals';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { conversationLink, parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import {
  acceptSessionMessage,
  enqueueSessionMessage,
  failSessionMessage,
  markSessionMessageDispatching,
  markSessionMessagePending,
  nextPendingSessionMessage,
} from '@shared/core/sessions/message-outbox-state';
import { mapSessionRowToSession } from './utils';
import { getSessionMessageRouter, setSessionMessageOutboxDrain } from './session-message-router';
import { isNoLocalMessageEncodingError } from './impl/keystroke-injection';
import { sessionDirectMessageIdentity } from './session-direct-message-identity';

/**
 * 认领者声明「这条消息在任何字节到达 provider 之前就被拒了」(结构标记,❌ 不用 instanceof:会话页 bundle 与
 * 宿主 bundle 各自求值同一份源,类跨不过去)。这种拒绝不是「结果未知」——行该落 `failed` 收据并显形,
 * 而不是停在 `dispatching` 等一个永远不来的结果(#4896 就绪预算到点那一格)。
 */
function isDeliveryRejectedBeforeAdmission(error: unknown): boolean {
  return (error as { deliveryRejectedBeforeAdmission?: unknown } | null)?.deliveryRejectedBeforeAdmission === true;
}
import { events } from '@main/lib/events';
import { sessionDeliveryFailedChannel } from '@shared/core/sessions/sessionEvents';
import type { SessionMessageDelivery } from '@shared/core/sessions/sessions';

export interface SendSessionMessageParams {
  projectId: string;
  sessionId: string;
  clientMessageId: string;
  text: string;
  kind?: 'ordinary' | 'session-direct';
  /** Only session_spawn's first delegation may use the durable startup outbox exception. */
  queuedStartupDelegation?: boolean;
  /** session-direct only: the sender's `delivery: 'queue'` / `key` (ACP targets; callers refuse terminals first). */
  delivery?: SessionMessageDelivery;
  /** Local admission lifetime; never persisted or sent to the provider. */
  signal?: AbortSignal;
}

export type SendSessionMessageResult = {
  id: string;
  status: 'queued' | 'accepted' | 'outcome-unknown' | 'delivered';
};

/**
 * session-direct is a synchronous local handoff. A target blocked by platform recovery is left as one
 * durable pending row for the common inbox reader. A cold target is woken by the router the same way the
 * inbox wakes it (#6546); only a target that could not be woken or admitted is a caller-visible failure,
 * carrying the reason.
 */
export class SessionDirectDeliveryError extends Error {
  readonly code = 'SESSION_DIRECT_NOT_LIVE';
  readonly sessionId: string;

  constructor(sessionId: string, reason = 'target session is not live') {
    super(`[SESSION_DIRECT_NOT_LIVE] ${reason}: ${sessionId}`);
    this.name = 'SessionDirectDeliveryError';
    this.sessionId = sessionId;
  }
}

// Persistence and transport have different latency contracts. Enqueueing a message must return after
// its durable row is written; a slow adapter drain must not head-block later sends for the same
// conversation. Each lane is still serialized independently to preserve per-conversation ordering.
const enqueueOperations = new Map<string, Promise<void>>();
const drainOperations = new Map<string, Promise<void>>();
/**
 * 收据的四态。`dispatching` 与 `outcome-unknown` 曾经是同一个词，界面因此分不开「正在投」和
 * 「永远不知道了」，于是每条新建会话都要先闪一条「投递结果未知」——一条顺路走完的会话不该踩到兜底。
 *
 * - `queued`        还没投（等会话就绪 / 等排队）
 * - `dispatching`   已经投出去、本进程正在等回执；下一步必定改写成 accepted 或 queued
 * - `accepted`      对面收下了
 * - `outcome-unknown` 写下 dispatching 的那个进程没能等到回执就没了（崩溃/被杀），
 *                   启动时认领为终态：不能重投（可能重复投递），只能如实告诉用户
 */
type MessageReceiptState = 'queued' | 'dispatching' | 'accepted' | 'failed' | 'outcome-unknown';

function messageMetadata(
  kind: SendSessionMessageParams['kind'],
  state: MessageReceiptState,
  nativeReceiptId?: string,
): string {
  return JSON.stringify({
    kind: kind === 'session-direct' ? 'session-direct' : 'ordinary-message',
    state,
    ...(nativeReceiptId ? { nativeReceiptId } : {}),
  });
}

function parseMessageMetadata(raw: string | null): {
  kind: string;
  state: MessageReceiptState;
  nativeReceiptId?: string;
} | null {
  if (!raw) return null;
  // 认不得就回 null，由调用方各自决定 —— 投递路径当场抛，启动认领
  // 只跳过这一条并记一条 warn。❌ 让 JSON.parse 直接把异常抛到启动事务外面：一条坏行会把整个
  // 会话页的启动带走，而这是数据问题、不是代码问题。
  let value: { kind?: unknown; state?: unknown; nativeReceiptId?: unknown };
  try {
    value = JSON.parse(raw) as { kind?: unknown; state?: unknown; nativeReceiptId?: unknown };
  } catch {
    return null;
  }
  if (
    typeof value.kind !== 'string'
    || !['queued', 'dispatching', 'accepted', 'failed', 'outcome-unknown'].includes(String(value.state))
    || (value.nativeReceiptId !== undefined && typeof value.nativeReceiptId !== 'string')
  ) return null;
  return value as { kind: string; state: MessageReceiptState; nativeReceiptId?: string };
}

type AcceptedMessageReceipt = {
  id: string;
  sessionId: string;
  content: string;
  sender: string;
  metadata: string | null;
};

function serialize<T>(
  operations: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = operations.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tracked = current.then(() => undefined, () => undefined);
  operations.set(sessionId, tracked);
  void tracked.finally(() => {
    if (operations.get(sessionId) === tracked) operations.delete(sessionId);
  });
  return current;
}

async function readSession(params: {
  projectId: string;
  sessionId: string;
}) {
  const [row] = db
    .select()
    .from(sessions)
    .where(and(
      eq(sessions.id, params.sessionId),
      eq(sessions.projectId, params.projectId),
    ))
    .limit(1)
    .all();
  if (!row?.provider || !row.config) throw new Error('session not found');
  return { ...row, provider: row.provider, config: row.config };
}

function readAcceptedMessage(messageId: string): AcceptedMessageReceipt | undefined {
  return db
    .select({
      id: messages.id,
      sessionId: messages.sessionId,
      content: messages.content,
      sender: messages.sender,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
    .all()
    .find((receipt) => receipt.id === messageId);
}

function receiptState(
  receipt: AcceptedMessageReceipt,
  expected: { sessionId: string; id: string; text: string },
  kind: SendSessionMessageParams['kind'],
): MessageReceiptState {
  if (
    receipt.id !== expected.id
    || receipt.sessionId !== expected.sessionId
    || (kind === 'session-direct'
      ? sessionDirectMessageIdentity(receipt.content,expected.id) !== sessionDirectMessageIdentity(expected.text,expected.id)
      : receipt.content !== expected.text)
    || receipt.sender !== 'user'
  ) {
    throw new Error(`message receipt ${expected.id} conflicts with existing message bytes`);
  }
  const metadata = parseMessageMetadata(receipt.metadata);
  const expectedKind = JSON.parse(messageMetadata(kind, 'queued')) as { kind: string };
  if (metadata?.kind === expectedKind.kind) return metadata.state;
  throw new Error(`message receipt ${expected.id} has incompatible metadata`);
}

function persistDispatchState(
  params: { projectId: string; sessionId: string },
  pending: { id: string; text: string; kind?: SendSessionMessageParams['kind'] },
  state: 'queued' | 'dispatching',
): void {
  db.transaction((tx) => {
    const [row] = tx
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.id, params.sessionId),
        eq(sessions.projectId, params.projectId),
      ))
      .limit(1)
      .all();
    if (!row?.config) throw new Error('session not found');

    const nextConfig = state === 'dispatching'
      ? markSessionMessageDispatching(row.config, pending.id)
      : markSessionMessagePending(row.config, pending.id);
    const existing = tx
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        content: messages.content,
        sender: messages.sender,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(eq(messages.id, pending.id))
      .limit(1)
      .all()
      .find((receipt) => receipt.id === pending.id);
    if (existing) {
      receiptState(existing, {
        sessionId: params.sessionId,
        id: pending.id,
        text: pending.text,
      }, pending.kind);
      tx.update(messages)
        .set({ metadata: messageMetadata(pending.kind, state) })
        .where(eq(messages.id, pending.id))
        .run();
    } else {
      tx.insert(messages).values({
        id: pending.id,
        sessionId: params.sessionId,
        content: pending.text,
        sender: 'user',
        timestamp: new Date().toISOString().replace('T', ' ').replace('Z', ''),
        metadata: messageMetadata(pending.kind, state),
      }).run();
    }
    tx.update(sessions)
      .set({ config: nextConfig })
      .where(and(
        eq(sessions.id, params.sessionId),
        eq(sessions.projectId, params.projectId),
      ))
      .run();
  });
}

function persistAcceptedMessage(
  params: { projectId: string; sessionId: string },
  pending: { id: string; text: string; kind?: SendSessionMessageParams['kind'] },
  receipt: { messageId: string; nativeReceiptId?: string },
): void {
  db.transaction((tx) => {
    const [row] = tx
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.id, params.sessionId),
        eq(sessions.projectId, params.projectId),
      ))
      .limit(1)
      .all();
    if (!row?.config) throw new Error('session not found');
    // The inbox reader accepts a projected local row that is still pending. Promote that row
    // inside this transaction so the shared state helper keeps its dispatching guard.
    const current = row.config.messageOutbox?.find((message) => message.id === pending.id);
    const acceptanceConfig = current?.kind === 'session-direct' && current.state === 'pending'
      ? markSessionMessageDispatching(row.config, pending.id)
      : row.config;
    const acceptedConfig = acceptSessionMessage(acceptanceConfig, pending, receipt.messageId);
    const existing = tx
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        content: messages.content,
        sender: messages.sender,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(eq(messages.id, pending.id))
      .limit(1)
      .all()
      .find((receipt) => receipt.id === pending.id);
    if (!existing) throw new Error(`outbox ${pending.id} has no durable receipt row`);
    receiptState(existing, {
      sessionId: params.sessionId,
      id: pending.id,
      text: pending.text,
    }, pending.kind);
    tx.update(messages)
      .set({ metadata: messageMetadata(pending.kind, 'accepted', receipt.nativeReceiptId) })
      .where(eq(messages.id, pending.id))
      .run();
    tx.update(sessions)
      .set({ config: acceptedConfig })
      .where(and(
        eq(sessions.id, params.sessionId),
        eq(sessions.projectId, params.projectId),
      ))
      .run();
  });
  if (pending.kind === 'session-direct') {
    taskExchangeRecorded(params.sessionId);
    recordDeliveryActivity(params.sessionId, pending);
  }
}

function persistFailedMessage(
  params: { projectId: string; sessionId: string },
  pending: { id: string; text: string; kind?: SendSessionMessageParams['kind'] },
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  db.transaction((tx) => {
    const [row] = tx
      .select()
      .from(sessions)
      .where(and(
        eq(sessions.id, params.sessionId),
        eq(sessions.projectId, params.projectId),
      ))
      .limit(1)
      .all();
    if (!row?.config) throw new Error('session not found');
    const existing = tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, pending.id))
      .limit(1)
      .all()
      .find((receipt) => receipt.id === pending.id);
    if (!existing) {
      tx.insert(messages).values({
        id: pending.id,
        sessionId: params.sessionId,
        content: pending.text,
        sender: 'user',
        metadata: messageMetadata(pending.kind, 'failed'),
      }).run();
    } else {
      tx.update(messages)
        .set({ metadata: messageMetadata(pending.kind, 'failed') })
        .where(eq(messages.id, pending.id))
        .run();
    }
    tx.update(sessions)
      .set({ config: failSessionMessage(row.config, pending.id) })
      .where(and(
        eq(sessions.id, params.sessionId),
        eq(sessions.projectId, params.projectId),
      ))
      .run();
  });
  events.emit(sessionDeliveryFailedChannel, {
    sessionId: params.sessionId,
    projectId: params.projectId,
    messageId: pending.id,
    message,
  });
}

/** Record a successfully injected direct message in the recipient timeline, never in its outbox. */
function persistDeliveredSessionDirect(
  params: { sessionId: string },
  message: { id: string; text: string },
  nativeReceiptId?: string,
): void {
  db.transaction((tx) => {
    tx.insert(messages).values({
      id: message.id,
      sessionId: params.sessionId,
      content: message.text,
      sender: 'user',
      timestamp: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      metadata: messageMetadata('session-direct', 'accepted', nativeReceiptId),
    }).run();
  });
  taskExchangeRecorded(params.sessionId);
  recordDeliveryActivity(params.sessionId, message);
}

function recordDeliveryActivity(sessionId: string, message: { id: string; text: string }): void {
  const facts = readDeliveryEnvelope(message.text)?.segments[0]?.facts;
  const source = facts?.sourceLink ? parseConversationLink(facts.sourceLink) : null;
  activitySignal({ event_id: `session.message_delivered:${message.id}`, kind: 'session.message_delivered',
    session_id: sessionId, object_id: message.id, occurred_at: Date.now(),
    ...(facts?.fromId?.startsWith('session:') ? { related_session_id: facts.fromId.slice('session:'.length) } : {}),
    ...(source ? { source_ref: conversationLink(source.chatId, source.messageId) } : {}) });
}

/** Record a startup prompt that was delivered by the provider's native spawn transport. */
export function recordDeliveredSessionDirectMessage(
  params: { sessionId: string },
  message: { id: string; text: string },
): void {
  persistDeliveredSessionDirect(params, message);
}

/** Record a provider-owned startup prompt that was admitted to the conversation but failed its turn receipt. */
export function recordFailedSessionDirectMessage(
  params: { projectId: string; sessionId: string },
  message: { id: string; text: string },
  error: unknown,
): void {
  persistFailedMessage(params, { ...message, kind: 'session-direct' }, error);
}

/** Keep a gate-rejected session-direct message in the recipient's existing inbox projection. */
async function enqueuePendingSessionDirectMessage(
  params: { projectId: string; sessionId: string; clientMessageId: string },
  text: string,
): Promise<void> {
  await serialize(enqueueOperations, params.sessionId, async () => {
    const row = await readSession(params)
    const pending = { id: params.clientMessageId, text, kind: 'session-direct' as const }
    const existing = readAcceptedMessage(params.clientMessageId)
    if (existing) {
      const state = receiptState(existing, {
        sessionId: params.sessionId,
        id: params.clientMessageId,
        text,
      }, 'session-direct')
      if (state !== 'queued') return
    }
    const enqueue = enqueueSessionMessage(row.config, pending)
    if (enqueue.config === row.config) return
    db.transaction((tx) => {
      tx.insert(messages).values({
        id: pending.id,
        sessionId: params.sessionId,
        content: pending.text,
        sender: 'user',
        metadata: messageMetadata('session-direct', 'queued'),
        timestamp: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      }).run()
      tx.update(sessions)
        .set({ config: enqueue.config })
        .where(and(
          eq(sessions.id, params.sessionId),
          eq(sessions.projectId, params.projectId),
        ))
        .run()
    })
  })
}

async function drain(params: {
  projectId: string;
  sessionId: string;
}): Promise<void> {
  for (;;) {
    const row = await readSession(params);
    const pending = nextPendingSessionMessage(
      row.config,
      (message) => message.kind !== 'session-direct',
    );
    if (!pending) return;

    const transportMessage = {
      id: pending.id,
      text: pending.text,
      ...(pending.kind === undefined ? {} : { kind: pending.kind }),
    };

    let receipt:
      | { status: 'not-ready' }
      | { status: 'accepted'; messageId: string; nativeReceiptId?: string };
    try {
      const surface = row.runtime === 'acp' ? 'acp' : 'tui';
      const integration = resolveSessionpageSessionIntegration(row.provider, surface);
      if (integration.messageTransport === 'none') {
        throw new Error(
          `session ${params.sessionId} does not declare a session message transport`,
        );
      }
      if (integration.messageTransport === 'router') {
        const router = getSessionMessageRouter();
        if (!router) {
          persistDispatchState(params, pending, 'queued');
          return;
        }
        // Legacy/session_spawn session-direct rows remain durable until the declared router accepts them.
        persistDispatchState(params, pending, 'dispatching');
        receipt = await router(params.sessionId, transportMessage);
      } else {
        const session = resolveSession(params.projectId, params.sessionId);
        if (!session) {
          persistDispatchState(params, pending, 'queued');
          return;
        }
        const accept = session.sessions.sendMessage;
        if (!accept) {
          throw new Error(`session ${params.sessionId} has no local-session message adapter`);
        }
        persistDispatchState(params, pending, 'dispatching');
        receipt = await accept.call(
          session.sessions,
          mapSessionRowToSession(row),
          transportMessage,
        );
      }
      if (receipt.status === 'not-ready') {
        persistDispatchState(params, pending, 'queued');
        return;
      }
      persistAcceptedMessage(params, pending, receipt);
    } catch (error) {
      // 只有「provider 一个字节都没收到」的拒绝才能落 failed;别的抛出仍是结果未知,行保持 dispatching。
      if (!isNoLocalMessageEncodingError(error) && !isDeliveryRejectedBeforeAdmission(error)) throw error;
      persistFailedMessage(params, pending, error);
      return;
    }
  }
}

/**
 * Persist one typed message, then let the declared local transport drain when it is ready.
 *
 * Ordinary `session-direct` is admitted synchronously (a cold target is woken first); a gate rejection leaves one durable
 * recipient outbox row for the common inbox reader. Startup delegation and ordinary messages
 * retain the existing durable outbox behavior.
 */
const directAdmissions = new Map<string, { signature: string; flight: Promise<SendSessionMessageResult> }>();
export async function sendMessage(params: SendSessionMessageParams): Promise<SendSessionMessageResult> {
  params.signal?.throwIfAborted();
  if (params.kind !== 'session-direct' || params.queuedStartupDelegation) return sendMessageOnce(params);
  const key = params.clientMessageId.trim();
  const signature = JSON.stringify([params.projectId, params.sessionId, sessionDirectMessageIdentity(params.text.trim(),key), params.delivery ?? null]);
  const existing = directAdmissions.get(key);
  if (existing) {
    if (existing.signature !== signature) throw new Error('message identity reused with different delivery content');
    return existing.flight;
  }
  const flight = sendMessageOnce(params);
  const admission = { signature, flight };
  directAdmissions.set(key, admission);
  const clean = () => { if (directAdmissions.get(key) === admission) directAdmissions.delete(key); };
  void flight.then(clean, clean);
  return flight;
}

async function sendMessageOnce(
  params: SendSessionMessageParams,
): Promise<SendSessionMessageResult> {
  const text = params.text.trim();
  const clientMessageId = params.clientMessageId.trim();
  if (!text) throw new Error('message text is required');
  if (!clientMessageId) throw new Error('clientMessageId is required');

  // Ordinary session-direct calls are a live handoff, except that a recovery gate may preserve the
  // exact message in the existing outbox until the coordinator's retry kicks the common reader.
  if (params.kind === 'session-direct' && !params.queuedStartupDelegation) {
    const row = await readSession(params);
    const surface = row.runtime === 'acp' ? 'acp' : 'tui';
    const integration = resolveSessionpageSessionIntegration(row.provider, surface);
    if (integration.messageTransport === 'none') {
      throw new Error(
        `session ${params.sessionId} does not declare a session message transport`,
      );
    }

    const existing = readAcceptedMessage(clientMessageId);
    if (existing) {
      const persistedState = receiptState(existing, {
        sessionId: params.sessionId,
        id: clientMessageId,
        text,
      }, params.kind);
      if (persistedState === 'accepted') return { id: clientMessageId, status: 'delivered' };
      if (persistedState === 'dispatching') return { id: clientMessageId, status: 'outcome-unknown' };
      if (persistedState === 'queued') {
        throw new SessionDirectDeliveryError(params.sessionId, 'message already has a durable pending receipt');
      }
      if (persistedState === 'failed') {
        throw new Error(`message ${clientMessageId} previously failed delivery`);
      }
      return { id: clientMessageId, status: persistedState };
    }

    const router = getSessionMessageRouter();
    if (!router) {
      throw new SessionDirectDeliveryError(params.sessionId, 'no session message router is installed');
    }
    params.signal?.throwIfAborted();
    const receipt = await router(params.sessionId, {
      id: clientMessageId,
      text,
      kind: 'session-direct',
      ...(params.delivery ? { delivery: params.delivery } : {}),
    }, params.signal);
    if (receipt.status === 'not-ready') {
      // The outbox keeps text only: a kept message with `delivery` would later go out the default way — into the
      // current turn, its key lost. So it is not kept; the sender is told now and sends it again.
      if (receipt.preserve && params.delivery) {
        throw new SessionDirectDeliveryError(
          params.sessionId,
          `${receipt.reason ?? 'the session is not ready'}; a message sent with delivery "queue" is not kept for later — send it again`,
        );
      }
      // 留下了就当场说清:原因 + 已留下、别重发(发信方照「not live」重发,恢复后收件方会收到两遍)。
      if (receipt.preserve) {
        await enqueuePendingSessionDirectMessage(params, text);
        throw new SessionDirectDeliveryError(
          params.sessionId,
          `${receipt.reason ?? 'the session is not ready'}; the message is kept and goes out when it recovers — do not send it again`,
        );
      }
      throw new SessionDirectDeliveryError(params.sessionId, receipt.reason);
    }
    if (receipt.messageId !== clientMessageId) {
      throw new Error(
        `session message acceptance id ${receipt.messageId} does not match ${clientMessageId} for ${params.sessionId}`,
      );
    }
    persistDeliveredSessionDirect(
      { sessionId: params.sessionId },
      { id: clientMessageId, text },
      receipt.nativeReceiptId,
    );
    return { id: clientMessageId, status: 'delivered' };
  }

  const status = await serialize(enqueueOperations, params.sessionId, async (): Promise<SendSessionMessageResult['status']> => {
    const row = await readSession(params);
    const surface = row.runtime === 'acp' ? 'acp' : 'tui';
    const integration = resolveSessionpageSessionIntegration(row.provider, surface);
    if (integration.messageTransport === 'none') {
      recordLocalSessionDeliveryFailureForTest({
        sessionId: params.sessionId,
        providerId: row.provider,
        messageId: clientMessageId,
        text,
        error: `session ${params.sessionId} does not declare a session message transport`,
      });
      throw new Error(
        `session ${params.sessionId} does not declare a session message transport`,
      );
    }
    const accepted = readAcceptedMessage(clientMessageId);
    if (accepted) {
      const persistedState = receiptState(accepted, {
        sessionId: params.sessionId,
        id: clientMessageId,
        text,
      }, params.kind);
      // 收据是 `dispatching` = 同一条消息此刻正在投递中。对**这次调用**来说结果确实还不知道，
      // 所以照旧回 outcome-unknown（调用方的处置不变）。库里留的仍是 dispatching —— 界面靠这个
      // 区别才不会把「正在投」画成「永远不知道了」。
      if (persistedState === 'failed') throw new Error(`message ${clientMessageId} previously failed delivery`);
      return persistedState === 'dispatching' ? 'outcome-unknown' : persistedState;
    }
    const pending = {
      id: clientMessageId,
      text,
      kind: params.kind ?? 'ordinary',
    };
    const enqueue = enqueueSessionMessage(row.config, pending);
    if (enqueue.config === row.config) return enqueue.status;

    db.transaction((tx) => {
      tx.insert(messages).values({
        id: clientMessageId,
        sessionId: params.sessionId,
        content: text,
        sender: 'user',
        metadata: messageMetadata(params.kind, 'queued'),
      }).run();
      tx.update(sessions)
        .set({ config: enqueue.config })
        .where(and(
          eq(sessions.id, params.sessionId),
          eq(sessions.projectId, params.projectId),
        ))
        .run();
    });
    return enqueue.status;
  });

  if (status === 'queued') {
    void drainSessionMessageOutbox(params).catch((error) => {
      try {
        persistFailedMessage(
          params,
          { id: clientMessageId, text, kind: params.kind ?? 'ordinary' },
          error,
        );
      } catch (settlementError) {
        log.error('session message drain failure could not be settled', {
          sessionId: params.sessionId,
          messageId: clientMessageId,
          error: settlementError instanceof Error ? settlementError.message : String(settlementError),
        });
      }
    });
  }
  return { id: clientMessageId, status };
}

/** Project the pending local session-direct outbox into the host inbox reader. */
export function listPendingSessionDirectMessages(sessionId: string): Array<{
  id: string;
  text: string;
  seq: number;
}> {
  const [row] = db.select({ config: sessions.config }).from(sessions)
    .where(eq(sessions.id, sessionId)).limit(1).all();
  return (row?.config?.messageOutbox ?? [])
    .filter((message) => message.kind === 'session-direct' && message.state !== 'dispatching')
    .map((message, index) => ({ id: message.id, text: message.text, seq: index + 1 }));
}

/** Accept one projected session-direct row after the common reader accepts its provider input. */
export function acceptPendingSessionDirectMessage(sessionId: string, messageId: string): void {
  const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
  const pending = row?.config?.messageOutbox?.find((message) => message.id === messageId);
  if (!row || !row.config || !pending || pending.kind !== 'session-direct') {
    throw new Error(`pending session-direct message ${messageId} not found for ${sessionId}`);
  }
  persistAcceptedMessage(
    { projectId: row.projectId, sessionId },
    pending,
    { messageId },
  );
}

/** Replay persisted pending rows after runtime startup or restart. */
export function drainSessionMessageOutbox(params: {
  projectId: string;
  sessionId: string;
}): Promise<void> {
  return serialize(drainOperations, params.sessionId, () => drain(params));
}

/**
 * 按会话 id 排它的 outbox（project / task 从行上取）。
 *
 * 为什么需要它：一条会话真正**能收**的那一刻是「投递属主注册好了」，而那一刻宿主手上只有
 * conversationId。以前那里只踢收件箱 pull，可 pull 的本机投影只捞 `session-direct` 行 ——
 * 用户在新建任务里打的第一句话是 `ordinary`，结构上就看不见。
 *
 * codex 的全新会话把这个缺口放大成死锁：它的 startSession 要等首轮投递到达才返回，而原本
 * 负责投递首轮的 nudge + drain 排在 startSession **之后**（session-orchestration）——
 * 于是双方互等，90 秒后超时（实测 outbox 里那条 `{kind:"ordinary",state:"pending"}` 一直没动）。
 */
export async function drainSessionMessageOutboxById(sessionId: string): Promise<void> {
  // 取整行（与同文件 acceptPendingSessionDirectMessage 一致）：drain 要 project/task 两个键。
  const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
  // ❌ 不静默 return：查不到会话说明调用方拿着一个不存在的 id，那是要修的 bug，不是空活。
  if (!row) throw new Error(`session ${sessionId} not found for outbox drain`);
  await drainSessionMessageOutbox({
    projectId: row.projectId,
    sessionId,
  });
}

/** Sweep every persisted pending conversation through the same adapter path used by direct sends. */
export async function drainAllSessionMessageOutboxes(): Promise<void> {
  const rows = db
    .select({
      id: sessions.id,
      projectId: sessions.projectId,
      config: sessions.config,
    })
    .from(sessions)
    .all();
  const targets = rows.filter((row) => row.config && nextPendingSessionMessage(row.config));
  await Promise.all(targets.map((row) => drainSessionMessageOutbox({
    projectId: row.projectId,
    sessionId: row.id,
  })));
}

setSessionMessageOutboxDrain(() => drainAllSessionMessageOutboxes());

/**
 * 启动认领：上一个进程写下 `dispatching` 之后没能等到回执就没了（崩溃 / 被杀），对面到底收没收到，
 * 现在谁也不知道了。**只有这一刻**才把它改写成终态 `outcome-unknown` —— 这条消息不能重投（可能变成
 * 重复投递），只能如实告诉用户。
 *
 * 正常在途根本不经过这里，所以一条顺路走完的会话不会踩到「投递结果未知」那块提示。这两件事以前共用
 * 同一个词，界面分不开，于是每建一条会话都要先闪一次兜底 —— 而走到兜底本身就代表出错了。
 *
 * ❌ 顺手把 outbox 里那条也清掉：`nextPendingSessionMessage` 正是靠 `dispatching` 跳过它，
 * 清掉就等于允许重投。
 */
export function claimInterruptedDispatches(): number {
  const rows = db
    .select({ id: sessions.id, config: sessions.config })
    .from(sessions)
    .all();
  const interrupted = rows.flatMap((row) =>
    (row.config?.messageOutbox ?? [])
      .filter((message) => message.state === 'dispatching')
      .map((message) => message.id),
  );
  if (interrupted.length === 0) return 0;

  let claimed = 0;
  db.transaction((tx) => {
    for (const messageId of interrupted) {
      const [receipt] = tx
        .select({ id: messages.id, metadata: messages.metadata })
        .from(messages)
        .where(eq(messages.id, messageId))
        .limit(1)
        .all();
      const parsed = receipt ? parseMessageMetadata(receipt.metadata) : null;
      if (!parsed) {
        log.warn('interrupted dispatch has no readable receipt — left as is', { messageId });
        continue;
      }
      if (parsed.state !== 'dispatching') continue;
      tx.update(messages)
        .set({ metadata: JSON.stringify({ ...parsed, state: 'outcome-unknown' }) })
        .where(eq(messages.id, messageId))
        .run();
      claimed += 1;
    }
  });
  if (claimed > 0) {
    log.warn('claimed interrupted message dispatches as outcome-unknown', { count: claimed });
  }
  return claimed;
}
