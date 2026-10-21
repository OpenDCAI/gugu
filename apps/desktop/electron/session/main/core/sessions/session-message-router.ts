import type { SessionMessage, SessionMessageDelivery } from '@shared/core/sessions/sessions';
import { migrateStrandedLifecycleOutbox } from './migrate-lifecycle-outbox';

/**
 * 一条消息一个注入口。一段连续的 session-direct 在 drain 里先并成**一条**标准消息,再从这里进去 ——
 * ❌ 没有 `messages[]` 旁路:那会让每个 adapter 各写一份 merge,而重复的 merge 已经漂过一次。
 */
export type SessionMessageRouter = (
  sessionId: string,
  message: SessionMessage & { delivery?: SessionMessageDelivery },
) => Promise<
  | { status: 'not-ready'; preserve?: boolean; reason?: string }
  | { status: 'accepted'; messageId: string; nativeReceiptId?: string }
>;

let router: SessionMessageRouter | null = null;
let outboxDrain: (() => Promise<void>) | null = null;
let outboxReady = false;
let sessionLive: ((sessionId: string) => void) | null = null;

export function setSessionMessageRouter(next: SessionMessageRouter | null): void {
  router = next;
}

export function setSessionMessageOutboxDrain(handler: (() => Promise<void>) | null): void {
  outboxDrain = handler;
}

/**
 * Open the outbox only after the task database has completed its bundled migrations.
 * 开门即已迁完:还留着退役 lifecycle 条目的会话,config 读回来是 null,所以这一迁在门里做,排在第一次 drain 之前。
 */
export async function setSessionMessageOutboxReady(ready = true): Promise<void> {
  if (!ready) {
    outboxReady = false;
    return;
  }
  if (outboxReady) return;
  if (!router || !outboxDrain) throw new Error('session message outbox cannot open before router and drain are installed');
  migrateStrandedLifecycleOutbox();
  outboxReady = true;
  await outboxDrain();
}

/** 宿主的「这条会话可投递了」:ACP 腿在运行时登记好这条会话(启动成功)的那一刻叫它。 */
export function setSessionLiveNotifier(handler: ((sessionId: string) => void) | null): void {
  sessionLive = handler;
}

export function notifySessionLive(sessionId: string): void {
  sessionLive?.(sessionId)
}

export function getSessionMessageRouter(): SessionMessageRouter | null {
  return router;
}
