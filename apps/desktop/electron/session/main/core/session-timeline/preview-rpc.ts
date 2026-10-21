import type { DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol';
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder';
import { SUBSCRIPTION_IDLE_MS } from '@gugu/session-core/session-record';
import {
  MESSAGE_PREVIEW_RPC,
  messagePreviewTopic,
  projectMessagePreview,
  type MessagePreviewPayload,
  type MessagePreviewProjection,
} from '@gugu/session-core/session-record/message-preview';
import { randomUUID } from 'node:crypto';
import * as service from './service';

/**
 * MessagePreview(#6357)宿主侧。请求由库中转(发起人不是 owner),只接受三个只读动词;
 * 复用时间线服务的订阅当变化触发器,把投影推到 `gugu:preview:{chat}:{agent}`。
 * 同一 topic 多人看共用一份订阅,每人一张租约;没有租约就整份拆掉。
 */

export type MessagePreviewPublisher = {
  send: (payload: MessagePreviewPayload) => unknown;
  close: () => void;
};

export type MessagePreviewHostDeps = {
  resolveSessionId: (agentId: string) => Promise<string | null> | string | null;
  openPublisher: (topic: string) => MessagePreviewPublisher;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  now?: () => number;
  idleMs?: number;
  throttleMs?: number;
  turnLimit?: number;
};

/** 一条会话的预览投影:推给 working 栏的、session_children / session_get 行上带的,是同一份。 */
export async function readSessionPreview(
  sessionId: string,
  turnLimit = 4,
): Promise<service.SessionTimelineResult<MessagePreviewProjection>> {
  const snapshot = await service.snapshot({ conversationId: sessionId, limit: turnLimit });
  return snapshot.ok ? { ok: true, value: projectMessagePreview(snapshot.value.turns) } : snapshot;
}

/** 请求来自别人,同时开着的预览必须有上限。 */
export const MESSAGE_PREVIEW_MAX_WATCHES = 32;
export const MESSAGE_PREVIEW_THROTTLE_MS = 1_000;

type Watch = {
  topic: string;
  chatId: string;
  agentId: string;
  sessionId: string;
  serviceSubscriptionId: string;
  leases: Map<string, number>;
  publisher: MessagePreviewPublisher;
  rev: number;
  lastWire: string | null;
  lastPublishedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  dirty: boolean;
  force: boolean;
  closed: boolean;
};

type PreviewRequest = { chatId: string; agentId: string; subscriptionId: string };

function readRequest(payload: unknown): PreviewRequest | null {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const str = (key: string) => (typeof body[key] === 'string' && (body[key] as string).trim() ? (body[key] as string).trim() : null);
  const chatId = str('chatId');
  const agentId = str('agentId');
  const subscriptionId = str('subscriptionId');
  if (!chatId || !agentId || !subscriptionId) return null;
  return { chatId, agentId, subscriptionId };
}

const rpcError = (code: string, message: string): DeviceRpcResponse<never> => ({ error: { code, message } });

export function createMessagePreviewHost(deps: MessagePreviewHostDeps): {
  handlers: DeviceRpcHandlers;
  sweep: () => string[];
  dispose: () => void;
  watchCount: () => number;
} {
  const now = deps.now ?? (() => Date.now());
  const idleMs = deps.idleMs ?? SUBSCRIPTION_IDLE_MS;
  const throttleMs = deps.throttleMs ?? MESSAGE_PREVIEW_THROTTLE_MS;
  const warn = deps.warn ?? (() => undefined);
  const epoch = randomUUID();
  const watches = new Map<string, Watch>();
  let disposed = false;

  const teardown = (watch: Watch) => {
    if (watch.closed) return;
    watch.closed = true;
    watches.delete(watch.topic);
    if (watch.timer) clearTimeout(watch.timer);
    service.unsubscribe(watch.serviceSubscriptionId);
    try {
      watch.publisher.close();
    } catch (error) {
      warn('messagePreview: publisher close failed', { topic: watch.topic, error: String(error) });
    }
  };

  const publish = async (watch: Watch) => {
    if (watch.closed) return;
    watch.inFlight = true;
    watch.dirty = false;
    const force = watch.force;
    watch.force = false;
    try {
      const read = await readSessionPreview(watch.sessionId, deps.turnLimit);
      if (watch.closed) return;
      if (!read.ok) {
        warn('messagePreview: snapshot failed', { topic: watch.topic, error: read.error });
        return;
      }
      const projection = read.value;
      const wire = JSON.stringify(projection);
      if (wire === watch.lastWire && !force) return;
      watch.lastWire = wire;
      watch.rev += 1;
      watch.lastPublishedAt = now();
      await watch.publisher.send({ ...projection, chatId: watch.chatId, agentId: watch.agentId, rev: watch.rev, epoch, at: watch.lastPublishedAt });
    } catch (error) {
      warn('messagePreview: publish failed', { topic: watch.topic, error: String(error) });
    } finally {
      watch.inFlight = false;
      if (watch.dirty || watch.force) schedule(watch);
    }
  };

  /** 节流合并:一个间隔内的多次变化只推最后一份。force = 内容没变也推(给新来的人)。 */
  const schedule = (watch: Watch, force = false) => {
    if (watch.closed) return;
    watch.dirty = true;
    if (force) watch.force = true;
    if (watch.inFlight || watch.timer) return;
    watch.timer = setTimeout(() => {
      watch.timer = null;
      void publish(watch);
    }, Math.max(0, watch.lastPublishedAt + throttleMs - now()));
    watch.timer.unref?.();
  };

  const subscribe = async (request: PreviewRequest): Promise<DeviceRpcResponse<{ topic: string }>> => {
    if (disposed) return rpcError('host_disposed', '这条设备频道已经拆了');
    const topic = messagePreviewTopic(request.chatId, request.agentId);
    const existing = watches.get(topic);
    if (existing) {
      const isNewLease = !existing.leases.has(request.subscriptionId);
      existing.leases.set(request.subscriptionId, now());
      if (isNewLease) schedule(existing, true);
      return { result: { topic } };
    }
    if (watches.size >= MESSAGE_PREVIEW_MAX_WATCHES) {
      return rpcError('too_many_previews', `这台机器同时最多开 ${MESSAGE_PREVIEW_MAX_WATCHES} 份预览`);
    }
    const sessionId = await deps.resolveSessionId(request.agentId);
    if (disposed) return rpcError('host_disposed', '这条设备频道已经拆了');
    if (!sessionId) return rpcError('agent_not_hosted', `agent ${request.agentId} 的任务会话不在这台机器上`);
    if (watches.has(topic)) return subscribe(request);

    const watch: Watch = {
      topic,
      chatId: request.chatId,
      agentId: request.agentId,
      sessionId,
      // 每份一个独立 id:同一 topic 关了又开时,晚到的旧订阅顶不掉新的那份。
      serviceSubscriptionId: `preview:${topic}:${randomUUID()}`,
      leases: new Map([[request.subscriptionId, now()]]),
      publisher: deps.openPublisher(topic),
      rev: 0,
      lastWire: null,
      lastPublishedAt: 0,
      timer: null,
      inFlight: false,
      dirty: false,
      force: false,
      closed: false,
    };
    watches.set(topic, watch);
    const subscribed = await service.subscribe(
      { conversationId: sessionId, subscriptionId: watch.serviceSubscriptionId, cursor: null },
      () => schedule(watch)
    );
    if (!subscribed.ok) {
      teardown(watch);
      return { error: subscribed.error };
    }
    // 订阅在飞时这份已被退订/清扫/整体拆掉:那时 teardown 撤了个还没登记的 id,这里补撤。
    if (watch.closed || disposed) {
      service.unsubscribe(watch.serviceSubscriptionId);
      teardown(watch);
      return rpcError('preview_closed', '订阅完成前这份预览已经关了');
    }
    schedule(watch, true);
    return { result: { topic } };
  };

  const withRequest =
    (run: (request: PreviewRequest) => Promise<DeviceRpcResponse<{ topic: string }>>) => async (payload: unknown) => {
      const request = readRequest(payload);
      return request ? run(request) : rpcError('invalid_payload', 'chatId / agentId / subscriptionId 都是必填的');
    };

  const handlers: DeviceRpcHandlers = {
    [MESSAGE_PREVIEW_RPC.subscribe]: withRequest(subscribe),
    // 保活与订阅同形:宿主重启后手里没有这份时,保活就地重建。
    [MESSAGE_PREVIEW_RPC.keepalive]: withRequest(subscribe),
    [MESSAGE_PREVIEW_RPC.unsubscribe]: withRequest(async (request) => {
      const topic = messagePreviewTopic(request.chatId, request.agentId);
      const watch = watches.get(topic);
      watch?.leases.delete(request.subscriptionId);
      if (watch && watch.leases.size === 0) teardown(watch);
      return { result: { topic } };
    }),
  };

  const sweep = (): string[] => {
    const cutoff = now() - idleMs;
    const dropped: string[] = [];
    for (const watch of [...watches.values()]) {
      for (const [lease, at] of [...watch.leases]) {
        if (at > cutoff) continue;
        watch.leases.delete(lease);
        dropped.push(lease);
      }
      if (watch.leases.size === 0) teardown(watch);
    }
    return dropped;
  };

  return {
    handlers,
    sweep,
    watchCount: () => watches.size,
    dispose: () => {
      disposed = true;
      for (const watch of [...watches.values()]) teardown(watch);
    },
  };
}
